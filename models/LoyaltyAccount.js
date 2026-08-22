const mongoose = require('mongoose');

// One account per customer. Unlike most loyalty-system reference designs
// (including the FRD this was built from), every other customer-owned
// collection in this codebase - Order, AddressBook, Favorite, Cart - is
// joined by the plain `mobile` string, not by `User._id`. Points are earned
// primarily off Order events, which only carry `mobile_no`, so this account
// is keyed the same way for a direct, index-friendly join. `userId` is kept
// alongside purely for admin-panel display/lookup convenience.
const loyaltyAccountSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  mobile: {
    type: String,
    required: [true, 'Mobile number is required'],
    trim: true,
    unique: true
  },

  availablePoints: {
    type: Number,
    default: 0,
    min: 0
  },
  pendingPoints: {
    type: Number,
    default: 0,
    min: 0
  },

  lifetimeEarnedPoints: {
    type: Number,
    default: 0
  },
  lifetimeRedeemedPoints: {
    type: Number,
    default: 0
  },
  lifetimeExpiredPoints: {
    type: Number,
    default: 0
  },
  lifetimeReversedPoints: {
    type: Number,
    default: 0
  },

  // Sum of order value that counts toward tier progression. Distinct from
  // lifetimeEarnedPoints because tier rules and point-earning rules are
  // independently configurable (see loyalty_rewards_frd.md section 16).
  eligibleLifetimeSpend: {
    type: Number,
    default: 0
  },

  currentTierCode: {
    type: String,
    default: null
  },
  tierProgress: {
    currentSpend: { type: Number, default: 0 },
    nextTierCode: { type: String, default: null },
    nextTierSpend: { type: Number, default: null },
    percentage: { type: Number, default: 0 }
  },

  // Every account gets a stable referral code the moment it's created -
  // simpler than a second collection for a 1:1 attribute.
  referralCode: {
    type: String,
    unique: true,
    sparse: true
  },

  status: {
    type: String,
    enum: ['ACTIVE', 'SUSPENDED'],
    default: 'ACTIVE'
  },
  suspendedReason: {
    type: String,
    default: null
  }
}, {
  timestamps: true,
  collection: 'loyalty_accounts'
});

loyaltyAccountSchema.index({ mobile: 1 }, { unique: true });
loyaltyAccountSchema.index({ userId: 1 });
loyaltyAccountSchema.index({ currentTierCode: 1 });

module.exports = require('./tenantModel')('LoyaltyAccount', loyaltyAccountSchema);
