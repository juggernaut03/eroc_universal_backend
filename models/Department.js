const mongoose = require('mongoose');

const departmentSchema = new mongoose.Schema({
  department_id: {
    type: String,
    required: [true, 'Department ID is required'],
    trim: true
  },
  department_name: {
    type: String,
    required: [true, 'Department name is required'],
    trim: true
  },
  dept_type_id: {
    type: String,
    required: [true, 'Department type ID is required'],
    trim: true
  },
  dept_no_of_col: {
    type: Number,
    default: 0
  },
  store_code: {
    type: String,
    trim: true,
    default: 'null'
  },
  image_link: {
    type: String,
    trim: true
  },
  sequence_id: {
    type: Number,
    required: [true, 'Sequence ID is required']
  },
  // Storefront visibility toggle, set from the admin panel — same
  // convention as Category.is_visible / Subcategory.is_visible. Defaults
  // true so every pre-existing department (created before this field
  // existed) keeps showing exactly as before. Admin routes ignore this —
  // the admin panel always sees everything regardless of value.
  is_visible: {
    type: Boolean,
    default: true
  },
  project_code: {
    type: String,
    trim: true
  }
}, {
  timestamps: true,
  collection: 'departmentmasters'
});

// Indexes for better query performance
departmentSchema.index({ store_code: 1 });
departmentSchema.index({ department_id: 1 });
departmentSchema.index({ dept_type_id: 1 });
departmentSchema.index({ sequence_id: 1 });
departmentSchema.index({ store_code: 1, sequence_id: 1 });

// Static method to find departments by store code (storefront-facing —
// hidden departments are excluded; admin routes query the model directly
// instead of via this static, so they see everything)
departmentSchema.statics.findByStoreCode = function (storeCode) {
  let query;
  if (storeCode === 'null' || storeCode === null) {
    // Handle both null and "null" - search for actual null values in database
    query = { store_code: null };
  } else {
    query = { store_code: storeCode };
  }
  query.is_visible = { $ne: false };
  return this.find(query).sort({ sequence_id: 1 });
};

// Static method to find all departments sorted by sequence (storefront-facing)
departmentSchema.statics.findAllSorted = function () {
  return this.find({ is_visible: { $ne: false } }).sort({ sequence_id: 1 });
};

// Static method to find departments by type (storefront-facing)
departmentSchema.statics.findByType = function (deptTypeId, storeCode = null) {
  const query = { dept_type_id: deptTypeId, is_visible: { $ne: false } };

  if (storeCode) {
    query.store_code = storeCode;
  }

  return this.find(query).sort({ sequence_id: 1 });
};

module.exports = require('./tenantModel')('Department', departmentSchema);

