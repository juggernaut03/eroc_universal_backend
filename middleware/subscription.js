/**
 * Tenant subscription enforcement.
 *
 * attachSubscription must run AFTER the tenant resolver (needs req.tenant),
 * and requireActiveSubscription / enforceResourceLimit must run AFTER
 * attachSubscription (need req.subscriptionStatus). Both are mounted once for
 * the whole admin surface in routes/admin.js rather than per route — an
 * expired tenant is locked out of every /api/admin endpoint, not just the two
 * product-create ones that were gated when this shipped.
 *
 * Deliberately NOT applied to the customer-facing API: an expired subscription
 * locks the tenant's admins out of the panel, it does not stop that tenant's
 * shoppers from browsing or checking out.
 */
const { getEffectiveSubscription, computeSubscriptionStatus, countTenantProducts } = require('../utils/subscription');

// The effective subscription now sits in front of every admin request, so the
// naive version would add a control-DB round trip to all 189 of them. Cache it
// briefly per project. Only the document is cached — isExpired/daysRemaining
// are still recomputed from end_date on every request, so an expiry that falls
// mid-window takes effect immediately; it is only a *change* to the row that
// can lag, and the subscription write routes call invalidateSubscriptionCache
// so renewals apply at once rather than after the TTL.
const CACHE_TTL_MS = 30 * 1000;
const subscriptionCache = new Map();

const readCache = (projectCode) => {
  const hit = subscriptionCache.get(projectCode);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    subscriptionCache.delete(projectCode);
    return undefined;
  }
  return hit.sub;
};

const invalidateSubscriptionCache = (projectCode) => {
  if (projectCode) {
    subscriptionCache.delete(String(projectCode).toUpperCase());
  } else {
    subscriptionCache.clear();
  }
};

// Loads the current tenant's subscription and attaches it to the request.
// Fail-open by design: a tenant with no subscription row configured, or a
// lookup that throws, must never lock anyone out — it leaves
// req.subscriptionStatus in its "no subscription" shape and moves on. Only a
// subscription that exists AND has expired blocks anything.
const attachSubscription = async (req, res, next) => {
  try {
    const projectCode = req.tenant?.projectCode;
    let sub = null;

    if (projectCode) {
      const key = String(projectCode).toUpperCase();
      const cached = readCache(key);
      if (cached !== undefined) {
        sub = cached;
      } else {
        sub = await getEffectiveSubscription(key);
        subscriptionCache.set(key, { sub, expiresAt: Date.now() + CACHE_TTL_MS });
      }
    }

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
//
// Super admins are exempt, matching how checkPermission and requireProjectAccess
// already short-circuit for them: an expired tenant is exactly the tenant a
// super admin needs to be able to open in order to inspect and renew it.
const requireActiveSubscription = (req, res, next) => {
  if (req.user?.isSuperAdmin) return next();

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
      if (req.user?.isSuperAdmin) return next();

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
  invalidateSubscriptionCache,
};
