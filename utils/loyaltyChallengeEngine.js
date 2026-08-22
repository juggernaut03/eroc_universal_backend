/**
 * Gamified challenge progress tracking. See loyalty_rewards_frd.md
 * sections 19, 34-35.
 *
 * PURCHASE_COUNT and CATEGORY_COUNT both increment by 1 per delivered order
 * in this pass - true "N distinct categories" tracking would need an array
 * field to dedupe against, which LoyaltyChallengeProgress doesn't have yet.
 * A CATEGORY_COUNT challenge is functionally identical to PURCHASE_COUNT
 * until that's added; flagged here rather than silently wrong.
 */

const LoyaltyChallenge = require('../models/LoyaltyChallenge');
const LoyaltyChallengeProgress = require('../models/LoyaltyChallengeProgress');
const { creditPoints } = require('./loyaltyEngine');
const { notifyLoyaltyEvent } = require('./loyaltyNotify');

const EVENT_TYPES = {
  ORDER_DELIVERED: ['PURCHASE_COUNT', 'CATEGORY_COUNT', 'FIRST_APP_ORDER'],
  ORDER_AMOUNT: ['SPEND_AMOUNT']
};

/**
 * Advance progress on every active challenge relevant to `event` for this
 * customer. Idempotent per order: pass the same `orderId` and a challenge
 * already advanced for that order is skipped (checked via
 * metadata.lastOrderId on the progress row).
 */
const evaluateChallenges = async ({ user, event, orderAmount = 0, orderId, isFirstOrder = false, projectCode }) => {
  const now = new Date();
  const relevantTypes = EVENT_TYPES[event] || [];
  if (!relevantTypes.length) return;

  const challenges = await LoyaltyChallenge.find({
    status: 'ACTIVE',
    type: { $in: relevantTypes },
    validFrom: { $lte: now },
    validUntil: { $gte: now }
  });

  for (const challenge of challenges) {
    if (challenge.type === 'FIRST_APP_ORDER' && !isFirstOrder) continue;

    let progress = await LoyaltyChallengeProgress.findOne({ mobile: user.mobile, challengeId: challenge._id });
    if (!progress) {
      progress = await LoyaltyChallengeProgress.create({
        userId: user._id,
        mobile: user.mobile,
        challengeId: challenge._id,
        currentValue: 0,
        targetValue: challenge.targetValue,
        status: 'IN_PROGRESS'
      });
    }
    if (progress.status !== 'IN_PROGRESS') continue;
    // Already counted this exact order toward this challenge (retried hook).
    if (orderId && progress.lastOrderId === String(orderId)) continue;

    const increment = challenge.type === 'SPEND_AMOUNT' ? orderAmount : 1;
    progress.currentValue = Math.min(challenge.targetValue, progress.currentValue + increment);
    if (orderId) progress.lastOrderId = String(orderId);

    if (progress.currentValue >= challenge.targetValue) {
      progress.status = 'COMPLETED';
      progress.completedAt = now;
    }
    await progress.save();

    if (progress.status === 'COMPLETED') {
      await notifyLoyaltyEvent(user, {
        title: 'Challenge completed! 🎉',
        body: `You completed "${challenge.name}" — claim your ${challenge.rewardPoints} bonus points.`,
        data: { loyaltyEventType: 'CHALLENGE_COMPLETED', challengeId: String(challenge._id) },
        projectCode
      });
    }
  }
};

/** Claim a completed challenge's reward. */
const claimChallenge = async ({ user, challengeId }) => {
  const challenge = await LoyaltyChallenge.findById(challengeId);
  if (!challenge) { const err = new Error('Challenge not found'); err.code = 'REWARD_NOT_FOUND'; throw err; }
  if (challenge.validUntil < new Date()) {
    const err = new Error('Challenge has expired'); err.code = 'CHALLENGE_EXPIRED'; throw err;
  }

  const progress = await LoyaltyChallengeProgress.findOne({ mobile: user.mobile, challengeId });
  if (!progress || progress.status === 'IN_PROGRESS') {
    const err = new Error('Challenge not yet completed'); err.code = 'CHALLENGE_EXPIRED'; throw err;
  }
  if (progress.status === 'CLAIMED') {
    const err = new Error('Challenge reward already claimed'); err.code = 'CHALLENGE_ALREADY_CLAIMED'; throw err;
  }

  const result = await creditPoints({
    user,
    points: challenge.rewardPoints,
    source: 'CHALLENGE',
    referenceId: String(challenge._id),
    idempotencyKey: `CHALLENGE_${challenge._id}_${user.mobile}_CLAIM`,
    metadata: { challengeName: challenge.name },
    status: 'COMPLETED'
  });

  progress.status = 'CLAIMED';
  progress.claimedAt = new Date();
  await progress.save();

  return result;
};

module.exports = { evaluateChallenges, claimChallenge };
