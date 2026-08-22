const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');

const LoyaltyAccount = require('../models/LoyaltyAccount');
const LoyaltyTransaction = require('../models/LoyaltyTransaction');
const LoyaltyReward = require('../models/LoyaltyReward');
const LoyaltyRedemption = require('../models/LoyaltyRedemption');
const LoyaltyTier = require('../models/LoyaltyTier');
const LoyaltyChallenge = require('../models/LoyaltyChallenge');
const LoyaltyChallengeProgress = require('../models/LoyaltyChallengeProgress');
const LoyaltyReferral = require('../models/LoyaltyReferral');

const { getOrCreateAccount } = require('../utils/loyaltyEngine');
const { getActiveTiers } = require('../utils/loyaltyTierEngine');
const { redeemReward, previewRedemptionDiscount } = require('../utils/loyaltyRedemption');
const { claimChallenge } = require('../utils/loyaltyChallengeEngine');
const { applyReferralCode } = require('../utils/loyaltyReferral');

// Every route here needs an authenticated customer/admin - loyalty balances
// are always resolved from req.user, never a mobile passed by the client.
router.use(protect);

const errorResponse = (res, error, fallbackStatus = 500) => {
  const codeToStatus = {
    LOYALTY_ACCOUNT_NOT_FOUND: 404,
    INSUFFICIENT_POINTS: 400,
    REWARD_NOT_FOUND: 404,
    REWARD_INACTIVE: 400,
    REWARD_EXPIRED: 400,
    REWARD_LIMIT_REACHED: 400,
    USER_REDEMPTION_LIMIT_REACHED: 400,
    REFERRAL_INVALID: 400,
    CHALLENGE_EXPIRED: 400,
    CHALLENGE_ALREADY_CLAIMED: 400,
    LOYALTY_ACCOUNT_SUSPENDED: 403,
    DUPLICATE_TRANSACTION: 409
  };
  const status = codeToStatus[error.code] || fallbackStatus;
  return res.status(status).json({
    success: false,
    error: { code: error.code || 'INTERNAL_ERROR', message: error.message || 'Something went wrong' }
  });
};

// @route   GET /api/v1/loyalty
// @desc    Loyalty dashboard - balance, tier, rewards/challenges preview, referral, recent activity
router.get('/', async (req, res) => {
  try {
    const account = await getOrCreateAccount(req.user);
    if (account.status === 'SUSPENDED') {
      return errorResponse(res, { code: 'LOYALTY_ACCOUNT_SUSPENDED', message: 'Your loyalty account is suspended' });
    }

    const tiers = await getActiveTiers();
    const currentTier = tiers.find((t) => t.code === account.currentTierCode) || null;

    const [rewards, activeChallenges, myProgress, recentTransactions] = await Promise.all([
      LoyaltyReward.find({ status: 'ACTIVE' }).sort({ pointsRequired: 1 }).limit(6),
      LoyaltyChallenge.find({ status: 'ACTIVE', validUntil: { $gte: new Date() } }).limit(5),
      LoyaltyChallengeProgress.find({ mobile: req.user.mobile }),
      LoyaltyTransaction.find({ mobile: req.user.mobile }).sort({ createdAt: -1 }).limit(5)
    ]);

    const progressMap = new Map(myProgress.map((p) => [String(p.challengeId), p]));

    res.status(200).json({
      success: true,
      data: {
        points: { available: account.availablePoints, pending: account.pendingPoints },
        tier: currentTier ? {
          code: currentTier.code,
          name: currentTier.name,
          multiplier: currentTier.pointMultiplier,
          currentSpend: account.tierProgress.currentSpend,
          nextTier: account.tierProgress.nextTierCode,
          nextTierSpend: account.tierProgress.nextTierSpend,
          progress: account.tierProgress.percentage
        } : null,
        rewards,
        challenges: activeChallenges.map((c) => ({
          ...c.toObject(),
          progress: progressMap.get(String(c._id)) || null
        })),
        referral: {
          code: account.referralCode,
          successfulReferrals: null, // computed on demand at GET /referral, kept off the dashboard for latency
          earnedPoints: null
        },
        recentTransactions
      }
    });
  } catch (error) {
    console.error('Loyalty dashboard error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load loyalty dashboard' } });
  }
});

// @route   GET /api/v1/loyalty/balance
router.get('/balance', async (req, res) => {
  try {
    const account = await getOrCreateAccount(req.user);
    res.status(200).json({ success: true, data: { availablePoints: account.availablePoints, pendingPoints: account.pendingPoints } });
  } catch (error) {
    console.error('Loyalty balance error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load balance' } });
  }
});

// @route   GET /api/v1/loyalty/transactions?page=&limit=&type=
router.get('/transactions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const query = { mobile: req.user.mobile };
    if (req.query.type && req.query.type !== 'ALL') query.type = req.query.type;

    const [data, total] = await Promise.all([
      LoyaltyTransaction.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      LoyaltyTransaction.countDocuments(query)
    ]);

    res.status(200).json({
      success: true,
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasNext: page * limit < total }
    });
  } catch (error) {
    console.error('Loyalty transactions error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load transactions' } });
  }
});

// @route   GET /api/v1/loyalty/rewards
router.get('/rewards', async (req, res) => {
  try {
    const account = await getOrCreateAccount(req.user);
    const now = new Date();
    const rewards = await LoyaltyReward.find({
      status: 'ACTIVE',
      $or: [{ validFrom: null }, { validFrom: { $lte: now } }],
    }).sort({ pointsRequired: 1 });

    const eligible = rewards.filter((r) =>
      (!r.validUntil || r.validUntil >= now) &&
      (!r.applicableTiers.length || (account.currentTierCode && r.applicableTiers.includes(account.currentTierCode)))
    );

    res.status(200).json({ success: true, data: eligible });
  } catch (error) {
    console.error('Loyalty rewards error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load rewards' } });
  }
});

// @route   GET /api/v1/loyalty/rewards/:rewardId
router.get('/rewards/:rewardId', async (req, res) => {
  try {
    const reward = await LoyaltyReward.findById(req.params.rewardId);
    if (!reward) return errorResponse(res, { code: 'REWARD_NOT_FOUND', message: 'Reward not found' });
    res.status(200).json({ success: true, data: reward });
  } catch (error) {
    console.error('Loyalty reward detail error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load reward' } });
  }
});

// @route   POST /api/v1/loyalty/rewards/:rewardId/redeem
// @body    { idempotencyKey }
router.post('/rewards/:rewardId/redeem', async (req, res) => {
  try {
    const { idempotencyKey } = req.body;
    if (!idempotencyKey) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'idempotencyKey is required' } });
    }

    const account = await getOrCreateAccount(req.user);
    const { redemption, account: updatedAccount } = await redeemReward({
      user: req.user,
      rewardId: req.params.rewardId,
      idempotencyKey,
      tierCode: account.currentTierCode
    });

    res.status(200).json({
      success: true,
      redemption: {
        id: redemption._id,
        rewardName: redemption.rewardSnapshot.name,
        couponCode: redemption.couponCode,
        pointsSpent: redemption.pointsSpent,
        expiresAt: redemption.expiresAt
      },
      balance: { availablePoints: updatedAccount.availablePoints }
    });
  } catch (error) {
    if (error.code) return errorResponse(res, error);
    console.error('Loyalty redeem error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Redemption failed' } });
  }
});

// @route   GET /api/v1/loyalty/redemptions/active
// @desc    This customer's unused vouchers - the "apply a reward" picker at
//          checkout reads from here (there is no code-entry flow to hook into).
router.get('/redemptions/active', async (req, res) => {
  try {
    const redemptions = await LoyaltyRedemption.find({
      mobile: req.user.mobile, status: 'ACTIVE', expiresAt: { $gte: new Date() }
    }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: redemptions });
  } catch (error) {
    console.error('Loyalty active redemptions error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load redemptions' } });
  }
});

// @route   POST /api/v1/loyalty/redemptions/:redemptionId/preview
// @desc    What discount would this redemption produce against the given cart right now.
router.post('/redemptions/:redemptionId/preview', async (req, res) => {
  try {
    const redemption = await LoyaltyRedemption.findOne({ _id: req.params.redemptionId, mobile: req.user.mobile });
    if (!redemption || redemption.status !== 'ACTIVE') {
      return res.status(404).json({ success: false, error: { code: 'REWARD_NOT_FOUND', message: 'Redemption not found or already used' } });
    }
    const { orderSubtotal = 0, deliveryCharges = 0 } = req.body;
    const preview = previewRedemptionDiscount(redemption, { orderSubtotal, deliveryCharges });
    res.status(200).json({ success: true, data: preview });
  } catch (error) {
    console.error('Loyalty redemption preview error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to preview redemption' } });
  }
});

// @route   GET /api/v1/loyalty/tiers
router.get('/tiers', async (req, res) => {
  try {
    const tiers = await getActiveTiers();
    res.status(200).json({ success: true, data: tiers });
  } catch (error) {
    console.error('Loyalty tiers error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load tiers' } });
  }
});

// @route   GET /api/v1/loyalty/challenges
router.get('/challenges', async (req, res) => {
  try {
    const challenges = await LoyaltyChallenge.find({ status: 'ACTIVE', validUntil: { $gte: new Date() } }).sort({ createdAt: -1 });
    const progress = await LoyaltyChallengeProgress.find({ mobile: req.user.mobile });
    const progressMap = new Map(progress.map((p) => [String(p.challengeId), p]));

    res.status(200).json({
      success: true,
      data: challenges.map((c) => ({ ...c.toObject(), progress: progressMap.get(String(c._id)) || null }))
    });
  } catch (error) {
    console.error('Loyalty challenges error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load challenges' } });
  }
});

// @route   GET /api/v1/loyalty/challenges/:challengeId
router.get('/challenges/:challengeId', async (req, res) => {
  try {
    const challenge = await LoyaltyChallenge.findById(req.params.challengeId);
    if (!challenge) return errorResponse(res, { code: 'REWARD_NOT_FOUND', message: 'Challenge not found' });
    const progress = await LoyaltyChallengeProgress.findOne({ mobile: req.user.mobile, challengeId: challenge._id });
    res.status(200).json({ success: true, data: { ...challenge.toObject(), progress } });
  } catch (error) {
    console.error('Loyalty challenge detail error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load challenge' } });
  }
});

// @route   POST /api/v1/loyalty/challenges/:challengeId/claim
router.post('/challenges/:challengeId/claim', async (req, res) => {
  try {
    const result = await claimChallenge({ user: req.user, challengeId: req.params.challengeId });
    res.status(200).json({
      success: true,
      balance: { availablePoints: result.account.availablePoints }
    });
  } catch (error) {
    if (error.code) return errorResponse(res, error);
    console.error('Loyalty claim challenge error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to claim challenge' } });
  }
});

// @route   GET /api/v1/loyalty/referral
router.get('/referral', async (req, res) => {
  try {
    const account = await getOrCreateAccount(req.user);
    const referrals = await LoyaltyReferral.find({ referrerMobile: req.user.mobile, status: 'COMPLETED' });
    const earnedPoints = referrals.reduce((sum, r) => sum + (r.referrerReward?.points || 0), 0);

    res.status(200).json({
      success: true,
      data: { code: account.referralCode, successfulReferrals: referrals.length, earnedPoints }
    });
  } catch (error) {
    console.error('Loyalty referral error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load referral info' } });
  }
});

// @route   POST /api/v1/loyalty/referral/apply
// @body    { referralCode }
router.post('/referral/apply', async (req, res) => {
  try {
    const referral = await applyReferralCode({ referredUser: req.user, code: req.body.referralCode });
    res.status(200).json({ success: true, data: referral });
  } catch (error) {
    if (error.code) return errorResponse(res, error);
    console.error('Loyalty referral apply error:', error);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to apply referral code' } });
  }
});

module.exports = router;
