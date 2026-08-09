// tests/order-status-history.test.js
//
// Runs with plain `node tests/order-status-history.test.js` — no database,
// because the timeline helpers are pure over a plain order-shaped object.
//
// What is being pinned: orders placed before status_history existed carry no
// recorded timeline, only the timestamps order_placed_at / order_confirmed_at /
// order_completed_at / cancelled_at. buildTimeline() reconstructs a timeline
// from those, and the first real status change on such an order must keep the
// reconstructed steps — an earlier version replaced them with the single new
// entry, so accepting a months-old order made its whole history disappear.

const assert = require('assert');

const {
  buildHistoryEntry,
  deriveTimeline,
  buildTimeline,
} = require('../utils/orderStatusHistory');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const at = (iso) => new Date(iso);

// A legacy order: delivered, with only the timestamps such orders carry.
const legacyOrder = () => ({
  order_status: 'delivered',
  order_placed_at: at('2026-08-04T07:05:45Z'),
  order_confirmed_at: at('2026-08-04T07:06:25Z'),
  order_completed_at: at('2026-08-04T07:08:16Z'),
  last_updated_at: at('2026-08-04T07:08:16Z'),
});

const statuses = (timeline) => timeline.map((entry) => entry.status);

test('a legacy order gets a timeline derived from its timestamps', () => {
  const timeline = buildTimeline(legacyOrder());
  assert.deepStrictEqual(statuses(timeline), ['pending', 'accepted', 'delivered']);
  assert.ok(timeline.every((entry) => entry.derived), 'every entry is flagged derived');
});

test('derived entries are ordered and linked by from_status', () => {
  const timeline = buildTimeline(legacyOrder());
  assert.strictEqual(timeline[0].from_status, undefined, 'the first step comes from nothing');
  assert.strictEqual(timeline[1].from_status, 'pending');
  assert.strictEqual(timeline[2].from_status, 'accepted');
});

test('a status with no matching timestamp still appears, via last_updated_at', () => {
  const timeline = buildTimeline({
    order_status: 'in_packaging',
    order_placed_at: at('2026-08-01T10:00:00Z'),
    last_updated_at: at('2026-08-02T11:00:00Z'),
  });
  assert.deepStrictEqual(statuses(timeline), ['pending', 'in_packaging']);
  assert.strictEqual(
    timeline[1].changed_at.toISOString(),
    '2026-08-02T11:00:00.000Z'
  );
});

test('no timestamp produces no entry — steps are never invented', () => {
  // Never confirmed, so there is no "accepted" step to show.
  const timeline = buildTimeline({
    order_status: 'cancelled',
    order_placed_at: at('2026-08-01T10:00:00Z'),
    cancelled_at: at('2026-08-01T12:00:00Z'),
    cancel_reason: 'out of stock',
  });
  assert.deepStrictEqual(statuses(timeline), ['pending', 'cancelled']);
  assert.strictEqual(timeline[1].note, 'out of stock');
});

test('recorded history wins over anything derivable', () => {
  const order = {
    ...legacyOrder(),
    status_history: [
      buildHistoryEntry('pending', { at: at('2026-08-04T07:05:45Z') }),
      buildHistoryEntry('accepted', {
        from: 'pending',
        at: at('2026-08-04T07:06:25Z'),
        actor: { id: 'a1', name: 'Gaurav Pawar', role: 'admin' },
      }),
    ],
  };
  const timeline = buildTimeline(order);
  assert.deepStrictEqual(statuses(timeline), ['pending', 'accepted']);
  assert.ok(!timeline.some((entry) => entry.derived), 'nothing is derived');
  assert.strictEqual(timeline[1].changed_by_name, 'Gaurav Pawar');
});

test('recorded history is sorted chronologically regardless of stored order', () => {
  const order = {
    order_status: 'accepted',
    status_history: [
      buildHistoryEntry('accepted', { at: at('2026-08-04T12:00:00Z') }),
      buildHistoryEntry('pending', { at: at('2026-08-04T09:00:00Z') }),
    ],
  };
  assert.deepStrictEqual(statuses(buildTimeline(order)), ['pending', 'accepted']);
});

// This is the regression the model's recordStatusChange guards: seeding the
// derived entries before appending the first recorded one.
test('the first recorded change on a legacy order keeps the derived steps', () => {
  const order = legacyOrder();
  const seeded = deriveTimeline(order);
  order.status_history = [
    ...seeded,
    buildHistoryEntry('cancelled', {
      from: 'delivered',
      actor: { name: 'Gaurav Pawar', role: 'admin' },
      at: at('2026-08-09T18:00:00Z'),
    }),
  ];

  const timeline = buildTimeline(order);
  assert.deepStrictEqual(statuses(timeline), [
    'pending',
    'accepted',
    'delivered',
    'cancelled',
  ]);
  assert.strictEqual(timeline.filter((entry) => entry.derived).length, 3);
  assert.strictEqual(timeline[3].derived, undefined, 'the real change is not marked derived');
});

test('legacy status spellings are folded to current ones', () => {
  const entry = buildHistoryEntry('placed', { from: 'confirmed' });
  assert.strictEqual(entry.status, 'pending');
  assert.strictEqual(entry.from_status, 'accepted');
});

test('a transition to the same status records no from_status', () => {
  const entry = buildHistoryEntry('pending', { from: 'placed' });
  assert.strictEqual(entry.status, 'pending');
  assert.strictEqual(entry.from_status, undefined, 'placed and pending are the same bucket');
});

test('an actor is recorded when given, and defaults to system', () => {
  const withActor = buildHistoryEntry('accepted', {
    actor: { id: 'a1', name: 'Gaurav Pawar', role: 'admin' },
  });
  assert.strictEqual(withActor.changed_by_role, 'admin');
  assert.strictEqual(withActor.changed_by_id, 'a1');
  assert.strictEqual(buildHistoryEntry('accepted').changed_by_role, 'system');
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
