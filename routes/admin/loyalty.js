const express = require('express');
const router = express.Router();
const { checkPermission } = require('../../middleware/checkPermission');

const LoyaltyAccount = require('../../models/LoyaltyAccount');
const LoyaltyTransaction = require('../../models/LoyaltyTransaction');
const LoyaltyRule = require('../../models/LoyaltyRule');
const LoyaltyReward = require('../../models/LoyaltyReward');
const LoyaltyRedemption = require('../../models/LoyaltyRedemption');
const LoyaltyTier = require('../../models/LoyaltyTier');
const LoyaltyCampaign = require('../../models/LoyaltyCampaign');
const LoyaltyChallenge = require('../../models/LoyaltyChallenge');
const LoyaltyReferral = require('../../models/LoyaltyReferral');
const LoyaltyAuditLog = require('../../models/LoyaltyAuditLog');
const User = require('../../models/User');

const { creditPoints, debitPoints } = require('../../utils/loyaltyEngine');

const paginate = (req) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 20);
  return { page, limit, skip: (page - 1) * limit };
};
const pageMeta = (page, limit, total) => ({ page, limit, total, totalPages: Math.ceil(total / limit) || 1 });

const writeAuditLog = (fields) => LoyaltyAuditLog.create(fields).catch((e) =>
  console.error('[loyalty] audit log write failed:', e)
);

// ---------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------

router.get('/dashboard', checkPermission('loyalty', 'view'), async (req, res) => {
  try {
    const [
      totalMembers, activeMembers, issuedAgg, redeemedAgg, expiredAgg,
      outstandingAgg, redemptionCount, topRewards, referralCount
    ] = await Promise.all([
      LoyaltyAccount.countDocuments(),
      LoyaltyAccount.countDocuments({ status: 'ACTIVE' }),
      LoyaltyTransaction.aggregate([{ $match: { type: 'CREDIT' } }, { $group: { _id: null, total: { $sum: '$points' } } }]),
      LoyaltyTransaction.aggregate([{ $match: { type: 'DEBIT' } }, { $group: { _id: null, total: { $sum: '$points' } } }]),
      LoyaltyTransaction.aggregate([{ $match: { type: 'EXPIRATION' } }, { $group: { _id: null, total: { $sum: '$points' } } }]),
      LoyaltyAccount.aggregate([{ $group: { _id: null, total: { $sum: '$availablePoints' } } }]),
      LoyaltyRedemption.countDocuments(),
      LoyaltyRedemption.aggregate([
        { $group: { _id: '$rewardSnapshot.name', count: { $sum: 1 } } },
        { $sort: { count: -1 } }, { $limit: 5 }
      ]),
      LoyaltyReferral.countDocuments({ status: 'COMPLETED' })
    ]);

    const issued = issuedAgg[0]?.total || 0;
    const redeemed = redeemedAgg[0]?.total || 0;

    res.status(200).json({
      success: true,
      data: {
        totalMembers,
        activeMembers,
        pointsIssued: issued,
        pointsRedeemed: redeemed,
        pointsExpired: expiredAgg[0]?.total || 0,
        outstandingPoints: outstandingAgg[0]?.total || 0,
        rewardRedemptions: redemptionCount,
        referralConversions: referralCount,
        redemptionRate: issued > 0 ? Math.round((redeemed / issued) * 10000) / 100 : 0,
        topRewards: topRewards.map((r) => ({ name: r._id, count: r.count }))
      }
    });
  } catch (error) {
    console.error('Loyalty admin dashboard error:', error);
    res.status(500).json({ success: false, message: 'Failed to load loyalty dashboard' });
  }
});

// ---------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------

router.get('/rules', checkPermission('loyalty', 'view'), async (req, res) => {
  try {
    const rules = await LoyaltyRule.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: rules });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/rules', checkPermission('loyalty', 'create'), async (req, res) => {
  try {
    const rule = await LoyaltyRule.create({ ...req.body, createdBy: req.user._id });
    await writeAuditLog({ action: 'RULE_CREATED', targetType: 'LoyaltyRule', targetId: String(rule._id), performedBy: req.user._id, after: rule.toObject() });
    res.status(201).json({ success: true, data: rule });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.put('/rules/:id', checkPermission('loyalty', 'edit'), async (req, res) => {
  try {
    const before = await LoyaltyRule.findById(req.params.id);
    if (!before) return res.status(404).json({ success: false, message: 'Rule not found' });
    const rule = await LoyaltyRule.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    await writeAuditLog({ action: 'RULE_UPDATED', targetType: 'LoyaltyRule', targetId: req.params.id, performedBy: req.user._id, before: before.toObject(), after: rule.toObject() });
    res.status(200).json({ success: true, data: rule });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.patch('/rules/:id/status', checkPermission('loyalty', 'edit'), async (req, res) => {
  try {
    const { status } = req.body;
    const rule = await LoyaltyRule.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!rule) return res.status(404).json({ success: false, message: 'Rule not found' });
    res.status(200).json({ success: true, data: rule });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ---------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------

router.get('/rewards', checkPermission('loyalty', 'view'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const [data, total] = await Promise.all([
      LoyaltyReward.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      LoyaltyReward.countDocuments()
    ]);
    res.status(200).json({ success: true, data, pagination: pageMeta(page, limit, total) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/rewards', checkPermission('loyalty', 'create'), async (req, res) => {
  try {
    const reward = await LoyaltyReward.create(req.body);
    await writeAuditLog({ action: 'REWARD_CREATED', targetType: 'LoyaltyReward', targetId: String(reward._id), performedBy: req.user._id, after: reward.toObject() });
    res.status(201).json({ success: true, data: reward });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.put('/rewards/:id', checkPermission('loyalty', 'edit'), async (req, res) => {
  try {
    const before = await LoyaltyReward.findById(req.params.id);
    if (!before) return res.status(404).json({ success: false, message: 'Reward not found' });
    const reward = await LoyaltyReward.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    await writeAuditLog({ action: 'REWARD_UPDATED', targetType: 'LoyaltyReward', targetId: req.params.id, performedBy: req.user._id, before: before.toObject(), after: reward.toObject() });
    res.status(200).json({ success: true, data: reward });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/rewards/:id', checkPermission('loyalty', 'delete'), async (req, res) => {
  try {
    const reward = await LoyaltyReward.findByIdAndDelete(req.params.id);
    if (!reward) return res.status(404).json({ success: false, message: 'Reward not found' });
    await writeAuditLog({ action: 'REWARD_DELETED', targetType: 'LoyaltyReward', targetId: req.params.id, performedBy: req.user._id, before: reward.toObject() });
    res.status(200).json({ success: true, message: 'Reward deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------

router.get('/tiers', checkPermission('loyalty', 'view'), async (req, res) => {
  try {
    const tiers = await LoyaltyTier.find().sort({ rank: 1 });
    res.status(200).json({ success: true, data: tiers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/tiers', checkPermission('loyalty', 'create'), async (req, res) => {
  try {
    const tier = await LoyaltyTier.create(req.body);
    await writeAuditLog({ action: 'TIER_CREATED', targetType: 'LoyaltyTier', targetId: String(tier._id), performedBy: req.user._id, after: tier.toObject() });
    res.status(201).json({ success: true, data: tier });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.put('/tiers/:id', checkPermission('loyalty', 'edit'), async (req, res) => {
  try {
    const before = await LoyaltyTier.findById(req.params.id);
    if (!before) return res.status(404).json({ success: false, message: 'Tier not found' });
    const tier = await LoyaltyTier.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    await writeAuditLog({ action: 'TIER_UPDATED', targetType: 'LoyaltyTier', targetId: req.params.id, performedBy: req.user._id, before: before.toObject(), after: tier.toObject() });
    res.status(200).json({ success: true, data: tier });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// ---------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------

router.get('/campaigns', checkPermission('loyalty', 'view'), async (req, res) => {
  try {
    const campaigns = await LoyaltyCampaign.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: campaigns });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/campaigns', checkPermission('loyalty', 'create'), async (req, res) => {
  try {
    const campaign = await LoyaltyCampaign.create({ ...req.body, createdBy: req.user._id });
    await writeAuditLog({ action: 'CAMPAIGN_CREATED', targetType: 'LoyaltyCampaign', targetId: String(campaign._id), performedBy: req.user._id, after: campaign.toObject() });
    res.status(201).json({ success: true, data: campaign });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.put('/campaigns/:id', checkPermission('loyalty', 'edit'), async (req, res) => {
  try {
    const before = await LoyaltyCampaign.findById(req.params.id);
    if (!before) return res.status(404).json({ success: false, message: 'Campaign not found' });
    const campaign = await LoyaltyCampaign.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    await writeAuditLog({ action: 'CAMPAIGN_UPDATED', targetType: 'LoyaltyCampaign', targetId: req.params.id, performedBy: req.user._id, before: before.toObject(), after: campaign.toObject() });
    res.status(200).json({ success: true, data: campaign });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/campaigns/:id', checkPermission('loyalty', 'delete'), async (req, res) => {
  try {
    const campaign = await LoyaltyCampaign.findByIdAndDelete(req.params.id);
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });
    await writeAuditLog({ action: 'CAMPAIGN_DELETED', targetType: 'LoyaltyCampaign', targetId: req.params.id, performedBy: req.user._id, before: campaign.toObject() });
    res.status(200).json({ success: true, message: 'Campaign deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------

router.get('/challenges', checkPermission('loyalty', 'view'), async (req, res) => {
  try {
    const challenges = await LoyaltyChallenge.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: challenges });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/challenges', checkPermission('loyalty', 'create'), async (req, res) => {
  try {
    const challenge = await LoyaltyChallenge.create(req.body);
    await writeAuditLog({ action: 'CHALLENGE_CREATED', targetType: 'LoyaltyChallenge', targetId: String(challenge._id), performedBy: req.user._id, after: challenge.toObject() });
    res.status(201).json({ success: true, data: challenge });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.put('/challenges/:id', checkPermission('loyalty', 'edit'), async (req, res) => {
  try {
    const before = await LoyaltyChallenge.findById(req.params.id);
    if (!before) return res.status(404).json({ success: false, message: 'Challenge not found' });
    const challenge = await LoyaltyChallenge.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    await writeAuditLog({ action: 'CHALLENGE_UPDATED', targetType: 'LoyaltyChallenge', targetId: req.params.id, performedBy: req.user._id, before: before.toObject(), after: challenge.toObject() });
    res.status(200).json({ success: true, data: challenge });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/challenges/:id', checkPermission('loyalty', 'delete'), async (req, res) => {
  try {
    const challenge = await LoyaltyChallenge.findByIdAndDelete(req.params.id);
    if (!challenge) return res.status(404).json({ success: false, message: 'Challenge not found' });
    await writeAuditLog({ action: 'CHALLENGE_DELETED', targetType: 'LoyaltyChallenge', targetId: req.params.id, performedBy: req.user._id, before: challenge.toObject() });
    res.status(200).json({ success: true, message: 'Challenge deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------------------------------------------------------------------
// Accounts (customer search/detail/manual adjustment/suspend)
// ---------------------------------------------------------------------

router.get('/accounts', checkPermission('loyalty', 'view'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const query = {};
    if (req.query.search) {
      const users = await User.find({
        $or: [
          { mobile: { $regex: req.query.search, $options: 'i' } },
          { name: { $regex: req.query.search, $options: 'i' } }
        ]
      }).select('_id');
      query.userId = { $in: users.map((u) => u._id) };
    }
    if (req.query.status) query.status = req.query.status;

    const [accounts, total] = await Promise.all([
      LoyaltyAccount.find(query).sort({ availablePoints: -1 }).skip(skip).limit(limit),
      LoyaltyAccount.countDocuments(query)
    ]);

    const users = await User.find({ _id: { $in: accounts.map((a) => a.userId) } }).select('name mobile email').lean();
    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const data = accounts.map((a) => ({ ...a.toObject(), user: userMap.get(String(a.userId)) || null }));

    res.status(200).json({ success: true, data, pagination: pageMeta(page, limit, total) });
  } catch (error) {
    console.error('Loyalty accounts search error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/accounts/:mobile', checkPermission('loyalty', 'view'), async (req, res) => {
  try {
    const account = await LoyaltyAccount.findOne({ mobile: req.params.mobile });
    if (!account) return res.status(404).json({ success: false, message: 'Loyalty account not found' });

    const [user, transactions, redemptions] = await Promise.all([
      User.findById(account.userId).select('name mobile email'),
      LoyaltyTransaction.find({ mobile: req.params.mobile }).sort({ createdAt: -1 }).limit(50),
      LoyaltyRedemption.find({ mobile: req.params.mobile }).sort({ createdAt: -1 }).limit(20)
    ]);

    res.status(200).json({ success: true, data: { account, user, transactions, redemptions } });
  } catch (error) {
    console.error('Loyalty account detail error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/accounts/:mobile/adjust', checkPermission('loyalty', 'edit'), async (req, res) => {
  try {
    const { points, reason } = req.body;
    if (!points || !Number.isFinite(Number(points)) || Number(points) === 0) {
      return res.status(400).json({ success: false, message: 'points must be a non-zero number' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, message: 'A reason is required for manual point adjustments' });
    }

    const account = await LoyaltyAccount.findOne({ mobile: req.params.mobile });
    if (!account) return res.status(404).json({ success: false, message: 'Loyalty account not found' });
    const user = await User.findById(account.userId);
    if (!user) return res.status(404).json({ success: false, message: 'Customer account not found' });

    const magnitude = Math.abs(Number(points));
    const idempotencyKey = `ADMIN_ADJUST_${account.mobile}_${Date.now()}`;
    const result = Number(points) > 0
      ? await creditPoints({ user, points: magnitude, source: 'ADMIN', idempotencyKey, metadata: { reason, adminId: String(req.user._id) }, status: 'COMPLETED' })
      : await debitPoints({ user, points: magnitude, source: 'ADMIN', idempotencyKey, metadata: { reason, adminId: String(req.user._id) } });

    await writeAuditLog({
      action: 'POINTS_ADJUSTMENT', targetType: 'LoyaltyAccount', targetId: String(account._id),
      performedBy: req.user._id, reason, after: { points: Number(points), transactionId: result.transaction?._id }
    });

    res.status(200).json({ success: true, data: { balance: result.account } });
  } catch (error) {
    if (error.code === 'INSUFFICIENT_POINTS') {
      return res.status(400).json({ success: false, message: 'Customer does not have enough points for this deduction' });
    }
    console.error('Loyalty manual adjustment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.patch('/accounts/:mobile/status', checkPermission('loyalty', 'edit'), async (req, res) => {
  try {
    const { status, reason } = req.body;
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'status must be ACTIVE or SUSPENDED' });
    }
    const account = await LoyaltyAccount.findOneAndUpdate(
      { mobile: req.params.mobile },
      { status, suspendedReason: status === 'SUSPENDED' ? (reason || '') : null },
      { new: true }
    );
    if (!account) return res.status(404).json({ success: false, message: 'Loyalty account not found' });

    await writeAuditLog({
      action: status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_ACTIVATED',
      targetType: 'LoyaltyAccount', targetId: String(account._id), performedBy: req.user._id, reason
    });

    res.status(200).json({ success: true, data: account });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------------------------------------------------------------------
// Global ledger search
// ---------------------------------------------------------------------

router.get('/transactions', checkPermission('loyalty', 'view'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const query = {};
    if (req.query.mobile) query.mobile = req.query.mobile;
    if (req.query.type) query.type = req.query.type;
    if (req.query.source) query.source = req.query.source;

    const [data, total] = await Promise.all([
      LoyaltyTransaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      LoyaltyTransaction.countDocuments(query)
    ]);
    res.status(200).json({ success: true, data, pagination: pageMeta(page, limit, total) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------

router.get('/referrals', checkPermission('loyalty', 'view'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const query = {};
    if (req.query.status) query.status = req.query.status;
    const [data, total] = await Promise.all([
      LoyaltyReferral.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      LoyaltyReferral.countDocuments(query)
    ]);
    res.status(200).json({ success: true, data, pagination: pageMeta(page, limit, total) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ---------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------

router.get('/audit-logs', checkPermission('loyalty', 'view'), async (req, res) => {
  try {
    const { page, limit, skip } = paginate(req);
    const [data, total] = await Promise.all([
      LoyaltyAuditLog.find().sort({ createdAt: -1 }).skip(skip).limit(limit).populate('performedBy', 'name mobile email'),
      LoyaltyAuditLog.countDocuments()
    ]);
    res.status(200).json({ success: true, data, pagination: pageMeta(page, limit, total) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
