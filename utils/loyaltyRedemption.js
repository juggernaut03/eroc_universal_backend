/**
 * Reward redemption: points -> a usable voucher. See
 * loyalty_rewards_frd.md sections 10-13, 42, 44.
 *
 * There's no code-entry "apply a coupon" flow anywhere in this codebase
 * (checked both the checkout API and the Flutter checkout screen) and no
 * Offer.code/usage-limit machinery to reuse - Offers are auto-surfaced by
 * cart value, not redeemed by code. So a loyalty redemption is its own
 * first-class record (LoyaltyRedemption) rather than a generated Offer
 * document: the customer picks an ACTIVE redemption from a list at checkout
 * (GET /api/loyalty/redemptions/active), not by typing anything.
 */

const crypto = require('crypto');
const LoyaltyReward = require('../models/LoyaltyReward');
const LoyaltyRedemption = require('../models/LoyaltyRedemption');
const { debitPoints, runAtomically } = require('./loyaltyEngine');

const REDEMPTION_VALIDITY_DAYS = 90;

const generateCouponCode = () => `LOY-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const isDuplicateKeyError = (error) => error && error.code === 11000;

/**
 * Redeem `reward` for `user`, spending points atomically. Returns
 * {redemption, account} or throws a named Error whose .code the route maps
 * to the FRD's error codes (section 63).
 */
const redeemReward = async ({ user, rewardId, idempotencyKey, tierCode = null }) => {
  const reward = await LoyaltyReward.findById(rewardId);
  if (!reward) {
    const err = new Error('Reward not found'); err.code = 'REWARD_NOT_FOUND'; throw err;
  }
  if (reward.status !== 'ACTIVE') {
    const err = new Error('Reward is not active'); err.code = 'REWARD_INACTIVE'; throw err;
  }
  const now = new Date();
  if ((reward.validFrom && reward.validFrom > now) || (reward.validUntil && reward.validUntil < now)) {
    const err = new Error('Reward is not currently valid'); err.code = 'REWARD_EXPIRED'; throw err;
  }
  if (reward.applicableTiers.length && (!tierCode || !reward.applicableTiers.includes(tierCode))) {
    const err = new Error('Reward is not available for your tier'); err.code = 'REWARD_INACTIVE'; throw err;
  }
  if (reward.usageLimit != null && reward.usedCount >= reward.usageLimit) {
    const err = new Error('Reward has reached its redemption limit'); err.code = 'REWARD_LIMIT_REACHED'; throw err;
  }
  if (reward.perUserLimit != null) {
    const userRedemptions = await LoyaltyRedemption.countDocuments({
      mobile: user.mobile, rewardId: reward._id, status: { $in: ['ACTIVE', 'USED'] }
    });
    if (userRedemptions >= reward.perUserLimit) {
      const err = new Error('You have already redeemed this reward the maximum number of times');
      err.code = 'USER_REDEMPTION_LIMIT_REACHED'; throw err;
    }
  }

  const debit = await debitPoints({
    user,
    points: reward.pointsRequired,
    source: 'REDEMPTION',
    idempotencyKey,
    referenceId: String(reward._id),
    metadata: { rewardName: reward.name, rewardType: reward.type }
  });

  if (debit.duplicate) {
    const err = new Error('This redemption was already processed'); err.code = 'DUPLICATE_TRANSACTION'; throw err;
  }
  if (debit.account == null && debit.transaction == null) {
    // Shouldn't happen - debitPoints throws INSUFFICIENT_POINTS rather than
    // returning this shape - kept as a defensive guard.
    const err = new Error('Redemption failed'); err.code = 'INSUFFICIENT_POINTS'; throw err;
  }

  const expiresAt = new Date(Math.min(
    now.getTime() + REDEMPTION_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
    reward.validUntil ? reward.validUntil.getTime() : Infinity
  ));

  let redemption;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      redemption = await LoyaltyRedemption.create({
        userId: user._id,
        mobile: user.mobile,
        rewardId: reward._id,
        pointsSpent: reward.pointsRequired,
        couponCode: generateCouponCode(),
        rewardSnapshot: {
          name: reward.name,
          type: reward.type,
          discountValue: reward.discountValue,
          maximumDiscount: reward.maximumDiscount,
          minimumOrderValue: reward.minimumOrderValue
        },
        status: 'ACTIVE',
        expiresAt
      });
      break;
    } catch (error) {
      if (isDuplicateKeyError(error)) continue; // coupon code collision, retry
      throw error;
    }
  }
  if (!redemption) throw new Error('Could not allocate a unique coupon code');

  await LoyaltyReward.updateOne({ _id: reward._id }, { $inc: { usedCount: 1 } });

  return { redemption, account: debit.account };
};

/**
 * Pure calculation: what discount would `redemption` produce against
 * `orderSubtotal` and `deliveryCharges` right now. Does not mutate
 * anything - used both for a checkout-time preview and, with the same
 * numbers, for the actual apply step in utils/orderService.js.
 */
const previewRedemptionDiscount = (redemption, { orderSubtotal, deliveryCharges = 0 }) => {
  const snap = redemption.rewardSnapshot;
  if (orderSubtotal < (snap.minimumOrderValue || 0)) {
    return { valid: false, reason: `Minimum order value of ₹${snap.minimumOrderValue} not met`, discountAmount: 0 };
  }

  let discountAmount = 0;
  if (snap.type === 'FIXED_DISCOUNT' || snap.type === 'CASHBACK') {
    discountAmount = snap.discountValue;
  } else if (snap.type === 'PERCENTAGE_DISCOUNT') {
    discountAmount = (orderSubtotal * snap.discountValue) / 100;
    if (snap.maximumDiscount != null) discountAmount = Math.min(discountAmount, snap.maximumDiscount);
  } else if (snap.type === 'FREE_SHIPPING') {
    discountAmount = deliveryCharges;
  } else {
    // FREE_PRODUCT / SPECIAL_OFFER - not wired to a checkout-time amount;
    // these are recorded as used but fulfilled manually. See LoyaltyReward
    // model doc.
    return { valid: false, reason: 'This reward type is fulfilled manually - contact support', discountAmount: 0 };
  }

  discountAmount = Math.min(discountAmount, orderSubtotal + deliveryCharges);
  return { valid: true, discountAmount: Math.round(discountAmount * 100) / 100 };
};

const markRedemptionUsed = async (redemption, orderId, session = null) => {
  redemption.status = 'USED';
  redemption.usedAt = new Date();
  redemption.orderId = orderId;
  await redemption.save({ session });
};

module.exports = { redeemReward, previewRedemptionDiscount, markRedemptionUsed, runAtomically };
