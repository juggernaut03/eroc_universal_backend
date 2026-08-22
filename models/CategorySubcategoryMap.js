const mongoose = require('mongoose');

// Extra Category parents for a Subcategory, beyond its primary
// Subcategory.category_id. A subcategory's primary parent never moves; a row
// here just means "also show this subcategory under this category too."
//
// store_code is required even though it duplicates information reachable via
// Category — idcategory_master/idsub_category_master are NOT globally unique,
// every existing lookup in this codebase scopes them by store first (via the
// owning Category's store_code). Omitting it here would let two stores' reused
// numeric IDs cross-contaminate mappings.
const categorySubcategoryMapSchema = new mongoose.Schema({
  idcategory_master: {
    type: String,
    required: [true, 'Category master ID is required'],
    trim: true
  },
  idsub_category_master: {
    type: String,
    required: [true, 'Subcategory master ID is required'],
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
  collection: 'categorysubcategorymaps'
});

// Prevents duplicate mapping rows (double-submit/race protection).
categorySubcategoryMapSchema.index(
  { idcategory_master: 1, idsub_category_master: 1, store_code: 1 },
  { unique: true }
);
// Reverse lookup: admin prefill + sync diff for one subcategory.
categorySubcategoryMapSchema.index({ idsub_category_master: 1, store_code: 1 });
// Forward lookup: storefront get-subcategories/get-products.
categorySubcategoryMapSchema.index({ idcategory_master: 1, store_code: 1 });

// Mapping rows for a set of categories (storefront: resolve the full set of
// subcategories — primary + mapped — shown under these categories).
categorySubcategoryMapSchema.statics.findByCategoryIds = function (categoryIds, storeCode) {
  return this.find({
    idcategory_master: { $in: categoryIds },
    store_code: storeCode
  });
};

// Mapping rows for one subcategory (admin: prefill "Additional Categories" on
// the edit dialog).
categorySubcategoryMapSchema.statics.findBySubcategoryId = function (idSubCategoryMaster, storeCode) {
  return this.find({
    idsub_category_master: idSubCategoryMaster,
    store_code: storeCode
  });
};

// Full delete-then-insert sync of one subcategory's additional-category set.
// An empty categoryIds array clears all mappings for this subcategory.
categorySubcategoryMapSchema.statics.replaceForSubcategory = async function (
  idSubCategoryMaster,
  storeCode,
  categoryIds
) {
  await this.deleteMany({ idsub_category_master: idSubCategoryMaster, store_code: storeCode });

  const uniqueIds = [...new Set((categoryIds || []).filter(Boolean))];
  if (uniqueIds.length === 0) return [];

  return this.insertMany(
    uniqueIds.map((idcategory_master) => ({
      idcategory_master,
      idsub_category_master: idSubCategoryMaster,
      store_code: storeCode
    })),
    { ordered: false }
  );
};

module.exports = require('./tenantModel')('CategorySubcategoryMap', categorySubcategoryMapSchema);
