const { getSubscriptionModel } = require('../models/Subscription');
const Product = require('../models/Product');
const ProductMaster = require('../models/ProductMaster');

// The subscription period "in effect right now" for a project: the most
// recent non-cancelled period whose start_date has already begun. Periods
// are append-only history (see models/Subscription.js) — this is a read-time
// lookup, never a mutation.
const getEffectiveSubscription = async (projectCode) => {
  const Subscription = getSubscriptionModel();
  return Subscription.findOne({
    project_code: String(projectCode).toUpperCase(),
    status: { $ne: 'cancelled' },
    start_date: { $lte: new Date() },
  })
    .sort({ start_date: -1 })
    .limit(1);
};

// Derives the enforcement-relevant status from an effective subscription doc.
// isExpired/daysRemaining are always computed live from end_date vs now —
// the stored `status` field is a display/notification convenience updated by
// scripts/check_subscription_expiry.js, not the source of truth, so
// enforcement stays correct even if that cron hasn't run recently.
const computeSubscriptionStatus = (sub) => {
  if (!sub) {
    // Fail-open shape: no subscription configured yet must never look "expired".
    return {
      hasSubscription: false,
      isExpired: false,
      isCancelled: false,
      daysRemaining: 0,
      productLimit: null,
    };
  }

  const now = new Date();
  const msRemaining = new Date(sub.end_date).getTime() - now.getTime();
  const daysRemaining = Math.ceil(msRemaining / (24 * 60 * 60 * 1000));

  return {
    hasSubscription: true,
    isExpired: msRemaining < 0,
    isCancelled: sub.status === 'cancelled',
    daysRemaining,
    productLimit: sub.product_limit,
  };
};

// Total product count for the current tenant, across both catalogue models.
// Must be called from within a request already routed through tenantResolver
// (Product/ProductMaster resolve the active tenant DB via the ALS proxy).
const countTenantProducts = async () => {
  const [productCount, productMasterCount] = await Promise.all([
    Product.countDocuments({}),
    ProductMaster.countDocuments({}),
  ]);
  return productCount + productMasterCount;
};

module.exports = { getEffectiveSubscription, computeSubscriptionStatus, countTenantProducts };
