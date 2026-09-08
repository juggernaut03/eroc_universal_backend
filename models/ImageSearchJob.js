const mongoose = require('mongoose');

// One document per "Find & download from web" run (utils/imageSuggest.js's
// generateWebSearchSuggestions). Exists so that request can be queued
// instead of blocking: each product costs a Gemini web-search call, an
// image download, and vision verification, which easily adds up to tens of
// seconds for a handful of products and can exceed a normal reverse-proxy
// timeout for a bigger batch. The route creates this doc, responds
// immediately with its id, and the real work updates it as it goes — the
// admin panel polls this instead of holding the HTTP request open, and the
// admin is free to do anything else in the meantime.
const resultEntrySchema = new mongoose.Schema({
  p_code: { type: String, required: true },
  status: {
    type: String,
    enum: ['FOUND', 'NONE_FOUND', 'URL_DID_NOT_RESOLVE', 'ALREADY_HAS_SUGGESTION', 'NOT_MISSING', 'BUDGET_STOPPED', 'ERROR'],
    required: true
  },
  url: String,
  reason: String,
  // Only set for ALREADY_HAS_SUGGESTION — which state the existing
  // suggestion is in, so the admin knows whether it's still sitting in the
  // review queue or was already resolved one way or the other.
  existing_status: String
}, { _id: false });

const imageSearchJobSchema = new mongoose.Schema({
  project_code: {
    type: String,
    required: [true, 'Project code is required'],
    trim: true,
    index: true
  },
  status: {
    type: String,
    enum: ['running', 'completed', 'failed'],
    default: 'running',
    index: true
  },
  // How many the admin asked for — either the length of an explicit
  // selection, or the auto-pick limit. processed+already_tried+not_missing
  // should always add up to this, so the admin can see the whole picture,
  // not just how many actually triggered a Gemini call.
  requested: { type: Number, default: 0 },
  // Size of the actual batch being searched (requested, minus whatever's
  // already-tried/not-missing) — known only once the job starts running, so
  // it's filled in by the first progress update, not at creation. Lets the
  // admin panel show a determinate "processed / batch_total" progress bar
  // instead of a bare spinner.
  batch_total: { type: Number, default: 0 },
  processed: { type: Number, default: 0 },
  found: { type: Number, default: 0 },
  not_found: { type: Number, default: 0 },
  already_tried: { type: Number, default: 0 },
  not_missing: { type: Number, default: 0 },
  errored: { type: Number, default: 0 },
  // How many of `batch_total` were left un-searched because `budget_inr`
  // was hit first — see config/geminiPricing.js and generateWebSearchSuggestions.
  budget_stopped: { type: Number, default: 0 },
  // Optional admin-set INR ceiling — the job stops issuing new grounded
  // search calls once estimated_cost_inr would exceed this. Unset means
  // no cap beyond `requested`/`limit` itself.
  budget_inr: { type: Number },
  // Running (then final) cost estimate — see config/geminiPricing.js for
  // where the per-request numbers come from. An estimate, not a real
  // billing figure.
  estimated_cost_inr: { type: Number, default: 0 },
  results: [resultEntrySchema],
  triggered_by_email: { type: String, trim: true },
  error_message: String,
  finished_at: Date
}, {
  timestamps: true,
  collection: 'imagesearchjobs'
});

imageSearchJobSchema.index({ project_code: 1, createdAt: -1 });

module.exports = require('./tenantModel')('ImageSearchJob', imageSearchJobSchema);
