const mongoose = require('mongoose');
const { getControlDb } = require('../config/database');

// Tenant registry — lives in the control DB, NOT in any tenant DB.
// Onboarding a new client = one document here + a restored/seeded tenant DB.
const projectSchema = new mongoose.Schema(
  {
    project_code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    client_name: {
      type: String,
      required: true,
      trim: true,
    },
    db_name: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    // Public, frontend-safe config served by GET /api/project-config so a
    // single app/admin codebase can brand itself per client at runtime.
    config: {
      app_name: { type: String, default: '' },
      logo_url: { type: String, default: '' },
      splash_logo_url: { type: String, default: '' },
      // Theme tokens consumed by the mobile app at runtime. Empty string =
      // app falls back to its built-in default for that token.
      primary_color: { type: String, default: '' },
      secondary_color: { type: String, default: '' },
      accent_color: { type: String, default: '' },
      background_color: { type: String, default: '' },
      text_primary_color: { type: String, default: '' },
      text_secondary_color: { type: String, default: '' },
      success_color: { type: String, default: '' },
      warning_color: { type: String, default: '' },
      error_color: { type: String, default: '' },
      info_color: { type: String, default: '' },
      // Google Fonts family name (e.g. "Poppins", "Inter").
      font_family: { type: String, default: '' },
      contact_email: { type: String, default: '' },
      contact_phone: { type: String, default: '' },
      currency: { type: String, default: 'INR' },
      razorpay_key_id: { type: String, default: '' },
      // Publishable Google Maps key. Public by nature — it ships inside the
      // app binary — so it is restricted by bundle id in Google Cloud, not by
      // being kept out of this response.
      google_maps_api_key: { type: String, default: '' },
      // Mobile app force-update policy (consumed by the Flutter app at launch).
      min_app_version: { type: String, default: '' },
      latest_app_version: { type: String, default: '' },
      android_store_url: { type: String, default: '' },
      ios_store_url: { type: String, default: '' },
      force_update_message: { type: String, default: '' },
      // Splash screen, edited under Mobile App > App Settings. Declared here
      // because `config` is a strict subdocument — a key missing from this
      // schema is dropped on save without an error.
      splash_logo_size: { type: String, default: '' },
      splash_background_color: { type: String, default: '' },
      splash_background_image_url: { type: String, default: '' },
      splash_tagline: { type: String, default: '' },
      splash_tagline_color: { type: String, default: '' },
      splash_animation: { type: String, default: '' },
      splash_duration_ms: { type: String, default: '' },
      splash_show_loader: { type: String, default: '' },
      // Rollout switch for the server-defined home feed. 'true' renders home
      // from POST /api/home/feed; anything else keeps the layout compiled
      // into the app.
      home_feed_enabled: { type: String, default: '' },
      // Which pre-installed launcher icon the app should be showing right
      // now (campaign/seasonal branding switched without a store update —
      // every variant is baked into the app binary at build time; this only
      // picks which already-shipped one is active). The app reads this at
      // launch and calls the platform's icon-switch API; nothing happens
      // for a build that never bundled the variant being asked for.
      active_app_icon: { type: String, enum: ['default', 'festival', 'premium'], default: 'default' },
    },
    // Server-side only credentials (never returned by public endpoints).
    secrets: {
      razorpay_key_secret: { type: String, default: '', select: false },
      sms_api_key: { type: String, default: '', select: false },
      // Full Admin SDK service account JSON (as a string) for this tenant's
      // OWN Firebase project. Each app flavor mints FCM tokens against its
      // own project (android/app/src/<flavor>/google-services.json), not a
      // shared one — sending via a different project's credentials fails
      // outright with "SenderId mismatch". Unset means this tenant falls
      // back to the shared FIREBASE_SERVICE_ACCOUNT_JSON app (see utils/fcm.js).
      firebase_service_account_json: { type: String, default: '', select: false },
    },
  },
  { timestamps: true, collection: 'projects' }
);

// Compiled on the control connection (not a tenant proxy).
const getProjectModel = () => {
  const controlDb = getControlDb();
  return controlDb.models.Project || controlDb.model('Project', projectSchema);
};

module.exports = { getProjectModel, projectSchema };
