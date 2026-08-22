const mongoose = require('mongoose');

// Extra Subcategory parents for a Product, beyond its primary
// ProductMaster.sub_category_id. A product's primary parent never moves; a
// row here just means "also list this product under this subcategory too."
//
// p_code (not the Mongo _id) matches ProductMaster's own natural-key
// convention — every existing product lookup in this codebase keys on p_code.
const subcategoryProductMapSchema = new mongoose.Schema({
  idsub_category_master: {
    type: String,
    required: [true, 'Subcategory master ID is required'],
    trim: true
  },
  p_code: {
    type: String,
    required: [true, 'Product code is required'],
    trim: true
  },
  store_code: {
    type: String,
    required: [true, 'Store code is required'],
    trim: true
  },
  project_code: {
    type: String,
    trim: true
  }
}, {
  timestamps: true,
  collection: 'subcategoryproductmaps'
});

// Prevents duplicate mapping rows (double-submit/race protection).
subcategoryProductMapSchema.index(
  { idsub_category_master: 1, p_code: 1, store_code: 1 },
  { unique: true }
);
// Reverse lookup: admin prefill + sync diff for one product.
subcategoryProductMapSchema.index({ p_code: 1, store_code: 1 });
// Forward lookup: storefront get-products/search-products.
subcategoryProductMapSchema.index({ idsub_category_master: 1, store_code: 1 });

// Mapping rows for a set of subcategories (storefront: resolve the full set
// of products — primary + mapped — shown under these subcategories).
subcategoryProductMapSchema.statics.findBySubcategoryIds = function (subcategoryIds, storeCode) {
  return this.find({
    idsub_category_master: { $in: subcategoryIds },
    store_code: storeCode
  });
};

// Mapping rows for one product (admin: prefill "Additional Subcategories" on
// the edit dialog; storefront: get-product-by-pcode fallback check).
subcategoryProductMapSchema.statics.findByPCode = function (pCode, storeCode) {
  return this.find({
    p_code: pCode,
    store_code: storeCode
  });
};

// Full delete-then-insert sync of one product's additional-subcategory set.
// An empty subCategoryIds array clears all mappings for this product.
subcategoryProductMapSchema.statics.replaceForProduct = async function (
  pCode,
  storeCode,
  subCategoryIds
) {
  await this.deleteMany({ p_code: pCode, store_code: storeCode });

  const uniqueIds = [...new Set((subCategoryIds || []).filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  return this.insertMany(
    uniqueIds.map((idsub_category_master) => ({
      idsub_category_master,
      p_code: pCode,
      store_code: storeCode
    })),
    { ordered: false }
  );
};

module.exports = require('./tenantModel')('SubcategoryProductMap', subcategoryProductMapSchema);
