const mongoose = require('mongoose');

const pincodeSchema = new mongoose.Schema({
  idpincode_master: {
    type: Number,
    required: [true, 'Pincode master ID is required'],
    unique: true
  },
  pincode: {
    type: String,
    required: [true, 'Pincode is required'],
    trim: true,
    match: [/^\d{6}$/, 'Please enter a valid 6-digit pincode']
  },
  is_enabled: {
    type: String,
    enum: ['Enabled', 'Disabled'],
    default: 'Enabled'
  },
  // Deprecated — superseded by store_codes[] below (a pincode can now be
  // served by more than one store, with the customer choosing at checkout).
  // Left in place, unused by any route, only so historical documents still
  // round-trip if ever read directly. See scripts/migrate_pincode_store_codes.js.
  store_code: {
    type: String,
    trim: true,
    uppercase: true,
    default: null
  },
  // Which store(s) serve this pincode. Many pincodes can point at the same
  // store (many-to-one from the store's side), and now a single pincode can
  // also list several stores (many-to-many overall) — the customer picks
  // one on the outlet-selection screen. Empty array means enabled but not
  // yet assigned to any store.
  store_codes: {
    type: [String],
    default: [],
    set: (codes) => [...new Set((codes || []).map((c) => String(c).trim().toUpperCase()))]
  }
}, {
  timestamps: true,
  collection: 'pincodemasters'
});

// Indexes for better query performance
pincodeSchema.index({ pincode: 1 });
// Note: idpincode_master field already has unique: true, so index is automatically created
pincodeSchema.index({ is_enabled: 1 });
pincodeSchema.index({ store_codes: 1 });

// Static method to find enabled pincodes
pincodeSchema.statics.findEnabled = function() {
  return this.find({ is_enabled: 'Enabled' }).sort({ pincode: 1 });
};

// Static method to check if pincode is serviceable
pincodeSchema.statics.isServiceable = function(pincode) {
  return this.findOne({ pincode: pincode, is_enabled: 'Enabled' });
};

// Static method to find every pincode mapped to a store, for the admin
// panel's "which pincodes does this store cover" view. A scalar match
// against an array field already means "array contains this value" in
// MongoDB — no $elemMatch/$in needed.
pincodeSchema.statics.findByStoreCode = function(storeCode) {
  return this.find({ store_codes: storeCode }).sort({ pincode: 1 });
};

// Instance method to check if enabled
pincodeSchema.methods.isEnabled = function() {
  return this.is_enabled === 'Enabled';
};

module.exports = require('./tenantModel')('Pincode', pincodeSchema);
