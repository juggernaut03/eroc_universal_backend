const mongoose = require('mongoose');
const { getControlDb } = require('../config/database');

// Tenant subscription/billing periods — lives in the control DB, NOT in any
// tenant DB (shared superadmin data, same reasoning as Project.js). This is
// an append-only history: one document per billing period. "Renewing" a
// subscription means inserting a new document, never mutating a past one —
// see utils/subscription.js#getEffectiveSubscription.
const subscriptionSchema = new mongoose.Schema(
  {
    project_code: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    start_date: {
      type: Date,
      required: true,
    },
    end_date: {
      type: Date,
      required: true,
    },
    product_limit: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ['active', 'upcoming', 'expired', 'cancelled'],
      default: 'active',
    },
    // Dedupe for the 7/3/1-day expiry warning pushes (scripts/check_subscription_expiry.js),
    // scoped to this one period — a fresh renewal starts with an empty array.
    notified_stages: {
      type: [Number],
      default: [],
    },
    notes: {
      type: String,
      default: '',
    },
    // Denormalized rather than a Mongoose ref — the control DB has no clean
    // ref path to a tenant-DB or admin-home-DB User document.
    created_by_name: {
      type: String,
      default: '',
    },
    created_by_email: {
      type: String,
      default: '',
    },
    cancelled_at: {
      type: Date,
    },
    cancelled_by_name: {
      type: String,
      default: '',
    },
  },
  { timestamps: true, collection: 'subscriptions' }
);

subscriptionSchema.index({ project_code: 1, start_date: -1 });

// Compiled on the control connection (not a tenant proxy).
const getSubscriptionModel = () => {
  const controlDb = getControlDb();
  return controlDb.models.Subscription || controlDb.model('Subscription', subscriptionSchema);
};

module.exports = { getSubscriptionModel, subscriptionSchema };
