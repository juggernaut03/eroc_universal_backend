const mongoose = require('mongoose');

const subcategorySchema = new mongoose.Schema({
  idsub_category_master: {
    type: String,
    required: [true, 'Subcategory master ID is required'],
    trim: true
  },
  sub_category_name: {
    type: String,
    required: [true, 'Subcategory name is required'],
    trim: true
  },
  category_id: {
    type: String,
    required: [true, 'Category ID is required'],
    trim: true
  },
  main_category_name: {
    type: String,
    required: [true, 'Main category name is required'],
    trim: true
  },
  image_link: {
    type: String,
    trim: true
  },
  // Storefront visibility toggle, set from the admin panel. Defaults true so
  // every pre-existing subcategory (created before this field existed) keeps
  // showing exactly as before. Admin routes ignore this — the admin panel
  // always sees everything regardless of value.
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
  collection: 'subcategorymasters'
});

// Indexes for better query performance
subcategorySchema.index({ category_id: 1 });
subcategorySchema.index({ idsub_category_master: 1 });
subcategorySchema.index({ main_category_name: 1 });

// Static method to find subcategories by category ID (storefront-facing —
// hidden subcategories are excluded; admin routes query the model directly
// instead of via this static, so they see everything)
subcategorySchema.statics.findByCategoryId = function (categoryId) {
  return this.find({ category_id: categoryId, is_visible: { $ne: false } }).sort({ idsub_category_master: 1 });
};

// Static method to find subcategories by multiple category IDs (storefront-facing)
subcategorySchema.statics.findByCategoryIds = function (categoryIds) {
  return this.find({ category_id: { $in: categoryIds }, is_visible: { $ne: false } }).sort({ idsub_category_master: 1 });
};

// Static method to find all subcategories sorted (storefront-facing)
subcategorySchema.statics.findAllSorted = function () {
  return this.find({ is_visible: { $ne: false } }).sort({ idsub_category_master: 1 });
};

module.exports = require('./tenantModel')('Subcategory', subcategorySchema);
