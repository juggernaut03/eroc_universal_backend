const mongoose = require('mongoose');

// Admin-configurable earning rules. One row per event type - e.g. the
// PURCHASE_POINTS rule fires on ORDER_DELIVERED, REGISTRATION_POINTS fires
// once per account. See loyalty_rewards_frd.md section 29.
const loyaltyRuleSchema = new mongoose.Schema({
  code: {
    type: String,
    required: [true, 'Rule code is required'],
    trim: true,
    unique: true
  },
  name: {
    type: String,
    required: [true, 'Rule name is required'],
    trim: true
  },

  event: {
    type: String,
    enum: [
      'REGISTRATION', 'FIRST_ORDER', 'ORDER_DELIVERED', 'PRODUCT_REVIEW',
      'PHOTO_REVIEW', 'REFERRAL', 'BIRTHDAY', 'FIRST_APP_ORDER'
    ],
    required: true
  },

  // FIXED: pointsValue awarded flat, regardless of order amount.
  // FIXED_PER_AMOUNT: pointsValue points per amountValue of order value
  // (e.g. 10 points per Rs.100 -> pointsValue=10, amountValue=100).
  pointsType: {
    type: String,
    enum: ['FIXED', 'FIXED_PER_AMOUNT'],
    required: true,
    default: 'FIXED'
  },
  pointsValue: {
    type: Number,
    required: true,
    min: 0
  },
  amountValue: {
    type: Number,
    default: 100,
    min: 1
  },

  // Base rule multiplier, separate from a customer's tier multiplier and any
  // active campaign multiplier - see calculatePoints() in
  // utils/loyaltyEngine.js for how the three combine.
  multiplier: {
    type: Number,
    default: 1
  },

  minimumOrderValue: {
    type: Number,
    default: 0
  },
  maximumPoints: {
    type: Number,
    default: null
  },

  // Only meaningful for ORDER_DELIVERED-type rules.
  eligibleOrderStatuses: {
    type: [String],
    default: ['delivered']
  },

  // Days after delivery before pending points from this rule become
  // available. 0 = credited as available immediately.
  pendingPeriodDays: {
    type: Number,
    default: 7,
    min: 0
  },

  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE'
  },

  validFrom: {
    type: Date,
    default: null
  },
  validUntil: {
    type: Date,
    default: null
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true,
  collection: 'loyalty_rules'
});

loyaltyRuleSchema.index({ event: 1, status: 1 });

module.exports = require('./tenantModel')('LoyaltyRule', loyaltyRuleSchema);
