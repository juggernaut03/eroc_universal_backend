const express = require('express');
const router = express.Router();
const { getProjectModel } = require('../../models/Project');
const { checkPermission, requireSuperAdmin } = require('../../middleware/checkPermission');
const { clearTenantCache } = require('../../middleware/tenant');
const { clearSecretsCache } = require('../../utils/tenantIntegrations');
const { clearClientCache } = require('../../utils/razorpayService');
const { clearFirebaseAppCache } = require('../../utils/fcm');

// Branding/app settings ride on the dynamicSection permission group like
// other merchandised content. requireProjectAccess (mounted on /api/admin)
// already guarantees the admin may act on the resolved project.
const view = checkPermission('dynamicSection', 'view');
const edit = checkPermission('dynamicSection', 'edit');

// Only these config keys are editable from the panel. Notably absent:
// razorpay_key_id / currency (payment-critical, managed server-side) and
// anything outside config (db_name, status, project_code).
const EDITABLE_FIELDS = [
  'app_name',
  'logo_url',
  'primary_color',
  'secondary_color',
  'accent_color',
  'background_color',
  'text_primary_color',
  'text_secondary_color',
  'success_color',
  'warning_color',
  'error_color',
  'info_color',
  'font_family',
  'contact_email',
  'contact_phone',
  'min_app_version',
  'latest_app_version',
  'android_store_url',
  'ios_store_url',
  'force_update_message',

  // Splash screen — managed from the panel's Mobile App > App Settings page.
  // The mobile app applies these from its cached config before the first
  // frame, so a change lands on the next launch without a rebuild.
  'splash_logo_url',
  'splash_logo_size',
  'splash_background_color',
  'splash_background_image_url',
  'splash_tagline',
  'splash_tagline_color',
  'splash_animation',
  'splash_duration_ms',
  'splash_show_loader',

  // Home screen rollout.
  'home_feed_enabled',
];

// Publishable integration values. Split out because they are edited on the
// Integrations page by super admins only — a wrong payment key id breaks
// checkout for every user, which is a different class of mistake from a wrong
// brand colour. Secrets are never in this list; see the /secrets route.
const INTEGRATION_FIELDS = ['razorpay_key_id', 'currency', 'google_maps_api_key'];

// Write-only. Stored on project.secrets (select: false) and never returned by
// any endpoint — the panel shows whether one is set, never its value.
const SECRET_FIELDS = ['razorpay_key_secret', 'sms_api_key', 'firebase_service_account_json'];

const COLOR_FIELDS = EDITABLE_FIELDS.filter((f) => f.endsWith('_color'));
const HEX_COLOR = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const SPLASH_ANIMATIONS = ['fade', 'scale', 'fade_scale', 'none'];

// Numeric fields, with the range the mobile app can actually render.
const NUMERIC_FIELDS = {
  splash_logo_size: { min: 40, max: 600, label: 'Splash logo size' },
  splash_duration_ms: { min: 0, max: 10000, label: 'Splash duration' },
};

const BOOLEAN_FIELDS = ['splash_show_loader', 'home_feed_enabled'];

// Returns an error message, or null when the value is acceptable. Empty
// clears the field and always passes — that is how a tenant reverts to the
// app's built-in default.
function validateField(field, value) {
  if (!value) return null;

  if (COLOR_FIELDS.includes(field) && !HEX_COLOR.test(value)) {
    return `${field} must be a hex color like #RRGGBB`;
  }

  if (field === 'splash_animation' && !SPLASH_ANIMATIONS.includes(value)) {
    return `splash_animation must be one of: ${SPLASH_ANIMATIONS.join(', ')}`;
  }

  const numeric = NUMERIC_FIELDS[field];
  if (numeric) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < numeric.min || parsed > numeric.max) {
      return `${numeric.label} must be a number between ${numeric.min} and ${numeric.max}`;
    }
  }

  if (BOOLEAN_FIELDS.includes(field) && value !== 'true' && value !== 'false') {
    return `${field} must be "true" or "false"`;
  }

  return null;
}

// @route   GET /api/admin/project-settings
// @desc    Full config of the currently selected project
// @access  Admin (dynamicSection view)
router.get('/', view, async (req, res) => {
  try {
    const Project = getProjectModel();
    const project = await Project.findOne({
      project_code: req.tenant.projectCode,
    }).lean();

    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    res.status(200).json({
      success: true,
      data: {
        project_code: project.project_code,
        client_name: project.client_name,
        config: project.config || {},
        editable_fields: EDITABLE_FIELDS,
      },
    });
  } catch (error) {
    console.error('Get project settings error:', error);
    res.status(500).json({ success: false, message: 'Error fetching project settings', error: error.message });
  }
});

// @route   PUT /api/admin/project-settings
// @desc    Update branding/app config of the currently selected project
// @access  Admin (dynamicSection edit)
router.put('/', edit, async (req, res) => {
  try {
    const body = req.body || {};
    const $set = {};

    for (const field of EDITABLE_FIELDS) {
      if (!(field in body)) continue;
      const value = body[field] === null ? '' : String(body[field]).trim();

      const error = validateField(field, value);
      if (error) {
        return res.status(400).json({ success: false, message: error });
      }
      $set[`config.${field}`] = value;
    }

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ success: false, message: 'No editable fields provided' });
    }

    const Project = getProjectModel();
    const project = await Project.findOneAndUpdate(
      { project_code: req.tenant.projectCode },
      { $set },
      { new: true, runValidators: true }
    ).lean();

    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    // The tenant resolver caches registry docs for 60s — flush so the public
    // /api/project-config reflects the new branding immediately.
    clearTenantCache();

    res.status(200).json({
      success: true,
      message: 'Project settings saved successfully',
      data: {
        project_code: project.project_code,
        client_name: project.client_name,
        config: project.config || {},
      },
    });
  } catch (error) {
    console.error('Update project settings error:', error);
    res.status(500).json({ success: false, message: 'Error saving project settings', error: error.message });
  }
});

// @route   GET /api/admin/project-settings/integrations
// @desc    Publishable integration values, plus whether each secret is set
// @access  Super admin
router.get('/integrations', requireSuperAdmin, async (req, res) => {
  try {
    const Project = getProjectModel();
    // secrets are select:false — ask for them explicitly, and only to report
    // whether they exist.
    const project = await Project.findOne({ project_code: req.tenant.projectCode })
      .select('+secrets.razorpay_key_secret +secrets.sms_api_key +secrets.firebase_service_account_json')
      .lean();

    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    const config = project.config || {};
    const secrets = project.secrets || {};

    res.status(200).json({
      success: true,
      data: {
        project_code: project.project_code,
        integrations: INTEGRATION_FIELDS.reduce((acc, field) => {
          acc[field] = config[field] || '';
          return acc;
        }, {}),
        // Presence only, never the value.
        secrets_set: SECRET_FIELDS.reduce((acc, field) => {
          acc[field] = Boolean(secrets[field]);
          return acc;
        }, {}),
      },
    });
  } catch (error) {
    console.error('Get integrations error:', error);
    res.status(500).json({ success: false, message: 'Error fetching integrations', error: error.message });
  }
});

// @route   PUT /api/admin/project-settings/integrations
// @desc    Update publishable integration values
// @access  Super admin
router.put('/integrations', requireSuperAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const $set = {};

    for (const field of INTEGRATION_FIELDS) {
      if (!(field in body)) continue;
      const value = body[field] === null ? '' : String(body[field]).trim();

      if (value && /\s/.test(value)) {
        return res.status(400).json({ success: false, message: `${field} must not contain spaces` });
      }
      if (field === 'currency' && value && !/^[A-Za-z]{3}$/.test(value)) {
        return res.status(400).json({ success: false, message: 'currency must be a 3-letter code like INR' });
      }

      $set[`config.${field}`] = field === 'currency' ? value.toUpperCase() : value;
    }

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ success: false, message: 'No integration fields provided' });
    }

    const Project = getProjectModel();
    const project = await Project.findOneAndUpdate(
      { project_code: req.tenant.projectCode },
      { $set },
      { new: true, runValidators: true }
    ).lean();

    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    clearTenantCache();

    const config = project.config || {};
    res.status(200).json({
      success: true,
      message: 'Integrations saved successfully',
      data: {
        project_code: project.project_code,
        integrations: INTEGRATION_FIELDS.reduce((acc, field) => {
          acc[field] = config[field] || '';
          return acc;
        }, {}),
      },
    });
  } catch (error) {
    console.error('Update integrations error:', error);
    res.status(500).json({ success: false, message: 'Error saving integrations', error: error.message });
  }
});

// @route   PUT /api/admin/project-settings/secrets
// @desc    Overwrite server-side credentials. Write-only: nothing is returned.
// @access  Super admin
router.put('/secrets', requireSuperAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const $set = {};
    const updated = [];

    for (const field of SECRET_FIELDS) {
      if (!(field in body)) continue;
      const value = String(body[field] ?? '').trim();

      // The service account is pasted/uploaded as raw JSON — catch a
      // malformed paste here rather than storing something getFirebaseApp()
      // can only fail on at send time.
      if (field === 'firebase_service_account_json' && value) {
        try {
          JSON.parse(value);
        } catch {
          return res.status(400).json({
            success: false,
            message: 'firebase_service_account_json must be valid JSON',
          });
        }
      }

      // An empty string is a deliberate clear; the panel sends the field only
      // when the admin typed something or asked to remove it.
      $set[`secrets.${field}`] = value;
      updated.push(field);
    }

    if (updated.length === 0) {
      return res.status(400).json({ success: false, message: 'No secret fields provided' });
    }

    const Project = getProjectModel();
    const project = await Project.findOneAndUpdate(
      { project_code: req.tenant.projectCode },
      { $set },
      { new: true }
    ).lean();

    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    // All three caches, not just the registry.
    //
    // Only clearTenantCache() was called here, and it clears the project_code
    // -> document map. The credential caches were left holding the superseded
    // values: `secretsCache` for its 60s TTL, and — the one that mattered —
    // razorpayService's client cache forever, since it had no TTL and nothing
    // ever called clearClientCache().
    //
    // The effect was that saving a corrected Razorpay secret appeared to work,
    // the panel reported the secret as set, the database held the right value,
    // and every order kept being signed with the old one. Razorpay answered
    // "Authentication failed" against credentials that were, by inspection,
    // entirely correct — and only a restart of the API fixed it.
    clearTenantCache();
    clearSecretsCache();
    clearClientCache();
    clearFirebaseAppCache(req.tenant.projectCode);

    res.status(200).json({
      success: true,
      message: `Updated: ${updated.join(', ')}`,
      data: { updated },
    });
  } catch (error) {
    console.error('Update secrets error:', error);
    res.status(500).json({ success: false, message: 'Error saving secrets', error: error.message });
  }
});

module.exports = router;
