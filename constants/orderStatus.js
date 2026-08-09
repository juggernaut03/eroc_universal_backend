// Order status vocabulary.
//
// These are the eight buckets the admin panel exposes as tabs, matching the
// legacy Shalvi admin panel one-for-one. Every order sits in exactly one of
// them — the tab queries below are mutually exclusive by construction, so an
// accepted order never also shows up under Pending.
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
  PAYMENT_PROCESSING: 'payment_processing',
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
  ORDER_STATUS.PAYMENT_PROCESSING,
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
 * Payment Processing is the only bucket that is not a plain status match: it
 * holds prepaid orders whose payment has not been confirmed yet. Those orders
 * are still `pending` as far as the pipeline is concerned, so Pending has to
 * exclude them explicitly — otherwise they would be counted under both tabs.
 */
function buildStatusQuery(status) {
  if (!status) return {};

  if (status === ORDER_STATUS.PAYMENT_PROCESSING) {
    return {
      $or: [
        { order_status: ORDER_STATUS.PAYMENT_PROCESSING },
        {
          order_status: { $in: LEGACY_STATUS_ALIASES[ORDER_STATUS.PENDING] },
          'payment_info.payment_status': 'processing',
        },
      ],
    };
  }

  if (status === ORDER_STATUS.PENDING) {
    return {
      order_status: { $in: LEGACY_STATUS_ALIASES[ORDER_STATUS.PENDING] },
      'payment_info.payment_status': { $ne: 'processing' },
    };
  }

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
