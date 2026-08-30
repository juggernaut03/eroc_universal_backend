const mongoose = require('mongoose');
const {
  ORDER_STATUS,
  ORDER_STATUSES,
  LEGACY_STATUS_MAP,
  normalizeStatus,
  buildStatusQuery,
} = require('../constants/orderStatus');
const { buildHistoryEntry, deriveTimeline } = require('../utils/orderStatusHistory');

const orderItemSchema = new mongoose.Schema({
  p_code: {
    type: String,
    required: [true, 'Product code is required']
  },
  product_name: {
    type: String,
    required: [true, 'Product name is required']
  },
  quantity: {
    type: Number,
    required: [true, 'Quantity is required'],
    min: [1, 'Quantity must be at least 1']
  },
  unit_price: {
    type: Number,
    required: [true, 'Unit price is required'],
    min: [0, 'Unit price cannot be negative']
  },
  total_price: {
    type: Number,
    required: [true, 'Total price is required'],
    min: [0, 'Total price cannot be negative']
  },
  // Catalogue MRP at the time the order was placed, captured so the pick list
  // can show list price vs. what was charged. Absent on orders placed before
  // this was recorded — the panel falls back to showing no discount.
  mrp: {
    type: Number,
    min: [0, 'MRP cannot be negative']
  },
  package_size: {
    type: Number,
    trim: true
  },
  package_unit: {
    type: String,
    trim: true
  },
  brand_name: {
    type: String,
    trim: true
  },
  pcode_img: {
    type: String,
    trim: true
  }
}, { _id: false });

// One row of the order's status timeline. Appended on every status change;
// see utils/orderStatusHistory.js for how entries are built and how orders
// that predate this field get a timeline reconstructed from their timestamps.
const statusHistorySchema = new mongoose.Schema({
  status: {
    type: String,
    required: true
  },
  from_status: {
    type: String
  },
  changed_at: {
    type: Date,
    required: true,
    default: Date.now
  },
  changed_by_role: {
    type: String,
    enum: ['admin', 'customer', 'system'],
    default: 'system'
  },
  changed_by_id: {
    type: String
  },
  changed_by_name: {
    type: String
  },
  note: {
    type: String,
    trim: true
  },
  // Set on entries reconstructed from the order's timestamps rather than
  // recorded when the change happened. Persisted so an order that gets its
  // first real change keeps an honest record of which timings were inferred.
  derived: {
    type: Boolean
  }
}, { _id: false });

const deliveryInfoSchema = new mongoose.Schema({
  delivery_date: {
    type: Date,
    required: [true, 'Delivery date is required']
  },
  delivery_slot_id: {
    type: Number,
    required: [true, 'Delivery slot ID is required']
  },
  delivery_slot_from: {
    type: String,
    required: [true, 'Delivery slot from time is required']
  },
  delivery_slot_to: {
    type: String,
    required: [true, 'Delivery slot to time is required']
  },
  delivery_address: {
    full_name: {
      type: String
    },
    mobile_number: {
      type: String
    },
    email_id: {
      type: String,
      default: ''
    },
    line_1: {
      type: String
    },
    line_2: {
      type: String,
      trim: true
    },
    city: {
      type: String
    },
    pincode: {
      type: String
    },
    latitude: {
      type: String,
      trim: true
    },
    longitude: {
      type: String,
      trim: true
    },
    area_id: {
      type: String,
      trim: true
    }
  }
}, { _id: false });

const paymentInfoSchema = new mongoose.Schema({
  payment_mode_id: {
    type: Number,
    required: [true, 'Payment mode ID is required']
  },
  payment_mode_name: {
    type: String,
    required: [true, 'Payment mode name is required']
  },
  payment_status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    default: 'pending'
  },
  transaction_id: {
    type: String,
    trim: true
  },
  payment_details: {
    type: mongoose.Schema.Types.Mixed // Flexible object for payment gateway responses
  }
}, { _id: false });

const orderSchema = new mongoose.Schema({
  order_number: {
    type: String,
    required: [true, 'Order number is required'],
    unique: true
  },
  mobile_no: {
    type: String,
    required: [true, 'Customer mobile number is required']
  },
  customer_info: {
    name: {
      type: String,
      trim: true
    },
    email: {
      type: String,
      trim: true,
      lowercase: true
    }
  },
  store_code: {
    type: String,
    required: [true, 'Store code is required']
  },
  project_code: {
    type: String,
    required: [true, 'Project code is required']
  },
  order_status: {
    type: String,
    // Legacy spellings are accepted on write so documents saved before the
    // rename still validate; the setter folds them to the current value.
    enum: [...ORDER_STATUSES, ...Object.keys(LEGACY_STATUS_MAP)],
    set: (value) => LEGACY_STATUS_MAP[value] || value,
    default: ORDER_STATUS.PENDING
  },
  fulfillment_type: {
    type: String,
    enum: ['delivery', 'pickup'],
    default: 'delivery'
  },
  order_items: [orderItemSchema],
  delivery_info: deliveryInfoSchema,
  payment_info: paymentInfoSchema,
  order_summary: {
    subtotal: {
      type: Number,
      required: [true, 'Subtotal is required'],
      min: [0, 'Subtotal cannot be negative']
    },
    delivery_charges: {
      type: Number,
      default: 0,
      min: [0, 'Delivery charges cannot be negative']
    },
    delivery_distance_km: {
      type: Number,
      default: 0
    },
    packing_fee: {
      type: Number,
      default: 0,
      min: [0, 'Packing fee cannot be negative']
    },
    tax_amount: {
      type: Number,
      default: 0,
      min: [0, 'Tax amount cannot be negative']
    },
    discount_amount: {
      type: Number,
      default: 0,
      min: [0, 'Discount amount cannot be negative']
    },
    total_amount: {
      type: Number,
      required: [true, 'Total amount is required'],
      min: [0, 'Total amount cannot be negative']
    },
    total_items: {
      type: Number,
      required: [true, 'Total items count is required'],
      min: [0, 'Total items cannot be negative']
    },
    total_quantity: {
      type: Number,
      required: [true, 'Total quantity is required'],
      min: [0, 'Total quantity cannot be negative']
    },
    applied_offer: {
      offer_id: { type: String },
      title: { type: String },
      discount_type: { type: String },
      discount_amount: { type: Number }
    },
    applied_loyalty_redemption: {
      redemption_id: { type: String },
      reward_name: { type: String },
      discount_amount: { type: Number }
    },
    deal_items_applied: [{
      offer_id: { type: String },
      offer_title: { type: String },
      p_code: { type: String },
      product_name: { type: String },
      deal_price: { type: Number },
      original_price: { type: Number },
      quantity: { type: Number },
      savings: { type: Number }
    }],
    deal_savings: {
      type: Number,
      default: 0,
      min: [0, 'Deal savings cannot be negative']
    }
  },
  order_notes: {
    type: String,
    trim: true
  },
  cancel_reason: {
    type: String,
    trim: true
  },
  cancelled_at: {
    type: Date
  },
  estimated_delivery_date: {
    type: Date
  },
  actual_delivery_date: {
    type: Date
  },
  order_placed_at: {
    type: Date,
    default: Date.now
  },
  order_confirmed_at: {
    type: Date
  },
  order_completed_at: {
    type: Date
  },
  last_updated_at: {
    type: Date,
    default: Date.now
  },
  status_history: {
    type: [statusHistorySchema],
    default: undefined
  }
}, {
  timestamps: true,
  collection: 'orders'
});

// Indexes for better query performance
// Note: order_number field already has unique: true, so index is automatically created
orderSchema.index({ mobile_no: 1 });
orderSchema.index({ order_status: 1 });
orderSchema.index({ store_code: 1 });
orderSchema.index({ 'order_placed_at': -1 });
orderSchema.index({ 'delivery_info.delivery_date': 1 });
orderSchema.index({ mobile_no: 1, order_status: 1 });
orderSchema.index({ mobile_no: 1, 'order_placed_at': -1 });

// Static method to generate order number.
//
// A single global counter per tenant DB (models/Counter.js — the same
// findOneAndUpdate+$inc+upsert primitive already used for AddressBook ids),
// not scoped by store or date, so numbers are unique across every store in
// the tenant and never reset. This replaced a "find the last order and add
// one" scheme: two concurrent placeOrder calls could read the same "last"
// order and compute the same next number, relying on the unique index plus
// a retry loop in utils/orderService.js to paper over the collision.
// $inc/upsert is atomic at the document level, so that race can't happen and
// the retry loop is no longer needed there.
orderSchema.statics.generateOrderNumber = async function() {
  const Counter = require('./Counter');
  const nextSequence = await Counter.getNextSequence('order_number');
  return nextSequence.toString().padStart(4, '0');
};

// Static method to find orders by mobile number
orderSchema.statics.findByMobile = function(mobileNo, limit = 50) {
  return this.find({ mobile_no: mobileNo })
    .sort({ order_placed_at: -1 })
    .limit(limit);
};

// Append an entry to the status timeline.
//
// The first change on an order placed before status_history existed would
// otherwise replace a timeline derived from its timestamps with a single
// entry, hiding everything that came before. So on first use the derived
// entries are written out first and the new change appended after them.
orderSchema.methods.recordStatusChange = function(status, options = {}) {
  if (!this.status_history?.length) {
    this.status_history = deriveTimeline(this);
  }
  const entry = buildHistoryEntry(status, options);
  this.status_history.push(entry);
  return entry;
};

// Seed the timeline with the status the order was created in, so every order
// placed from here on has a first entry regardless of which code path made it.
orderSchema.pre('save', function(next) {
  if (this.isNew && !this.status_history?.length) {
    // Set directly rather than through recordStatusChange: a brand new order
    // has nothing to derive from, and deriving would duplicate this entry.
    this.status_history = [
      buildHistoryEntry(this.order_status, {
        at: this.order_placed_at,
        actor: { role: 'customer' },
        note: 'Order placed'
      })
    ];
  }
  next();
});

// Static method to find orders by status
orderSchema.statics.findByStatus = function(status, limit = 100) {
  return this.find(buildStatusQuery(normalizeStatus(status)))
    .sort({ order_placed_at: -1 })
    .limit(limit);
};

// Instance method to update order status.
//
// `actor` is optional and shaped { id, name, role }; pass adminActor(req.user)
// from admin routes so the timeline records who made the change.
orderSchema.methods.updateStatus = function(newStatus, actor, note) {
  const status = LEGACY_STATUS_MAP[newStatus] || newStatus;
  const previousStatus = this.order_status;
  this.order_status = status;
  this.last_updated_at = new Date();
  this.recordStatusChange(status, { from: previousStatus, actor, note });

  // Set timestamps based on status
  switch (status) {
    case ORDER_STATUS.ACCEPTED:
      if (!this.order_confirmed_at) {
        this.order_confirmed_at = new Date();
      }
      break;
    case 'delivered':
      if (!this.order_completed_at) {
        this.order_completed_at = new Date();
        if (!this.actual_delivery_date) {
          this.actual_delivery_date = new Date();
        }
      }
      break;
  }

  return this.save().then((saved) => {
    // Fire-and-forget: loyalty processing must never block or fail an order
    // status change (loyalty_rewards_frd.md section 75). Lazily required to
    // avoid a circular require - loyaltyOrderHooks needs the Order model
    // too, and this file's own module.exports isn't assigned until the very
    // bottom, so a top-level require here would see an incomplete export.
    const { onOrderDelivered, onOrderCancelledOrRefunded } = require('../utils/loyaltyOrderHooks');
    if (status === 'delivered') {
      onOrderDelivered(saved).catch((e) => console.error('[loyalty] delivered hook error:', e));
    } else if (status === ORDER_STATUS.CANCELLED) {
      onOrderCancelledOrRefunded(saved).catch((e) => console.error('[loyalty] cancel hook error:', e));
    }
    return saved;
  });
};

// Instance method to calculate delivery date based on slot
orderSchema.methods.calculateDeliveryDate = function() {
  if (!this.delivery_info || !this.delivery_info.delivery_date) {
    return null;
  }

  const deliveryDate = new Date(this.delivery_info.delivery_date);
  const today = new Date();

  // If delivery date is in the past, assume next occurrence
  if (deliveryDate < today) {
    // For simplicity, add 7 days for next week
    deliveryDate.setDate(deliveryDate.getDate() + 7);
  }

  return deliveryDate;
};

module.exports = require('./tenantModel')('Order', orderSchema);
