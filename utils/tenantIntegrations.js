const { getProjectModel } = require('../models/Project');
const { getTenantProject } = require('../config/tenantContext');

// Per-tenant integration credentials.
//
// The data layer is multi-tenant but the integrations were not: Razorpay and
// SMS both read a single set of process.env keys, so every client's payments
// landed in one merchant account. These resolvers prefer the credentials stored
// on the tenant's registry document and fall back to env only when the tenant
// has none configured.
//
// Secrets live behind `select: false` and are deliberately NOT loaded into
// req.tenant by the tenant middleware — anything that returns the project
// document would leak them. They are fetched here, on demand, and cached
// briefly on the same 60s horizon the tenant registry cache uses.

const CACHE_TTL_MS = 60 * 1000;
const secretsCache = new Map();

const loadSecrets = async (projectCode) => {
  const cached = secretsCache.get(projectCode);
  if (cached && cached.expires > Date.now()) {
    return cached.secrets;
  }

  const Project = getProjectModel();
  const doc = await Project.findOne({ project_code: projectCode })
    .select('+secrets.razorpay_key_secret +secrets.sms_api_key +secrets.picker_webhook_secret')
    .lean();

  const secrets = doc?.secrets || {};
  secretsCache.set(projectCode, { secrets, expires: Date.now() + CACHE_TTL_MS });
  return secrets;
};

const clearSecretsCache = () => secretsCache.clear();


const allowPlatformFallback = () =>
  process.env.ALLOW_PLATFORM_RAZORPAY_FALLBACK === 'true';

/**
 * Razorpay key pair for the current tenant.
 *
 * Key id and secret are resolved as a PAIR, never mixed: a tenant key_id
 * combined with the platform secret would produce signatures that verify
 * against nothing. A tenant must configure both to be treated as configured.
 *
 * Credentials belong to the tenant registry (admin panel → Integrations), not
 * to the environment. The env pair is a fallback for single-tenant and local
 * installs, gated by ALLOW_PLATFORM_RAZORPAY_FALLBACK.
 */
const getRazorpayCredentials = async (project) => {
  const tenant = project || getTenantProject();

  if (tenant?.project_code) {
    const secrets = await loadSecrets(tenant.project_code);
    const keyId = tenant.config?.razorpay_key_id;
    const keySecret = secrets.razorpay_key_secret;

    if (keyId && keySecret) {
      return { keyId, keySecret, source: 'tenant', projectCode: tenant.project_code };
    }

    // Half-configured is the dangerous state, and it used to be silent: the
    // tenant advertises a key_id through /api/project-config, but with no
    // secret here the order is created under the platform's env pair instead.
    // Clients that took their checkout key from project-config then opened a
    // payment against an order belonging to another Razorpay account.
    if (keyId && !keySecret) {
      console.warn(
        `⚠️  Tenant ${tenant.project_code} has razorpay_key_id configured but no ` +
        'razorpay_key_secret — set the secret (admin panel → Integrations), or ' +
        'clear the key id, so both halves come from one account.'
      );
    }

    if (!allowPlatformFallback()) {
      const error = new Error(
        `Razorpay is not configured for project ${tenant.project_code}. ` +
        'Set razorpay_key_id and razorpay_key_secret for this tenant, or set ' +
        'ALLOW_PLATFORM_RAZORPAY_FALLBACK=true to use the platform account.'
      );
      error.statusCode = 503;
      throw error;
    }

    console.warn(
      `⚠️  Tenant ${tenant.project_code} has no Razorpay credentials — taking ` +
      "payments into the PLATFORM's merchant account. This is only correct on a " +
      'single-tenant or local install.'
    );
  }

  return {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    source: 'env',
    projectCode: tenant?.project_code || null,
  };
};

/**
 * SMS gateway config for the current tenant.
 *
 * The gateway account itself is shared (one platform account), but the sender
 * identity in the message body is per-tenant — otherwise every client's
 * customers receive an OTP addressed to whichever brand is in the env file.
 */
const getSmsConfig = (project) => {
  const tenant = project || getTenantProject();

  return {
    baseUrl: process.env.SMS_BASE_URL,
    userId: process.env.SMS_USER_ID,
    password: process.env.SMS_PASSWORD,
    senderId: process.env.SMS_SENDER_ID,
    // Tenant brand name drives the OTP message text.
    clientName:
      tenant?.config?.app_name ||
      tenant?.client_name ||
      process.env.SMS_CLIENT_NAME ||
      'Customer',
  };
};

/**
 * SHALVI PICKER (warehouse picking + rider delivery) webhook config for the
 * current tenant. `enabled` is false unless explicitly turned on from the
 * admin panel's Integrations page, after webhook_url/secret are set and a
 * pilot order has been walked through end to end.
 */
const getPickerIntegrationConfig = async (project) => {
  const tenant = project || getTenantProject();
  if (!tenant?.project_code) return { enabled: false };

  const secrets = await loadSecrets(tenant.project_code);
  return {
    enabled: tenant.config?.picker_integration_enabled === 'true',
    webhookUrl: tenant.config?.picker_webhook_url || '',
    webhookSecret: secrets.picker_webhook_secret || '',
    projectCode: tenant.project_code,
  };
};

module.exports = {
  getRazorpayCredentials,
  getSmsConfig,
  getPickerIntegrationConfig,
  clearSecretsCache,
};
