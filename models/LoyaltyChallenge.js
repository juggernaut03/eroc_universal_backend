const mongoose = require('mongoose');

// Gamified challenge definitions. See loyalty_rewards_frd.md sections 19, 34.
//
// PURCHASE_COUNT: place N orders. SPEND_AMOUNT: cumulative order value in
// the challenge window reaches targetValue. CATEGORY_COUNT: order from N
// distinct categories. FIRST_APP_ORDER: complete the first order at all
// (targetValue is ignored, treated as 1).
const loyaltyChallengeSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Challenge name is required'],
    trim: true
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },

  type: {
    type: String,
    enum: ['PURCHASE_COUNT', 'SPEND_AMOUNT', 'CATEGORY_COUNT', 'FIRST_APP_ORDER'],
    required: true
  },

  targetValue: {
    type: Number,
    required: true,
    min: 1
  },

  rewardPoints: {
    type: Number,
    required: true,
    min: 0
  },

  validFrom: {
    type: Date,
    required: true
  },
  validUntil: {
    type: Date,
    required: true
  },

  status: {
    type: String,
    enum: ['ACTIVE', 'INACTIVE'],
    default: 'ACTIVE'
  }
}, {
  timestamps: true,
  collection: 'loyalty_challenges'
});

loyaltyChallengeSchema.index({ status: 1, validFrom: 1, validUntil: 1 });

module.exports = require('./tenantModel')('LoyaltyChallenge', loyaltyChallengeSchema);
