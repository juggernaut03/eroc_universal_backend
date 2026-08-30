// Order status vocabulary.
//
// These are the seven buckets the admin panel exposes as tabs. Every order
// sits in exactly one of them — the tab queries below are mutually exclusive
// by construction, so an accepted order never also shows up under Pending.
//
// There used to be an eighth, Payment Processing. It was never a value any
// code wrote: it was a view over prepaid orders whose payment had not settled
// (order_status still pending, payment_info.payment_status 'processing'), and
// Pending had to exclude those to stop them being counted twice. Removed on
// request — such an order now simply sits in Pending like any other unhandled
// order, and its payment state is visible in the Payment Status column.
//
// The values replace an older vocabulary (placed / confirmed / processing /
// packed / shipped / refunded). LEGACY_STATUS_ALIASES keeps documents written
// before the rename readable: every filter matches both spellings, so the panel
// works whether or not scripts/migrate-order-statuses.js has been run.

const ORDER_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  ACCEPTED_BY_STORE: 'accepted_by_store',
  IN_PACKAGING: 'in_packaging',
  OUT_FOR_DELIVERY: 'out_for_delivery',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
};

// Workflow order — also the order the admin panel renders its tabs in.
const ORDER_STATUSES = [
  ORDER_STATUS.PENDING,
  ORDER_STATUS.ACCEPTED,
  ORDER_STATUS.ACCEPTED_BY_STORE,
  ORDER_STATUS.IN_PACKAGING,
  ORDER_STATUS.OUT_FOR_DELIVERY,
  ORDER_STATUS.DELIVERED,
  ORDER_STATUS.CANCELLED,
];

// Pre-rename value -> current value. Used by the migration script and by the
// query builder so both spellings resolve to the same tab.
const LEGACY_STATUS_MAP = {
  placed: ORDER_STATUS.PENDING,
  confirmed: ORDER_STATUS.ACCEPTED,
  processing: ORDER_STATUS.ACCEPTED_BY_STORE,
  packed: ORDER_STATUS.IN_PACKAGING,
  shipped: ORDER_STATUS.OUT_FOR_DELIVERY,
  refunded: ORDER_STATUS.CANCELLED,
  // Retired. No code ever wrote it, but an order carrying it (from another
  // environment, or a client pinned to an older build) still has to resolve:
  // listing it here keeps it valid on the model enum, folds it to Pending on
  // read, and makes the Order setter rewrite it to pending on any save.
  payment_processing: ORDER_STATUS.PENDING,
};

// Current value -> every stored value that means it (current + legacy).
const LEGACY_STATUS_ALIASES = ORDER_STATUSES.reduce((acc, status) => {
  acc[status] = [status];
  return acc;
}, {});
Object.entries(LEGACY_STATUS_MAP).forEach(([legacy, current]) => {
  LEGACY_STATUS_ALIASES[current].push(legacy);
});

// Statuses a customer may still cancel from: nothing has been packed yet.
const CANCELLABLE_STATUSES = [
  ...LEGACY_STATUS_ALIASES[ORDER_STATUS.PENDING],
  ...LEGACY_STATUS_ALIASES[ORDER_STATUS.ACCEPTED],
  ...LEGACY_STATUS_ALIASES[ORDER_STATUS.ACCEPTED_BY_STORE],
];

// Statuses that never count towards revenue.
const NON_REVENUE_STATUSES = LEGACY_STATUS_ALIASES[ORDER_STATUS.CANCELLED];

// Orders still moving through the pipeline.
const ACTIVE_STATUSES = ORDER_STATUSES.filter(
  (status) => status !== ORDER_STATUS.DELIVERED && status !== ORDER_STATUS.CANCELLED
).flatMap((status) => LEGACY_STATUS_ALIASES[status]);

function isValidStatus(status) {
  return ORDER_STATUSES.includes(status);
}

// Normalise a stored value to its current spelling.
function normalizeStatus(status) {
  if (!status) return status;
  return LEGACY_STATUS_MAP[status] || status;
}

/**
 * Mongo query fragment selecting exactly the orders belonging to one tab.
 *
 * Every bucket is now a plain status match. Pending used to carry an extra
 * `payment_info.payment_status: { $ne: 'processing' }` so that a prepaid order
 * mid-payment showed under Payment Processing instead of under both tabs. With
 * that tab gone the exclusion has to go too — left in place it would match no
 * tab at all and the order would be invisible in the panel rather than merely
 * in the wrong one.
 */
function buildStatusQuery(status) {
  if (!status) return {};

  return { order_status: { $in: LEGACY_STATUS_ALIASES[status] || [status] } };
}

module.exports = {
  ORDER_STATUS,
  ORDER_STATUSES,
  LEGACY_STATUS_MAP,
  LEGACY_STATUS_ALIASES,
  CANCELLABLE_STATUSES,
  NON_REVENUE_STATUSES,
  ACTIVE_STATUSES,
  isValidStatus,
  normalizeStatus,
  buildStatusQuery,
};
