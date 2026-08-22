const mongoose = require('mongoose');

// One row per referred signup. The referrer's own stable referral code
// lives on LoyaltyAccount.referralCode - this collection tracks each
// individual referral event and its qualification lifecycle. See
// loyalty_rewards_frd.md sections 18, 36.
const loyaltyReferralSchema = new mongoose.Schema({
  referrerUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  referrerMobile: {
    type: String,
    required: true,
    trim: true
  },

  referredUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  referredMobile: {
    type: String,
    required: true,
    trim: true
  },

  referralCode: {
    type: String,
    required: true,
    trim: true
  },

  // PENDING: code applied at registration, no qualifying order yet.
  // QUALIFIED: referred customer placed an order that reached DELIVERED.
  // COMPLETED: rewards actually credited to both sides.
  // REJECTED: failed fraud checks (see utils/loyaltyReferral.js).
  status: {
    type: String,
    enum: ['PENDING', 'QUALIFIED', 'COMPLETED', 'REJECTED'],
    default: 'PENDING'
  },
  rejectionReason: {
    type: String,
    default: null
  },

  qualifyingOrderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null
  },

  referrerReward: {
    points: { type: Number, default: 0 },
    status: { type: String, enum: ['PENDING', 'CREDITED'], default: 'PENDING' }
  },
  referredReward: {
    // The referred customer's welcome benefit is issued as a redemption
    // (a ready-to-use voucher), not raw points - couponValue is its
    // discount value for display before that redemption exists.
    couponValue: { type: Number, default: 0 },
    status: { type: String, enum: ['PENDING', 'CREDITED'], default: 'PENDING' },
    redemptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'LoyaltyRedemption', default: null }
  },

  completedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  collection: 'loyalty_referrals'
});

loyaltyReferralSchema.index({ referrerMobile: 1 });
// One referral record per referred customer - a mobile can only ever be
// "the referred person" once, which is also the primary anti-abuse guard
// (see loyalty_rewards_frd.md section 18.2).
loyaltyReferralSchema.index({ referredMobile: 1 }, { unique: true });

module.exports = require('./tenantModel')('LoyaltyReferral', loyaltyReferralSchema);
