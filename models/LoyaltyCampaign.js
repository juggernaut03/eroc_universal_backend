const mongoose = require('mongoose');

// Temporary multiplier campaigns (e.g. "Diwali Double Points"). See
// loyalty_rewards_frd.md sections 20, 33.
const loyaltyCampaignSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Campaign name is required'],
    trim: true
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },

  multiplier: {
    type: Number,
    required: true,
    min: 1
  },

  minimumOrderValue: {
    type: Number,
    default: 0
  },

  applicableProducts: {
    type: [String],
    default: []
  },
  applicableCategories: {
    type: [mongoose.Schema.Types.ObjectId],
    default: []
  },
  applicableTiers: {
    type: [String],
    default: []
  },

  maximumBonusPoints: {
    type: Number,
    default: null
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
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true,
  collection: 'loyalty_campaigns'
});

loyaltyCampaignSchema.index({ status: 1, validFrom: 1, validUntil: 1 });

module.exports = require('./tenantModel')('LoyaltyCampaign', loyaltyCampaignSchema);
