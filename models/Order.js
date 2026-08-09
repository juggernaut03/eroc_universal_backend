const mongoose = require('mongoose');
const {
  ORDER_STATUS,
  ORDER_STATUSES,
  LEGACY_STATUS_MAP,
  normalizeStatus,
  buildStatusQuery,
} = require('../constants/orderStatus');

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
      type: String,
      required: [true, 'Delivery full name is required']
    },
    mobile_number: {
      type: String,
      required: [true, 'Delivery mobile number is required']
    },
    email_id: {
      type: String,
      default: ''
    },
    line_1: {
      type: String,
      required: [true, 'Delivery address line 1 is required']
    },
    line_2: {
      type: String,
      trim: true
    },
    city: {
      type: String,
      required: [true, 'Delivery city is required']
    },
    pincode: {
      type: String,
      required: [true, 'Delivery pincode is required']
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

// Static method to generate order number
orderSchema.statics.generateOrderNumber = async function() {
  const date = new Date();
  const year = date.getFullYear().toString().slice(-2);
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');

  // Find the last order for today
  const lastOrder = await this.findOne({
    order_number: new RegExp(`^ORD${year}${month}${day}`)
  }).sort({ order_number: -1 });

  let sequence = 1;
  if (lastOrder) {
    const lastSequence = parseInt(lastOrder.order_number.slice(-4));
    sequence = lastSequence + 1;
  }

  return `ORD${year}${month}${day}${sequence.toString().padStart(4, '0')}`;
};

// Static method to find orders by mobile number
orderSchema.statics.findByMobile = function(mobileNo, limit = 50) {
  return this.find({ mobile_no: mobileNo })
    .sort({ order_placed_at: -1 })
    .limit(limit);
};

// Static method to find orders by status
orderSchema.statics.findByStatus = function(status, limit = 100) {
  return this.find(buildStatusQuery(normalizeStatus(status)))
    .sort({ order_placed_at: -1 })
    .limit(limit);
};

// Instance method to update order status
orderSchema.methods.updateStatus = function(newStatus) {
  const status = LEGACY_STATUS_MAP[newStatus] || newStatus;
  this.order_status = status;
  this.last_updated_at = new Date();

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

  return this.save();
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
