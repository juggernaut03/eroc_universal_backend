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
  // Which store serves this pincode. One store can (and usually does) serve
  // many pincodes — this is the many-to-one side of that relationship;
  // Store no longer carries its own pincode duplicated per row (see
  // scripts/consolidate_store_pincodes.js for the migration off the old
  // one-Store-row-per-pincode model). Null/unset means the pincode is
  // enabled but not yet assigned to a store.
  store_code: {
    type: String,
    trim: true,
    uppercase: true,
    default: null
  }
}, {
  timestamps: true,
  collection: 'pincodemasters'
});

// Indexes for better query performance
pincodeSchema.index({ pincode: 1 });
// Note: idpincode_master field already has unique: true, so index is automatically created
pincodeSchema.index({ is_enabled: 1 });
pincodeSchema.index({ store_code: 1 });

// Static method to find enabled pincodes
pincodeSchema.statics.findEnabled = function() {
  return this.find({ is_enabled: 'Enabled' }).sort({ pincode: 1 });
};

// Static method to check if pincode is serviceable
pincodeSchema.statics.isServiceable = function(pincode) {
  return this.findOne({ pincode: pincode, is_enabled: 'Enabled' });
};

// Static method to find every pincode mapped to a store, for the admin
// panel's "which pincodes does this store cover" view.
pincodeSchema.statics.findByStoreCode = function(storeCode) {
  return this.find({ store_code: storeCode }).sort({ pincode: 1 });
};

// Instance method to check if enabled
pincodeSchema.methods.isEnabled = function() {
  return this.is_enabled === 'Enabled';
};

module.exports = require('./tenantModel')('Pincode', pincodeSchema);
