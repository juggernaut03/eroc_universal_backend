const mongoose = require('mongoose');

// One document per candidate image proposed for one tenant's product —
// see the "Image Match Suggestions" architecture plan. Both sources this
// engine can produce end up in the exact same shape and the exact same
// accept/reject flow:
//
//   cross_tenant — the candidate already exists in the shared pool under a
//     DIFFERENT barcode (found via product-name similarity against every
//     other tenant's catalog).
//   web_search   — the candidate was just found via Gemini's web-search
//     grounding and written into the shared pool under THIS product's own
//     real barcode (so a future barcode-exact sync would find it too, but
//     it still waits for an explicit accept here first).
//
// Either way, accepting a suggestion is the same operation: copy
// `suggested_barcode`'s pool file into this tenant's public folder under
// this p_code and stamp pcode_img — see acceptSuggestion() in
// utils/imageSuggest.js. Nothing here is ever auto-applied.
const imageSuggestionSchema = new mongoose.Schema(
  {
    project_code: {
      type: String,
      required: true,
      trim: true,
    },
    p_code: {
      type: String,
      required: true,
      trim: true,
    },
    product_name: {
      type: String,
      trim: true,
    },
    suffix: {
      type: Number,
      enum: [1, 2],
      default: 1,
    },
    source: {
      type: String,
      enum: ['cross_tenant', 'web_search'],
      required: true,
    },
    // The pool barcode holding the candidate file — for cross_tenant this
    // belongs to a different tenant's product; for web_search it's this
    // product's own barcode (the pool gained a new entry for it).
    suggested_barcode: {
      type: String,
      required: true,
      trim: true,
    },
    // Only set for cross_tenant — which tenant/product the name match came
    // from, for the admin's own judgement call.
    suggested_from_project: { type: String, trim: true },
    suggested_from_name: { type: String, trim: true },
    // Only set for cross_tenant — the text-similarity score (see §02 of
    // the plan). web_search suggestions have no equivalent text score.
    text_score: { type: Number },
    // Only set for web_search — the page Gemini's grounding cited, kept
    // for audit/debugging, never shown as if it were the CDN URL.
    source_url: { type: String, trim: true },
    vision_gemini: {
      verdict: { type: String, enum: ['MATCH', 'NO_MATCH', null], default: null },
      reason: { type: String, trim: true },
    },
    vision_deepseek: {
      verdict: { type: String, enum: ['MATCH', 'NO_MATCH', null], default: null },
      reason: { type: String, trim: true },
    },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected'],
      default: 'pending',
      index: true,
    },
    reviewed_by: { type: mongoose.Schema.Types.ObjectId },
    reviewed_at: { type: Date },
  },
  { timestamps: true, collection: 'imagesuggestions' }
);

imageSuggestionSchema.index({ project_code: 1, p_code: 1, source: 1, suffix: 1 }, { unique: true });
imageSuggestionSchema.index({ project_code: 1, status: 1 });

module.exports = require('./tenantModel')('ImageSuggestion', imageSuggestionSchema);
