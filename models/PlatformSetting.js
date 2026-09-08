const mongoose = require('mongoose');
const { getControlDb } = require('../config/database');

// Singleton, platform-wide settings — lives in the control DB, same as
// Project. The image-match-suggestions engine (utils/imageSuggest.js) is
// deliberately cross-tenant (one shared pool, one shared index across all
// tenants), so its API keys are a single platform-wide setting too, not
// per-project — set once by whichever admin has imageCdnAccess, used for
// every tenant's suggestion generation.
//
// Write-only, same convention as Project.secrets (routes/admin/project-
// settings.js): select: false, never returned by any endpoint — the panel
// shows whether a key is set, never the value itself.
const platformSettingSchema = new mongoose.Schema(
  {
    gemini_api_key: {
      type: String,
      trim: true,
      select: false,
    },
    gemini_api_key_updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      select: false,
    },
    gemini_api_key_updated_at: {
      type: Date,
      select: false,
    },
    // Google Programmable Search Engine (Custom Search JSON API) — an
    // opt-in, much cheaper alternative search step to Gemini's Grounding
    // tool (~$5/1,000 queries vs. Grounding's flat per-request tool fee —
    // see config/geminiPricing.js's cost comparison). Used ahead of Gemini
    // grounding when both are configured; Gemini grounding stays the
    // fallback so nothing breaks for a tenant that hasn't set this up.
    google_cse_api_key: {
      type: String,
      trim: true,
      select: false,
    },
    // The Search Engine ID ("cx") from programmablesearchengine.google.com
    // — not secret on its own, but kept write-only for consistency with
    // the rest of this document.
    google_cse_id: {
      type: String,
      trim: true,
      select: false,
    },
    google_cse_updated_by: {
      type: mongoose.Schema.Types.ObjectId,
      select: false,
    },
    google_cse_updated_at: {
      type: Date,
      select: false,
    },
  },
  { timestamps: true, collection: 'platformsettings' }
);

const getPlatformSettingModel = () => {
  const controlDb = getControlDb();
  return controlDb.models.PlatformSetting || controlDb.model('PlatformSetting', platformSettingSchema);
};

// There is only ever one document. Creates it on first use rather than
// requiring a migration/seed step.
async function getOrCreateSettings(select) {
  const Model = getPlatformSettingModel();
  let query = Model.findOne({});
  if (select) query = query.select(select);
  let doc = await query;
  if (!doc) {
    doc = await Model.create({});
  }
  return doc;
}

module.exports = { getPlatformSettingModel, getOrCreateSettings };
