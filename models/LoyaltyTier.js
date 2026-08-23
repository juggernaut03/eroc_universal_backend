const mongoose = require('mongoose');

// VIP tier ladder. See loyalty_rewards_frd.md sections 14-17, 32.
const loyaltyTierSchema = new mongoose.Schema({
  code: {
    type: String,
    required: [true, 'Tier code is required'],
    trim: true,
    uppercase: true,
    unique: true
  },
  name: {
    type: String,
    required: [true, 'Tier name is required'],
    trim: true
  },

  // maximumSpend is null on the top tier (no ceiling).
  minimumSpend: {
    type: Number,
    required: true,
    min: 0
  },
  maximumSpend: {
    type: Number,
    default: null
  },

  pointMultiplier: {
    type: Number,
    required: true,
    default: 1,
    min: 1
  },

  benefits: {
    type: [{
      type: {
        type: String,
        enum: [
          'POINT_MULTIPLIER', 'FREE_SHIPPING', 'EARLY_ACCESS',
          'BIRTHDAY_BONUS', 'EXCLUSIVE_REWARDS', 'PRIORITY_SUPPORT'
        ]
      },
      value: { type: mongoose.Schema.Types.Mixed }
    }],
    default: []
  },

  // Lower rank = lower tier. Used to order tiers and to detect
  // upgrade/downgrade direction when recalculating (see
  // utils/loyaltyTierEngine.js).
  rank: {
    type: Number,
    required: true
  },

  // Physical-card styling for this tier (loyalty card front/back, mobile
  // app) - admin-configurable per tier so e.g. Gold looks distinct from
  // Bronze, matching how real membership cards escalate visually with
  // status. Hex colors; sane per-tier defaults are seeded by
  // scripts/seed_loyalty_defaults.js but every tier is editable
  // independently from Admin > Loyalty > Tiers.
  cardPrimaryColor: {
    type: String,
    default: '#1A1A1A',
    trim: true
  },
  cardAccentColor: {
    type: String,
    default: '#D4AF37',
    trim: true
  },

  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE'
  }
}, {
  timestamps: true,
  collection: 'loyalty_tiers'
});

loyaltyTierSchema.index({ rank: 1 });
loyaltyTierSchema.index({ minimumSpend: 1 });

module.exports = require('./tenantModel')('LoyaltyTier', loyaltyTierSchema);
