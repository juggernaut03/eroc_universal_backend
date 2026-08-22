const mongoose = require('mongoose');

// Reward catalog. See loyalty_rewards_frd.md sections 10-11, 30.
//
// FIXED_DISCOUNT, PERCENTAGE_DISCOUNT and FREE_SHIPPING are fully wired
// end-to-end: redeeming one produces a LoyaltyRedemption that a customer can
// apply at checkout (see routes/loyalty.js and utils/loyaltyRedemption.js).
// CASHBACK is treated identically to FIXED_DISCOUNT (this codebase has no
// wallet/cashback ledger to credit into). FREE_PRODUCT and SPECIAL_OFFER can
// be created and browsed for catalog completeness but are not yet wired to
// attach a free line item or a bespoke offer at checkout - redeeming one
// deducts points and issues a redemption record, but applying it is a manual
// admin/support fulfillment step for now.
const loyaltyRewardSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Reward name is required'],
    trim: true
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  image: {
    type: String,
    default: null
  },

  type: {
    type: String,
    enum: [
      'FIXED_DISCOUNT', 'PERCENTAGE_DISCOUNT', 'FREE_SHIPPING',
      'CASHBACK', 'FREE_PRODUCT', 'SPECIAL_OFFER'
    ],
    required: true
  },

  pointsRequired: {
    type: Number,
    required: true,
    min: 1
  },

  // Rupee value for FIXED_DISCOUNT/CASHBACK; percentage (0-100) for
  // PERCENTAGE_DISCOUNT. Unused for FREE_SHIPPING.
  discountValue: {
    type: Number,
    default: 0,
    min: 0
  },

  minimumOrderValue: {
    type: Number,
    default: 0
  },
  // Caps the rupee discount a PERCENTAGE_DISCOUNT can produce. Ignored for
  // FIXED_DISCOUNT (the discount value itself is already the cap).
  maximumDiscount: {
    type: Number,
    default: null
  },

  usageLimit: {
    type: Number,
    default: null
  },
  usedCount: {
    type: Number,
    default: 0
  },
  perUserLimit: {
    type: Number,
    default: null
  },

  applicableCategories: {
    type: [mongoose.Schema.Types.ObjectId],
    default: []
  },
  applicableProducts: {
    type: [String],
    default: []
  },
  // Tier codes (e.g. ['GOLD','PLATINUM']) - empty means every tier/no tier
  // requirement.
  applicableTiers: {
    type: [String],
    default: []
  },

  validFrom: {
    type: Date,
    default: null
  },
  validUntil: {
    type: Date,
    default: null
  },

  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE'
  }
}, {
  timestamps: true,
  collection: 'loyalty_rewards'
});

loyaltyRewardSchema.index({ status: 1, pointsRequired: 1 });

module.exports = require('./tenantModel')('LoyaltyReward', loyaltyRewardSchema);
