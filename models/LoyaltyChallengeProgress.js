const mongoose = require('mongoose');

// Per-customer progress against one challenge. See
// loyalty_rewards_frd.md sections 19, 35.
const loyaltyChallengeProgressSchema = new mongoose.Schema({
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
  challengeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LoyaltyChallenge',
    required: true
  },

  currentValue: {
    type: Number,
    default: 0
  },
  targetValue: {
    type: Number,
    required: true
  },

  status: {
    type: String,
    enum: ['IN_PROGRESS', 'COMPLETED', 'CLAIMED', 'EXPIRED'],
    default: 'IN_PROGRESS'
  },

  completedAt: {
    type: Date,
    default: null
  },
  claimedAt: {
    type: Date,
    default: null
  },

  // Guards against double-counting the same order if its delivered-hook
  // fires more than once (see utils/loyaltyChallengeEngine.js).
  lastOrderId: {
    type: String,
    default: null
  }
}, {
  timestamps: true,
  collection: 'loyalty_challenge_progress'
});

loyaltyChallengeProgressSchema.index({ mobile: 1, challengeId: 1 }, { unique: true });
loyaltyChallengeProgressSchema.index({ mobile: 1, status: 1 });

module.exports = require('./tenantModel')('LoyaltyChallengeProgress', loyaltyChallengeProgressSchema);
