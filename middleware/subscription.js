/**
 * Tenant subscription enforcement.
 * attachSubscription must run AFTER the tenant resolver (needs req.tenant),
 * and requireActiveSubscription / enforceResourceLimit must run AFTER
 * attachSubscription (need req.subscriptionStatus).
 */
const { getEffectiveSubscription, computeSubscriptionStatus, countTenantProducts } = require('../utils/subscription');

// Loads the current tenant's subscription and attaches it to the request.
// Fail-open by design: every tenant currently has zero subscription rows, so
// any lookup failure (or simply no subscription configured) must never block
// the request — it just leaves req.subscriptionStatus in its "no subscription"
// shape and moves on.
const attachSubscription = async (req, res, next) => {
  try {
    const projectCode = req.tenant?.projectCode;
    const sub = projectCode ? await getEffectiveSubscription(projectCode) : null;
    req.subscription = sub;
    req.subscriptionStatus = computeSubscriptionStatus(sub);
  } catch (error) {
    console.warn('[subscription] Failed to attach subscription:', error.message);
    req.subscription = null;
    req.subscriptionStatus = computeSubscriptionStatus(null);
  }
  next();
};

// Blocks a request only when a subscription IS configured and it has expired.
// No subscription configured at all is not the same as expired (fail-open).
const requireActiveSubscription = (req, res, next) => {
  if (req.subscriptionStatus?.hasSubscription && req.subscriptionStatus.isExpired) {
    return res.status(403).json({
      success: false,
      message: 'Your subscription has expired. Please contact support to renew.',
      code: 'SUBSCRIPTION_EXPIRED',
    });
  }
  next();
};

// Factory for a resource-count limit middleware, keyed off a field on
// req.subscriptionStatus (e.g. 'productLimit'). No limit configured (limit
// is null/undefined) fails open.
const enforceResourceLimit = ({ countFn, limitField, resourceName }) => {
  return async (req, res, next) => {
    try {
      const limit = req.subscriptionStatus?.[limitField];
      if (limit == null) {
        return next();
      }

      const count = await countFn();
      if (count >= limit) {
        return res.status(403).json({
          success: false,
          code: 'RESOURCE_LIMIT_REACHED',
          message: `${resourceName} limit of ${limit} reached for this plan.`,
        });
      }

      next();
    } catch (error) {
      console.warn(`[subscription] Failed to enforce ${resourceName} limit:`, error.message);
      next();
    }
  };
};

const enforceProductLimit = () => enforceResourceLimit({
  countFn: countTenantProducts,
  limitField: 'productLimit',
  resourceName: 'Product',
});

module.exports = {
  attachSubscription,
  requireActiveSubscription,
  enforceResourceLimit,
  enforceProductLimit,
};
