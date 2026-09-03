// tests/subscription-gate.test.js
//
// Runs with plain `node tests/subscription-gate.test.js` — no database: the
// gate is pure over req.subscriptionStatus, which attachSubscription fills in.
//
// What is being pinned: the subscription gate originally sat on exactly two
// routes (POST /api/admin/products and /products/master), so an admin whose
// tenant subscription had expired could still list orders, change order
// status and download procurement reports — 187 of the 189 admin routes were
// ungated. It is now mounted once on the admin router, which makes three
// properties load-bearing and easy to regress:
//
//   1. fail-open — a tenant with no subscription row must not be locked out,
//      or mounting the gate globally would lock out every existing tenant;
//   2. super admins are exempt — an expired tenant is precisely the one a
//      super admin must be able to open in order to renew it;
//   3. only expiry blocks — "no subscription" is not "expired".

const assert = require('assert');
const {
  requireActiveSubscription,
  enforceResourceLimit,
} = require('../middleware/subscription');
const { computeSubscriptionStatus } = require('../utils/subscription');

const DAY = 24 * 60 * 60 * 1000;
const sub = (overrides = {}) => ({
  end_date: new Date(Date.now() + 30 * DAY),
  product_limit: 100,
  status: 'active',
  ...overrides,
});

// Minimal res double: records the status/body a middleware responded with.
const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

const run = (middleware, req) => {
  const res = makeRes();
  let nexted = false;
  middleware(req, res, () => {
    nexted = true;
  });
  return { nexted, res };
};

const runAsync = async (middleware, req) => {
  const res = makeRes();
  let nexted = false;
  await middleware(req, res, () => {
    nexted = true;
  });
  return { nexted, res };
};

const tests = {
  'a tenant with no subscription configured is not treated as expired'() {
    const status = computeSubscriptionStatus(null);
    assert.strictEqual(status.hasSubscription, false);
    assert.strictEqual(status.isExpired, false);
    assert.strictEqual(status.productLimit, null);

    const { nexted } = run(requireActiveSubscription, {
      user: { isSuperAdmin: false },
      subscriptionStatus: status,
    });
    assert.strictEqual(nexted, true);
  },

  'a live subscription passes the gate'() {
    const status = computeSubscriptionStatus(sub());
    assert.strictEqual(status.isExpired, false);
    assert.ok(status.daysRemaining > 0);

    const { nexted } = run(requireActiveSubscription, {
      user: { isSuperAdmin: false },
      subscriptionStatus: status,
    });
    assert.strictEqual(nexted, true);
  },

  'an expired subscription blocks with SUBSCRIPTION_EXPIRED'() {
    const status = computeSubscriptionStatus(
      sub({ end_date: new Date(Date.now() - DAY) })
    );
    assert.strictEqual(status.isExpired, true);

    const { nexted, res } = run(requireActiveSubscription, {
      user: { isSuperAdmin: false },
      subscriptionStatus: status,
    });
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'SUBSCRIPTION_EXPIRED');
    assert.strictEqual(res.body.success, false);
  },

  'a super admin is exempt from an expired subscription'() {
    const status = computeSubscriptionStatus(
      sub({ end_date: new Date(Date.now() - 365 * DAY) })
    );
    const { nexted, res } = run(requireActiveSubscription, {
      user: { isSuperAdmin: true },
      subscriptionStatus: status,
    });
    assert.strictEqual(nexted, true);
    assert.strictEqual(res.statusCode, null);
  },

  'expiry is computed from end_date, not from the stored status field'() {
    // check_subscription_expiry.js may not have run; enforcement must not
    // depend on it having flipped `status` to 'expired'.
    const stale = computeSubscriptionStatus(
      sub({ end_date: new Date(Date.now() - DAY), status: 'active' })
    );
    assert.strictEqual(stale.isExpired, true);

    const { nexted, res } = run(requireActiveSubscription, {
      user: { isSuperAdmin: false },
      subscriptionStatus: stale,
    });
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 403);
  },

  'a missing user object does not crash the gate'() {
    // The gate is mounted after protect, so req.user is always present in
    // production — but it must not throw if that ordering ever changes.
    const { nexted } = run(requireActiveSubscription, {
      subscriptionStatus: computeSubscriptionStatus(null),
    });
    assert.strictEqual(nexted, true);
  },

  async 'a resource limit blocks once the count reaches it'() {
    const limiter = enforceResourceLimit({
      countFn: async () => 100,
      limitField: 'productLimit',
      resourceName: 'Product',
    });
    const { nexted, res } = await runAsync(limiter, {
      user: { isSuperAdmin: false },
      subscriptionStatus: computeSubscriptionStatus(sub({ product_limit: 100 })),
    });
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'RESOURCE_LIMIT_REACHED');
  },

  async 'a resource limit allows the request below it'() {
    const limiter = enforceResourceLimit({
      countFn: async () => 99,
      limitField: 'productLimit',
      resourceName: 'Product',
    });
    const { nexted } = await runAsync(limiter, {
      user: { isSuperAdmin: false },
      subscriptionStatus: computeSubscriptionStatus(sub({ product_limit: 100 })),
    });
    assert.strictEqual(nexted, true);
  },

  async 'no limit configured fails open'() {
    const limiter = enforceResourceLimit({
      countFn: async () => {
        throw new Error('countFn must not be called when there is no limit');
      },
      limitField: 'productLimit',
      resourceName: 'Product',
    });
    const { nexted } = await runAsync(limiter, {
      user: { isSuperAdmin: false },
      subscriptionStatus: computeSubscriptionStatus(null),
    });
    assert.strictEqual(nexted, true);
  },

  async 'a counting failure fails open rather than blocking the write'() {
    const limiter = enforceResourceLimit({
      countFn: async () => {
        throw new Error('mongo is down');
      },
      limitField: 'productLimit',
      resourceName: 'Product',
    });
    const { nexted } = await runAsync(limiter, {
      user: { isSuperAdmin: false },
      subscriptionStatus: computeSubscriptionStatus(sub({ product_limit: 1 })),
    });
    assert.strictEqual(nexted, true);
  },
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${error.message}`);
    }
  }

  const total = Object.keys(tests).length;
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed === 0 ? 0 : 1);
})();
