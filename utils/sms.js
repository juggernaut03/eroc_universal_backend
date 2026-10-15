const axios = require('axios');

const { getSmsConfig } = require('./tenantIntegrations');
const { toInternational } = require('./phone');

// SMS OTP gateway.
//
// Credentials come from env only — there are deliberately no hardcoded
// fallbacks here. A missing SMS_USER_ID/SMS_PASSWORD must fail loudly rather
// than silently authenticate as somebody else's gateway account.

const DEFAULT_BASE_URL = 'https://unify.smsgateway.center/SMSApi/otp';

// Fixed-OTP escape hatch for local development and automated tests.
//
// This used to be unconditional: verifyOtp() returned true for a hardcoded
// constant, for ANY mobile number, with no gateway round trip — an
// authentication bypass for every customer account. It is now off unless
// explicitly switched on, and the constant has no default value.
const testOtpEnabled = () =>
  process.env.SMS_ALLOW_TEST_OTP === 'true' && Boolean(process.env.SMS_TEST_OTP);

// Surfaced at startup so an operator cannot leave this on by accident.
const warnIfTestOtpEnabled = () => {
  if (testOtpEnabled()) {
    console.warn(
      '⚠️  SMS_ALLOW_TEST_OTP is enabled — the fixed test OTP will authenticate ' +
      'ANY mobile number. Never enable this on a production deployment.'
    );
  }
};

const requireCredentials = (config) => {
  if (!config.userId || !config.password) {
    throw new Error(
      'SMS gateway is not configured. Set SMS_USER_ID and SMS_PASSWORD.'
    );
  }
};

/**
 * Send OTP via SMS Gateway. Uses the provider's generate functionality.
 * @param {string} mobile Local mobile number (Indian or Malaysian)
 * @param {object} [project] Tenant project doc; defaults to the current request's tenant
 * @returns {Promise<Object>} Response from gateway
 */
const sendOtp = async (mobile, project) => {
  const config = getSmsConfig(project);

  // Test mode with no gateway account yet: skip the SMS so the login flow can
  // reach verifyOtp, where the fixed SMS_TEST_OTP is accepted.
  if (testOtpEnabled() && (!config.userId || !config.password)) {
    console.warn(`⚠️  Test OTP mode: no SMS sent to ${mobile} (gateway not configured)`);
    return { status: 'success', testMode: true };
  }

  requireCredentials(config);

  try {
    // Format mobile with 91 prefix if not present
    const formattedMobile = toInternational(mobile);

    // Construct message template - note the escaped $otp$ which the provider replaces.
    // The text must match the DLT template registered for SMS_SENDER_ID exactly.
    const teamName = process.env.SMS_TEAM_NAME || 'JustPress Solutions';
    const msg = `Dear ${config.clientName} Customer $otp$ is the One Time Password (OTP) for verifying your Mobile number. - Team ${teamName}.`;

    const params = new URLSearchParams();
    params.append('userid', config.userId);
    params.append('password', config.password);
    params.append('mobile', formattedMobile);
    params.append('msg', msg);
    params.append('senderid', config.senderId);
    params.append('msgType', 'text');
    params.append('format', 'json');
    params.append('sendMethod', 'generate');
    params.append('renew', 'true');
    params.append('codeType', 'num');
    params.append('codeExpiry', '300'); // 5 minutes
    params.append('codeLength', '4');

    const response = await axios.post(config.baseUrl || DEFAULT_BASE_URL, params);
    return response.data;
  } catch (error) {
    console.error('SMS Send Error:', error.response?.data || error.message);
    throw error;
  }
};

/**
 * Verify OTP via SMS Gateway.
 * @param {string} mobile Local mobile number (Indian or Malaysian)
 * @param {string} otp OTP to verify
 * @param {object} [project] Tenant project doc; defaults to the current request's tenant
 * @returns {Promise<boolean>} True if valid, false otherwise
 */
const verifyOtp = async (mobile, otp, project) => {
  // Explicitly enabled test OTP (local dev / CI only).
  if (testOtpEnabled() && otp === process.env.SMS_TEST_OTP) {
    console.warn(`⚠️  Test OTP accepted for ${mobile} (SMS_ALLOW_TEST_OTP is on)`);
    return true;
  }

  const config = getSmsConfig(project);

  // Test mode with no gateway account: only the fixed test OTP can be valid.
  if (testOtpEnabled() && (!config.userId || !config.password)) {
    return false;
  }

  requireCredentials(config);

  try {
    // Format mobile with 91 prefix
    const formattedMobile = toInternational(mobile);

    const params = new URLSearchParams();
    params.append('userid', config.userId);
    params.append('password', config.password);
    params.append('mobile', formattedMobile);
    params.append('otp', otp);
    params.append('sendMethod', 'verify');
    params.append('format', 'json');

    const response = await axios.post(config.baseUrl || DEFAULT_BASE_URL, params);
    const data = response.data;

    if (data && (data.status === 'success' || data.responseCode === '3001' || data.msg === 'success')) {
      return true;
    }

    console.log('OTP Verification Failed:', data);
    return false;
  } catch (error) {
    console.error('SMS Verify Error:', error.response?.data || error.message);
    return false;
  }
};

module.exports = {
  sendOtp,
  verifyOtp,
  warnIfTestOtpEnabled,
};
