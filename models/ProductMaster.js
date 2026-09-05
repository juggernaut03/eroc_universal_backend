const mongoose = require('mongoose');

const productMasterSchema = new mongoose.Schema({
  p_code: {
    type: String,
    required: [true, 'Product code is required'],
    trim: true
  },
  barcode: {
    type: String,
    trim: true
  },
  product_name: {
    type: String,
    required: [true, 'Product name is required'],
    trim: true
  },
  product_description: {
    type: String,
    trim: true
  },
  package_size: {
    type: Number,
    required: [true, 'Package size is required']
  },
  package_unit: {
    type: String,
    required: [true, 'Package unit is required'],
    trim: true
  },
  product_mrp: {
    type: mongoose.Schema.Types.Decimal128,
    required: [true, 'Product MRP is required']
  },
  our_price: {
    type: mongoose.Schema.Types.Decimal128,
    required: [true, 'Our price is required']
  },
  brand_name: {
    type: String,
    trim: true
  },
  store_code: {
    type: String,
    required: [true, 'Store code is required'],
    trim: true
  },
  pcode_status: {
    type: String,
    enum: ['Y', 'N'],
    default: 'Y'
  },
  dept_id: {
    type: String,
    required: [true, 'Department ID is required'],
    trim: true
  },
  category_id: {
    type: String,
    required: [true, 'Category ID is required'],
    trim: true
  },
  sub_category_id: {
    type: String,
    required: [true, 'Sub category ID is required'],
    trim: true
  },
  store_quantity: {
    type: Number,
    required: [true, 'Store quantity is required'],
    default: 0
  },
  max_quantity_allowed: {
    type: Number,
    required: [true, 'Max quantity allowed is required'],
    default: 10
  },
  // Both populated by the image-CDN sync engine (utils/imageSync.js), never
  // hand-typed and never a guessed formula — empty until a sync has actually
  // copied a matching file into this tenant's public store. That's also what
  // "missing" means for this tenant: pcode_img not set.
  pcode_img: {
    type: String,
    trim: true
  },
  pcode_img_2: {
    type: String,
    trim: true
  },
  search_keyword: {
    type: String,
    trim: true
  },
  project_code: {
    type: String,
    trim: true
  }
}, {
  timestamps: true,
  collection: 'productmasters'
});

// Indexes for better query performance
productMasterSchema.index({ store_code: 1 });
productMasterSchema.index({ dept_id: 1 });
productMasterSchema.index({ category_id: 1 });
productMasterSchema.index({ sub_category_id: 1 });
productMasterSchema.index({ pcode_status: 1 });
productMasterSchema.index({ store_code: 1, dept_id: 1, category_id: 1, sub_category_id: 1 });
productMasterSchema.index({ product_name: 'text', product_description: 'text' });

// Static method to find products by filters
productMasterSchema.statics.findByFilters = function (filters) {
  const query = {};

  if (filters.store_code) {
    query.store_code = filters.store_code;
  }

  if (filters.dept_id) {
    query.dept_id = filters.dept_id;
  }

  if (filters.category_id) {
    query.category_id = filters.category_id;
  }

  if (filters.sub_category_id) {
    query.sub_category_id = filters.sub_category_id;
  }

  // Only return active products
  query.pcode_status = 'Y';

  return this.find(query).sort({ product_name: 1 });
};

// Static method to find all products sorted by product name
productMasterSchema.statics.findAllSorted = function () {
  return this.find({ pcode_status: 'Y' }).sort({ product_name: 1 });
};

module.exports = require('./tenantModel')('ProductMaster', productMasterSchema);
