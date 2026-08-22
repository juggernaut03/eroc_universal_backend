const mongoose = require('mongoose');

// One row per points-for-reward exchange. See loyalty_rewards_frd.md
// sections 12-13, 31.
//
// Snapshots the reward's discount shape at redemption time (name/type/
// discountValue/maximumDiscount/minimumOrderValue) so a later admin edit to
// the reward catalog can never retroactively change what an already-issued
// voucher is worth - the redemption is the contract, not a live reference.
const loyaltyRedemptionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  mobile: {
    type: String,
    required: [true, 'Mobile number is required'],
    trim: true
  },

  rewardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LoyaltyReward',
    required: true
  },
  pointsSpent: {
    type: Number,
    required: true,
    min: 0
  },

  // Short, human-shown reference - not used for any checkout "enter a code"
  // flow (this codebase doesn't have one), just a display/support-lookup
  // handle, e.g. "LOY-A1B2C3".
  couponCode: {
    type: String,
    required: true,
    unique: true
  },

  rewardSnapshot: {
    name: { type: String },
    type: { type: String },
    discountValue: { type: Number, default: 0 },
    maximumDiscount: { type: Number, default: null },
    minimumOrderValue: { type: Number, default: 0 }
  },

  // ACTIVE: unused, available to apply at checkout.
  // USED: applied to an order (see orderId/usedAt).
  // EXPIRED: passed expiresAt without being used.
  // CANCELLED: reversed by admin/support (points refunded).
  status: {
    type: String,
    enum: ['ACTIVE', 'USED', 'EXPIRED', 'CANCELLED'],
    default: 'ACTIVE'
  },

  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null
  },
  usedAt: {
    type: Date,
    default: null
  },

  expiresAt: {
    type: Date,
    required: true
  }
}, {
  timestamps: true,
  collection: 'loyalty_redemptions'
});

loyaltyRedemptionSchema.index({ mobile: 1, status: 1 });
// couponCode already has unique:true on the field, which creates its index.
loyaltyRedemptionSchema.index({ expiresAt: 1, status: 1 });

module.exports = require('./tenantModel')('LoyaltyRedemption', loyaltyRedemptionSchema);
