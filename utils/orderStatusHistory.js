// Order status timeline.
//
// Every status change appends an entry to order.status_history, so the admin
// panel can show when an order moved from one bucket to the next and who moved
// it. Orders placed before this shipped have no history array; buildTimeline()
// reconstructs what it can from the timestamps those orders do carry
// (order_placed_at / order_confirmed_at / order_completed_at / cancelled_at)
// and flags the reconstructed entries as derived, so the panel can be honest
// about which timings are recorded and which are inferred.

const { ORDER_STATUS, normalizeStatus } = require('../constants/orderStatus');

/**
 * Build a history entry. `actor` is optional and shaped
 * { id, name, role } — role is 'admin', 'customer' or 'system'.
 */
function buildHistoryEntry(status, { from, actor, note, at } = {}) {
  const entry = {
    status: normalizeStatus(status),
    changed_at: at || new Date(),
    changed_by_role: actor?.role || 'system',
  };

  const fromStatus = normalizeStatus(from);
  // A no-op transition (pending -> pending) carries no information; leave
  // from_status unset rather than recording a self-loop.
  if (fromStatus && fromStatus !== entry.status) {
    entry.from_status = fromStatus;
  }
  if (actor?.id) entry.changed_by_id = String(actor.id);
  if (actor?.name) entry.changed_by_name = actor.name;
  if (note) entry.note = note;

  return entry;
}

/**
 * Actor descriptor for an authenticated admin (req.user on admin routes).
 */
function adminActor(user) {
  if (!user) return { role: 'admin' };
  return {
    id: user._id,
    name: user.name || user.email || user.mobile,
    role: 'admin',
  };
}

/**
 * Reconstruct a timeline for an order that predates status_history.
 *
 * Only timestamps that actually exist produce entries, so an order that was
 * never confirmed shows no "accepted" step. The order's current status always
 * appears last: if no timestamp explains it, last_updated_at is used, which is
 * the closest thing to a change time those documents recorded.
 */
function deriveTimeline(order) {
  const entries = [];
  const push = (status, at, note) => {
    if (!at) return;
    entries.push({
      status,
      changed_at: at,
      changed_by_role: 'system',
      derived: true,
      ...(note ? { note } : {}),
    });
  };

  push(ORDER_STATUS.PENDING, order.order_placed_at || order.createdAt, 'Order placed');
  push(ORDER_STATUS.ACCEPTED, order.order_confirmed_at);
  push(
    ORDER_STATUS.DELIVERED,
    order.order_completed_at || order.actual_delivery_date
  );
  push(ORDER_STATUS.CANCELLED, order.cancelled_at, order.cancel_reason);

  entries.sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));

  const current = normalizeStatus(order.order_status);
  if (current && !entries.some((e) => e.status === current)) {
    push(current, order.last_updated_at || order.updatedAt);
  }

  // Fill in from_status now that the entries are in chronological order.
  return entries.map((entry, index) => {
    const previous = entries[index - 1];
    if (previous && previous.status !== entry.status) {
      return { ...entry, from_status: previous.status };
    }
    return entry;
  });
}

/**
 * The timeline to show for an order: recorded history when there is any,
 * otherwise whatever can be derived from the order's timestamps.
 */
function buildTimeline(order) {
  const recorded = order.status_history || [];
  if (recorded.length > 0) {
    const entries = recorded.map((entry) =>
      typeof entry.toObject === 'function' ? entry.toObject() : { ...entry }
    );
    entries.sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));
    return entries;
  }
  return deriveTimeline(order);
}

module.exports = {
  buildHistoryEntry,
  adminActor,
  deriveTimeline,
  buildTimeline,
};
