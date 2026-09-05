const mongoose = require('mongoose');

// One document per sync of a tenant's catalog against the shared barcode
// image pool (see utils/imageSync.js). Exists so the admin monitor UI has
// history — matched/missing counts and who ran it — rather than only a live
// re-scan every time the page loads. Lives in the tenant DB, same as
// ProductMaster, since a run is meaningless outside the tenant it synced.
const imageSyncRunSchema = new mongoose.Schema({
  project_code: {
    type: String,
    required: [true, 'Project code is required'],
    trim: true
  },
  triggered_by: {
    // Admin (User) id who clicked "sync now" — sync is manual-only by
    // design (see the architecture plan), so this is never null.
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  triggered_by_email: {
    // Denormalized snapshot so the run history still reads sensibly if the
    // admin account is later removed.
    type: String,
    trim: true
  },
  ran_at: {
    type: Date,
    default: Date.now
  },
  total_products: {
    type: Number,
    default: 0
  },
  matched_primary: {
    type: Number,
    default: 0
  },
  matched_secondary: {
    type: Number,
    default: 0
  },
  missing_count: {
    type: Number,
    default: 0
  },
  // Capped snapshot, not the full list for large catalogs — enough for the
  // UI to show examples without a multi-thousand-element document.
  missing_sample: [{
    p_code: String,
    barcode: String,
    product_name: String
  }],
  duration_ms: {
    type: Number
  }
}, {
  timestamps: true,
  collection: 'imagesyncruns'
});

imageSyncRunSchema.index({ project_code: 1, ran_at: -1 });

module.exports = require('./tenantModel')('ImageSyncRun', imageSyncRunSchema);
