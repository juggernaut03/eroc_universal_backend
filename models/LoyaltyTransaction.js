const mongoose = require('mongoose');

// The ledger. This is the source of truth and auditability for every point
// movement - balances on LoyaltyAccount are a cache of this collection, never
// the other way around. Never delete or mutate a row after creation; a
// correction is always a new row (REVERSAL/ADJUSTMENT), per
// loyalty_rewards_frd.md section 24.
const loyaltyTransactionSchema = new mongoose.Schema({
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
  loyaltyAccountId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LoyaltyAccount',
    required: true
  },

  type: {
    type: String,
    enum: ['CREDIT', 'DEBIT', 'EXPIRATION', 'REVERSAL', 'ADJUSTMENT'],
    required: true
  },
  source: {
    type: String,
    enum: [
      'ORDER', 'REVIEW', 'REFERRAL', 'BIRTHDAY', 'REGISTRATION',
      'CAMPAIGN', 'CHALLENGE', 'REDEMPTION', 'REFUND', 'ADMIN'
    ],
    required: true
  },

  // Always the magnitude of the movement; direction comes from `type`.
  // balanceAfter - balanceBefore derives the signed delta, kept explicit
  // here rather than storing a signed points value so a report summing
  // "points issued" never has to branch on type.
  points: {
    type: Number,
    required: true,
    min: 0
  },

  balanceBefore: {
    type: Number,
    required: true
  },
  balanceAfter: {
    type: Number,
    required: true
  },

  // What this transaction is about (an order id, a redemption id, a
  // referral id...) - loose string so one field covers every source.
  referenceId: {
    type: String,
    default: null
  },

  // Uniquely identifies the *event* that produced this row, e.g.
  // "ORDER_<orderId>_PURCHASE_POINTS" or "ORDER_<orderId>_CANCEL_REVERSAL".
  // The unique index is what makes crediting idempotent - re-processing the
  // same order-delivered event twice (a retried webhook, a re-run script)
  // throws E11000 on the second insert instead of double-crediting.
  idempotencyKey: {
    type: String,
    required: true
  },

  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },

  // PENDING: earned but not yet spendable (e.g. inside the return window).
  // COMPLETED: counted in availablePoints. REVERSED: clawed back before ever
  // becoming available (order cancelled during its pending window).
  status: {
    type: String,
    enum: ['PENDING', 'COMPLETED', 'REVERSED'],
    default: 'COMPLETED'
  },

  // When a PENDING credit becomes spendable (return-window end) or when a
  // COMPLETED credit expires. Two different meanings depending on `status` -
  // see utils/loyaltyEngine.js's promotePendingPoints / expirePoints.
  availableAt: {
    type: Date,
    default: null
  },
  expiresAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true,
  collection: 'loyalty_transactions'
});

loyaltyTransactionSchema.index({ mobile: 1, createdAt: -1 });
loyaltyTransactionSchema.index({ idempotencyKey: 1 }, { unique: true });
loyaltyTransactionSchema.index({ referenceId: 1 });
loyaltyTransactionSchema.index({ expiresAt: 1, status: 1 });
loyaltyTransactionSchema.index({ availableAt: 1, status: 1 });

module.exports = require('./tenantModel')('LoyaltyTransaction', loyaltyTransactionSchema);
