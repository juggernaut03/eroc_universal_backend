const mongoose = require('mongoose');

// Every admin action that touches loyalty configuration or a customer's
// balance gets a row here, independent of the ledger (LoyaltyTransaction
// already records the balance-changing side of an ADJUSTMENT; this records
// the *administrative* side - who, why, what changed). See
// loyalty_rewards_frd.md sections 3.1 (audit logging in scope), 71.
const loyaltyAuditLogSchema = new mongoose.Schema({
  action: {
    type: String,
    enum: [
      'POINTS_ADJUSTMENT', 'ACCOUNT_SUSPENDED', 'ACCOUNT_ACTIVATED',
      'RULE_CREATED', 'RULE_UPDATED', 'REWARD_CREATED', 'REWARD_UPDATED',
      'REWARD_DELETED', 'TIER_CREATED', 'TIER_UPDATED', 'CAMPAIGN_CREATED',
      'CAMPAIGN_UPDATED', 'CAMPAIGN_DELETED', 'CHALLENGE_CREATED',
      'CHALLENGE_UPDATED', 'CHALLENGE_DELETED', 'REDEMPTION_CANCELLED'
    ],
    required: true
  },

  targetType: {
    type: String,
    enum: [
      'LoyaltyAccount', 'LoyaltyRule', 'LoyaltyReward', 'LoyaltyTier',
      'LoyaltyCampaign', 'LoyaltyChallenge', 'LoyaltyRedemption'
    ],
    required: true
  },
  targetId: {
    type: String,
    required: true
  },

  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  reason: {
    type: String,
    default: ''
  },

  before: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  after: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  }
}, {
  timestamps: true,
  collection: 'loyalty_audit_logs'
});

loyaltyAuditLogSchema.index({ targetType: 1, targetId: 1 });
loyaltyAuditLogSchema.index({ createdAt: -1 });
loyaltyAuditLogSchema.index({ performedBy: 1 });

module.exports = require('./tenantModel')('LoyaltyAuditLog', loyaltyAuditLogSchema);
