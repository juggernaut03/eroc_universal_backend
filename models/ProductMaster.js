const mongoose = require('mongoose');

// One entry per store this product is actually stocked at. Everything here
// is genuinely per-store — price, stock, and whether it's on/off for that
// specific store. Nothing identity-related belongs in here; that lives on
// the parent document once, see below.
const storeListingSchema = new mongoose.Schema({
  store_code: {
    type: String,
    required: [true, 'Store code is required'],
    trim: true
  },
  our_price: {
    type: mongoose.Schema.Types.Decimal128,
    required: [true, 'Our price is required']
  },
  product_mrp: {
    type: mongoose.Schema.Types.Decimal128,
    required: [true, 'Product MRP is required']
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
  pcode_status: {
    type: String,
    enum: ['Y', 'N'],
    default: 'Y'
  }
}, { _id: true, timestamps: true });

// A product sold at N stores used to be N full ProductMaster documents,
// each an independent copy of every field — including ones that should
// never vary by store (name, barcode, image, category). Nothing kept
// those copies in sync, which caused several real bugs: barcode values
// drifting per store (an Excel export mangled one store's barcodes into
// scientific notation, silently breaking image matching only for that
// store), the same product ending up with a different — or missing —
// image per store, and a CSV-upload bug where the wrong ambient store
// context corrupted other stores' data in one request.
//
// Now there is exactly one document per p_code. Identity fields
// (name/barcode/category/image/etc.) live here, once. Only price, stock,
// and active/inactive status genuinely vary by store — those live in
// `stores[]` (storeListingSchema above). Mongo can't enforce "no two
// entries in stores[] share a store_code" via an index (no uniqueness
// constraint within an array per document) — every write path that
// pushes a new entry onto stores[] MUST guard this at the application
// layer (a conditional $ne filter on the push), never assume the
// database rejects a duplicate.
//
// See /Users/gauravpawar/.claude/plans/breezy-crunching-sifakis.md for
// the full design and migration plan (scripts/migrate_productmaster_to_stores_array.js
// is the one-time migration from the old per-(p_code,store_code)-document
// shape into this one).
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
  brand_name: {
    type: String,
    trim: true
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
    trim: true,
    required: [true, 'Project code is required']
  },
  stores: {
    type: [storeListingSchema],
    default: []
  }
}, {
  timestamps: true,
  collection: 'productmasters'
});

// Indexes for better query performance
productMasterSchema.index({ dept_id: 1 });
productMasterSchema.index({ category_id: 1 });
productMasterSchema.index({ sub_category_id: 1 });
productMasterSchema.index({ project_code: 1, dept_id: 1, category_id: 1, sub_category_id: 1 });
productMasterSchema.index({ 'stores.store_code': 1 });
productMasterSchema.index({ 'stores.store_code': 1, 'stores.pcode_status': 1 });
// Covers the admin by-store list's default (non-search) sort/filter path.
productMasterSchema.index({
  project_code: 1,
  'stores.store_code': 1,
  'stores.pcode_status': 1,
  product_name: 1
});
// One document per p_code within a tenant — p_code is a free-typed string,
// not this schema's own _id, so this is the only thing that actually
// guarantees it. Replaces the old {p_code, store_code} unique index, which
// enforced the same intent for the old one-document-per-store shape.
productMasterSchema.index({ p_code: 1, project_code: 1 }, { unique: true });
productMasterSchema.index({ product_name: 'text', product_description: 'text' });

// Finds this product's listing for one store, or undefined if it isn't
// stocked there. The single implementation every call site should reuse
// instead of inlining `this.stores.find(...)` repeatedly.
productMasterSchema.methods.storeListing = function (storeCode) {
  return this.stores.find((s) => s.store_code === storeCode);
};

module.exports = require('./tenantModel')('ProductMaster', productMasterSchema);
