/**
 * Referral program. See loyalty_rewards_frd.md sections 18, 36.
 *
 * Simplification versus the FRD's example (referrer gets points, referred
 * gets a "₹100 OFF" coupon): both sides are credited in points here. Turning
 * the referred customer's welcome benefit into a checkout-applicable
 * discount would mean materializing a synthetic LoyaltyRedemption without a
 * real LoyaltyReward/points cost behind it - a special case the redemption
 * engine isn't built for. Crediting points to both sides keeps one
 * consistent mechanism and is still a genuine, immediately useful benefit
 * (the referred customer can redeem it like any other earned points).
 * LoyaltyReferral.referredReward.couponValue is kept as the configured
 * point amount for that side, for continuity with the FRD's field name.
 */

const User = require('../models/User');
const LoyaltyAccount = require('../models/LoyaltyAccount');
const LoyaltyReferral = require('../models/LoyaltyReferral');
const LoyaltyRule = require('../models/LoyaltyRule');
const { creditPoints } = require('./loyaltyEngine');
const { notifyLoyaltyEvent } = require('./loyaltyNotify');

const DEFAULT_REFERRED_BONUS_POINTS = 100;

/**
 * A new customer applies a referral code, typically right after
 * registration. Creates a PENDING LoyaltyReferral - nothing is credited
 * until the referred customer's qualifying order is delivered (see
 * completeReferralIfQualifying).
 */
const applyReferralCode = async ({ referredUser, code }) => {
  if (!code) { const err = new Error('Referral code is required'); err.code = 'REFERRAL_INVALID'; throw err; }

  const referrerAccount = await LoyaltyAccount.findOne({ referralCode: code.trim().toUpperCase() });
  if (!referrerAccount) {
    const err = new Error('Invalid referral code'); err.code = 'REFERRAL_INVALID'; throw err;
  }
  if (referrerAccount.mobile === referredUser.mobile) {
    const err = new Error('You cannot refer yourself'); err.code = 'REFERRAL_INVALID'; throw err;
  }

  try {
    return await LoyaltyReferral.create({
      referrerUserId: referrerAccount.userId,
      referrerMobile: referrerAccount.mobile,
      referredUserId: referredUser._id,
      referredMobile: referredUser.mobile,
      referralCode: code.trim().toUpperCase(),
      status: 'PENDING'
    });
  } catch (error) {
    if (error.code === 11000) {
      // Unique index on referredMobile - this codebase's primary anti-abuse
      // guard (FRD 18.2): a mobile number can only ever be "the referred
      // person" once.
      const err = new Error('A referral has already been applied to this account');
      err.code = 'REFERRAL_INVALID';
      throw err;
    }
    throw error;
  }
};

/**
 * Called from the ORDER_DELIVERED hook. If this delivered order is the
 * referred customer's first, and they have a PENDING referral, completes it:
 * credits the referrer, credits the referred customer, marks COMPLETED.
 */
const completeReferralIfQualifying = async ({ referredUser, order, isFirstOrder, projectCode }) => {
  if (!isFirstOrder) return null;

  const referral = await LoyaltyReferral.findOne({ referredMobile: referredUser.mobile, status: 'PENDING' });
  if (!referral) return null;

  const referralRule = await LoyaltyRule.findOne({ event: 'REFERRAL', status: 'ACTIVE' });
  const referrerPoints = referralRule ? referralRule.pointsValue : 500;
  const referredPoints = DEFAULT_REFERRED_BONUS_POINTS;

  const referrerAccount = await LoyaltyAccount.findOne({ mobile: referral.referrerMobile });
  if (!referrerAccount) return null;
  // The real User doc, not just {_id, mobile} - notifyLoyaltyEvent needs
  // fcmToken to actually push, not just create the in-app row. A synthetic
  // ref here silently dropped the push (no fcmToken to send to), so the
  // referrer had no signal their balance had changed until they happened to
  // pull-to-refresh - reported as "mobile shows 200, admin shows 700".
  const referrerUser = await User.findById(referrerAccount.userId);
  if (!referrerUser) return null;

  await creditPoints({
    user: referrerUser,
    points: referrerPoints,
    source: 'REFERRAL',
    referenceId: String(referral._id),
    idempotencyKey: `REFERRAL_${referral._id}_REFERRER`,
    metadata: { referredMobile: referredUser.mobile, orderId: String(order._id) },
    status: 'COMPLETED'
  });

  await creditPoints({
    user: referredUser,
    points: referredPoints,
    source: 'REFERRAL',
    referenceId: String(referral._id),
    idempotencyKey: `REFERRAL_${referral._id}_REFERRED`,
    metadata: { referrerMobile: referral.referrerMobile, orderId: String(order._id) },
    status: 'COMPLETED'
  });

  referral.status = 'COMPLETED';
  referral.qualifyingOrderId = order._id;
  referral.referrerReward = { points: referrerPoints, status: 'CREDITED' };
  referral.referredReward = { couponValue: referredPoints, status: 'CREDITED', redemptionId: null };
  referral.completedAt = new Date();
  await referral.save();

  await notifyLoyaltyEvent(referrerUser, {
    title: 'Referral successful! 🎉',
    body: `You earned ${referrerPoints} points for referring a friend.`,
    data: { loyaltyEventType: 'REFERRAL_SUCCESSFUL' },
    projectCode
  });

  return referral;
};

module.exports = { applyReferralCode, completeReferralIfQualifying };
