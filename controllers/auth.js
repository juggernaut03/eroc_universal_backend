const User = require('../models/User');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const sms = require('../utils/sms');
const { getTenantDb, DEFAULT_DB_NAME } = require('../config/database');
const {
  classifyRefreshToken,
  REFRESH_VERDICT
} = require('../utils/refreshTokenPolicy');

const JWT_SECRET = () => process.env.JWT_SECRET || 'your-secret-key';

// Access tokens are short-lived and refresh tokens carry the session.
//
// The access token used to last 30 days on its own, with nothing to revoke it:
// one intercepted token was a month of authenticated access, and signing out
// on a lost phone did nothing because /logout was a no-op that only returned
// 200. A stolen access token is now worth at most ACCESS_TOKEN_TTL, and the
// refresh token behind it is revocable per device.
const ACCESS_TOKEN_TTL = process.env.JWT_EXPIRE || '7d';
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.JWT_REFRESH_EXPIRE_DAYS || 90);

// `type` separates the two. Without it a refresh token — which lives far longer
// — would sail through `protect` as an access token, and the short access TTL
// would buy nothing.
const generateToken = (userId) => {
  return jwt.sign({ id: userId, type: 'access' }, JWT_SECRET(), {
    expiresIn: ACCESS_TOKEN_TTL
  });
};

// `jti` is what makes rotation real. JWT `iat` has one-second resolution, so a
// refresh issued in the same second as the one it replaces produced a
// byte-identical token: the rotation pulled a hash and then pushed the very
// same hash back, and replaying the "spent" token still worked.
const generateRefreshToken = (userId) => {
  return jwt.sign(
    { id: userId, type: 'refresh', jti: crypto.randomUUID() },
    JWT_SECRET(),
    { expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d` }
  );
};

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// How long a just-rotated refresh token keeps working.
//
// Covers the gap between this server committing a rotation and the client
// persisting the pair it was sent. Long enough to survive a dropped response or
// an app suspended mid-request; short enough that a captured token is not
// meaningfully more useful for having been spent.
const REFRESH_GRACE_MS = Number(process.env.JWT_REFRESH_GRACE_MS || 60_000);

// How long spent entries are kept before pruning, so reuse stays detectable
// well past the grace window rather than looking like an unknown token.
const SUPERSEDED_RETENTION_MS = Number(
  process.env.JWT_REFRESH_SUPERSEDED_RETENTION_MS || 24 * 60 * 60 * 1000
);

/// Issues an access/refresh pair and records the refresh hash against the user.
///
/// Also drops that user's expired hashes, so the array tracks live devices
/// instead of growing forever.
const issueTokens = async (user, device = '') => {
  const accessToken = generateToken(user._id);
  const refreshToken = generateRefreshToken(user._id);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const now = new Date();
  // Drop entries that are expired, and spent ones we have kept long enough to
  // have served their purpose as reuse evidence.
  await User.updateOne(
    { _id: user._id },
    {
      $pull: {
        refreshTokens: {
          $or: [
            { expiresAt: { $lte: now } },
            {
              supersededAt: {
                $ne: null,
                $lte: new Date(now.getTime() - SUPERSEDED_RETENTION_MS)
              }
            }
          ]
        }
      }
    }
  );
  await User.updateOne(
    { _id: user._id },
    {
      $push: {
        refreshTokens: {
          tokenHash: hashToken(refreshToken),
          expiresAt,
          device,
          supersededAt: null
        }
      }
    }
  );

  return {
    token: accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL,
    refreshExpiresAt: expiresAt.toISOString()
  };
};

// Locate an admin by mobile, with the password hash selected.
//
// Mirrors findUserById in middleware/auth.js: admin accounts live in the
// default (admin home) DB and may operate on any tenant, so if the request's
// tenant DB has no such admin we fall back there. Customers are never returned
// by this lookup — only role === 'admin' matches.
//
// The same admin mobile often exists in several tenant DBs, seeded at different
// times, and only some of those copies have a password. Preferring the copy
// that actually has one stops a password-less duplicate in the tenant DB from
// masking the real credential in the home DB.
const findAdminByMobile = async (mobile) => {
  const candidates = [];

  const tenantAdmin = await User.findOne({ mobile, role: 'admin' }).select('+password');
  if (tenantAdmin) {
    if (tenantAdmin.password) {
      return tenantAdmin;
    }
    candidates.push(tenantAdmin);
  }

  const homeDb = getTenantDb(DEFAULT_DB_NAME);
  const HomeUser = homeDb.models.User;
  if (HomeUser) {
    const homeAdmin = await HomeUser.findOne({ mobile, role: 'admin' }).select('+password');
    if (homeAdmin) {
      if (homeAdmin.password) {
        return homeAdmin;
      }
      candidates.push(homeAdmin);
    }
  }

  // Found the account but no copy has a password — return one so the caller can
  // say so specifically rather than "invalid credentials".
  return candidates[0] || null;
};

// @desc    Admin panel login with mobile + password (no OTP / no SMS spend)
// @route   POST /api/auth/admin-login
// @access  Public
const adminLogin = async (req, res) => {
  try {
    const { mobile, password } = req.body;

    if (!mobile || !password) {
      return res.status(400).json({
        success: false,
        message: 'Mobile number and password are required'
      });
    }

    const mobileRegex = /^[6-9]\d{9}$/;
    if (!mobileRegex.test(mobile)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid 10-digit mobile number'
      });
    }

    const user = await findAdminByMobile(mobile);

    // One generic message for "no such admin", "not an admin" and "wrong
    // password" — otherwise this endpoint doubles as an admin-mobile oracle.
    const invalid = () =>
      res.status(401).json({
        success: false,
        message: 'Invalid mobile number or password'
      });

    if (!user) {
      return invalid();
    }

    if (!user.password) {
      return res.status(403).json({
        success: false,
        message: 'No password set for this admin account. Please contact a super admin.'
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return invalid();
    }

    // Checked after the password so a blocked admin learns nothing about
    // which mobile numbers exist that a wrong password wouldn't already tell.
    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been blocked. Please contact a super admin.',
        code: 'ACCOUNT_BLOCKED'
      });
    }

    // Password login proves account ownership, so an admin who never went
    // through the OTP flow still satisfies the isVerified check in protect().
    if (!user.isVerified) {
      user.isVerified = true;
    }

    user.lastActiveAt = new Date();
    user.lastLoginAt = new Date();
    await user.save();

    // The admin panel has no refresh handling yet, so its access token keeps
    // the long TTL it has always had rather than silently dropping to the new
    // 7-day one and signing admins out every week. A refresh token is issued
    // alongside it so the panel can adopt the same flow without an API change;
    // shorten ADMIN_ACCESS_TOKEN_TTL once it does.
    const adminToken = jwt.sign({ id: user._id, type: 'access' }, JWT_SECRET(), {
      expiresIn: process.env.ADMIN_ACCESS_TOKEN_TTL || '30d'
    });
    const { refreshToken: adminRefreshToken, refreshExpiresAt } =
      await issueTokens(user, 'admin-panel');

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token: adminToken,
        refreshToken: adminRefreshToken,
        refreshExpiresAt,
        user: {
          id: user._id,
          mobile: user.mobile,
          name: user.name,
          email: user.email,
          role: user.role,
          isVerified: user.isVerified,
          isSuperAdmin: user.isSuperAdmin || false,
          allowed_project_codes: user.allowed_project_codes || [],
          permissions: user.permissions || {},
          // Deliberately NOT folded into isSuperAdmin — see
          // middleware/checkPermission.js#requireImageCdnAccess. Most super
          // admins should not see the image-CDN tools; this is granted
          // per-admin, not implied by role.
          imageCdnAccess: user.imageCdnAccess || false
        }
      }
    });
  } catch (error) {
    console.error('Admin Login Error:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: error.message
    });
  }
};

// @desc    Send OTP to mobile number
// @route   POST /api/auth/send-otp
// @access  Public
const sendOtp = async (req, res) => {
  try {
    const { mobile } = req.body;

    // Validate mobile number
    if (!mobile) {
      return res.status(400).json({
        success: false,
        message: 'Mobile number is required'
      });
    }

    // Validate mobile number format (10 digits starting with 6-9)
    const mobileRegex = /^[6-9]\d{9}$/;
    if (!mobileRegex.test(mobile)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid 10-digit mobile number'
      });
    }

    // Find or create user
    // We still ensure user exists in DB, even if we don't store OTP there
    const otpUser = await User.findOrCreateByMobile(mobile);

    // Refuse before the SMS goes out - verify-otp would reject the login
    // anyway, so sending the code only spends money and misleads the user.
    if (otpUser.isBlocked) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been blocked. Please contact support.',
        code: 'ACCOUNT_BLOCKED'
      });
    }

    // Send valid OTP via SMS Gateway
    const smsResponse = await sms.sendOtp(mobile);
    console.log(`SMS OTP Sent to ${mobile}:`, smsResponse);

    // Send success response
    res.status(200).json({
      success: true,
      message: 'OTP sent successfully to your mobile number',
      expiresIn: 5 // minutes
    });

  } catch (error) {
    console.error('Send OTP Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP',
      error: error.message
    });
  }
};

// @desc    Verify OTP and login user
// @route   POST /api/auth/verify-otp
// @access  Public
const verifyOtp = async (req, res) => {
  try {
    const { mobile, otp } = req.body;

    // Validate input
    if (!mobile || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Mobile number and OTP are required'
      });
    }

    // Validate mobile number format
    const mobileRegex = /^[6-9]\d{9}$/;
    if (!mobileRegex.test(mobile)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid 10-digit mobile number'
      });
    }

    // Find user by mobile
    const user = await User.findByMobile(mobile);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found. Please request OTP first.'
      });
    }

    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been blocked. Please contact support.',
        code: 'ACCOUNT_BLOCKED'
      });
    }

    // Verify OTP via SMS Gateway Provider
    const isValid = await sms.verifyOtp(mobile, otp);

    if (!isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP or OTP expired'
      });
    }

    // Set last active timestamp and login timestamp
    user.lastActiveAt = new Date();
    user.lastLoginAt = new Date();

    // Clear legacy OTP fields if present
    user.otp = undefined;
    user.otpExpiresAt = undefined;

    // Save verified user (marks as verified if not already)
    const isNewlyVerified = !user.isVerified;
    if (isNewlyVerified) {
      user.isVerified = true;
    }
    await user.save();

    // First-ever successful verification for this account = registration
    // complete. Fire-and-forget so a loyalty hiccup never blocks login.
    if (isNewlyVerified) {
      const LoyaltyRule = require('../models/LoyaltyRule');
      const { creditPoints } = require('../utils/loyaltyEngine');
      const { notifyLoyaltyEvent } = require('../utils/loyaltyNotify');
      (async () => {
        try {
          const rule = await LoyaltyRule.findOne({ event: 'REGISTRATION', status: 'ACTIVE' });
          if (!rule) return;
          const result = await creditPoints({
            user,
            points: rule.pointsValue,
            source: 'REGISTRATION',
            idempotencyKey: `REGISTRATION_${user._id}`,
            status: 'COMPLETED'
          });
          if (!result.duplicate) {
            await notifyLoyaltyEvent(user, {
              title: `Welcome! You earned ${rule.pointsValue} points 🎉`,
              body: 'Thanks for joining — start shopping to earn even more.',
              data: { loyaltyEventType: 'POINTS_EARNED', source: 'REGISTRATION' },
              projectCode: req.tenant?.projectCode
            });
          }
        } catch (e) {
          console.error('[loyalty] registration credit error:', e);
        }
      })();
    }

    // Generate the access/refresh pair
    const tokens = await issueTokens(user, (req.body && req.body.device) || '');

    // Send success response
    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        ...tokens,
        user: {
          id: user._id,
          mobile: user.mobile,
          name: user.name,
          email: user.email,
          role: user.role,
          isVerified: user.isVerified,
          isSuperAdmin: user.isSuperAdmin || false,
          permissions: user.permissions || {},
          addresses: user.addresses,
          favorites: user.favorites
        }
      }
    });

  } catch (error) {
    console.error('Verify OTP Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify OTP',
      error: error.message
    });
  }
};

// @desc    Get current user profile
// @route   GET /api/auth/profile
// @access  Private
const getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).populate('addresses').populate('favorites');

    res.status(200).json({
      success: true,
      data: {
        user
      }
    });

  } catch (error) {
    console.error('Get Profile Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get user profile',
      error: error.message
    });
  }
};

// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
const updateProfile = async (req, res) => {
  try {
    const { name, email } = req.body;

    const user = await User.findById(req.user.id);

    if (name) user.name = name;
    if (email) user.email = email;
    user.updatedAt = new Date();

    await user.save();

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user: {
          id: user._id,
          mobile: user.mobile,
          name: user.name,
          email: user.email,
          role: user.role,
          isVerified: user.isVerified
        }
      }
    });

  } catch (error) {
    console.error('Update Profile Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update profile',
      error: error.message
    });
  }
};

// @desc    Logout user
// @route   POST /api/auth/logout
// @access  Private
const logout = async (req, res) => {
  try {
    // Actually end the session. This used to just return 200 without touching
    // any state, so "log out" on a lost or shared device revoked nothing — the
    // token kept working until it expired on its own.
    const { refreshToken, allDevices } = req.body || {};

    if (allDevices) {
      await User.updateOne({ _id: req.user.id }, { $set: { refreshTokens: [] } });
    } else if (refreshToken) {
      await User.updateOne(
        { _id: req.user.id },
        { $pull: { refreshTokens: { tokenHash: hashToken(refreshToken) } } }
      );
    }

    res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    console.error('Logout Error:', error);
    res.status(500).json({
      success: false,
      message: 'Logout failed',
      error: error.message
    });
  }
};

// @desc    Exchange a refresh token for a fresh access/refresh pair
// @route   POST /api/auth/refresh-token
// @access  Public — the refresh token itself is the credential
const refreshToken = async (req, res) => {
  try {
    const supplied = (req.body && req.body.refreshToken) || '';
    if (!supplied) {
      return res.status(400).json({
        success: false,
        message: 'refreshToken is required'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(supplied, JWT_SECRET());
    } catch (e) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token is invalid or expired'
      });
    }

    // An access token must not be spendable as a refresh token.
    if (decoded.type !== 'refresh') {
      return res.status(401).json({
        success: false,
        message: 'Refresh token is invalid or expired'
      });
    }

    const user = await User.findById(decoded.id).select('+refreshTokens');
    if (!user || !user.isVerified) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token is invalid or expired'
      });
    }

    // Blocking clears stored refresh tokens, so this normally never fires -
    // it covers a token minted in the same instant the block was applied.
    if (user.isBlocked) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been blocked. Please contact support.',
        code: 'ACCOUNT_BLOCKED'
      });
    }

    // A signature alone is not enough: the hash must still be on the account,
    // which is what makes logout and revocation mean anything.
    const suppliedHash = hashToken(supplied);
    const stored = (user.refreshTokens || []).find((t) => t.tokenHash === suppliedHash);
    const now = new Date();

    if (!stored || stored.expiresAt <= now) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token is invalid or expired'
      });
    }


    const verdict = classifyRefreshToken(stored, now, REFRESH_GRACE_MS);

    if (verdict === REFRESH_VERDICT.REUSE) {
      // Reuse of a token rotated away long enough ago that a well-behaved
      // client cannot still be holding it — it has had the replacement since.
      // Treat it as captured and end every session on the account. The
      // legitimate owner signs in again; whoever replayed it gets nothing.
      console.warn(
        `Refresh token reuse detected for user ${user._id} — revoking all sessions`
      );
      await User.updateOne({ _id: user._id }, { $set: { refreshTokens: [] } });
      return res.status(401).json({
        success: false,
        message: 'Refresh token is invalid or expired'
      });
    }

    if (verdict === REFRESH_VERDICT.RETRY) {
      // Inside the grace window: the client is retrying because it never
      // received — or never managed to store — the pair already issued. Hand it
      // a fresh one rather than ending a session that is plainly alive.
      console.warn(`Refresh retry within grace window for user ${user._id} — reissuing`);
      const retryTokens = await issueTokens(user, stored.device || '');

      return res.status(200).json({
        success: true,
        message: 'Token refreshed',
        data: {
          ...retryTokens,
          user: {
            id: user._id,
            mobile: user.mobile,
            name: user.name,
            email: user.email,
            role: user.role,
            isVerified: user.isVerified
          }
        }
      });
    }

    // Rotate: this token is spent. It is marked rather than deleted so a client
    // that loses the reply can retry inside REFRESH_GRACE_MS, and a replay
    // after that is recognisable as reuse instead of looking like an unknown
    // token. Deleting it outright is what turned a dropped response into a
    // silent sign-out.
    await User.updateOne(
      { _id: user._id, 'refreshTokens.tokenHash': suppliedHash },
      { $set: { 'refreshTokens.$.supersededAt': now } }
    );
    const tokens = await issueTokens(user, stored.device || '');

    res.status(200).json({
      success: true,
      message: 'Token refreshed',
      data: {
        ...tokens,
        user: {
          id: user._id,
          mobile: user.mobile,
          name: user.name,
          email: user.email,
          role: user.role,
          isVerified: user.isVerified
        }
      }
    });
  } catch (error) {
    console.error('Refresh Token Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to refresh token',
      error: error.message
    });
  }
};

// @desc    Heartbeat / IsActive - update session + activity
// @route   POST /api/auth/is-active
// @access  Private
const isActive = async (req, res) => {
  try {
    const { sessionId, device } = req.body || {};
    const user = await User.findById(req.user.id);

    const now = new Date();
    const ACTIVE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes considered "active"

    // Start a new session if none or mismatched
    if (!user.currentSession?.sessionId || (sessionId && sessionId !== user.currentSession.sessionId)) {
      const newId = user.startSession(device);
      // If client sent a mismatched sessionId, send the new one back
      await user.save();
      return res.status(200).json({
        success: true,
        data: {
          isActive: true,
          lastActiveAt: user.lastActiveAt,
          session: {
            sessionId: newId,
            startedAt: user.currentSession.startedAt,
            lastSeenAt: user.currentSession.lastSeenAt,
            durationMs: user.currentSession.durationMs,
            device: user.currentSession.device
          },
          totalActiveMs: user.totalActiveMs,
          activeWindowMs: ACTIVE_WINDOW_MS
        }
      });
    }

    // Existing session: update activity
    user.touchActivity(now);
    await user.save();

    return res.status(200).json({
      success: true,
      data: {
        isActive: user.isActiveWithin(ACTIVE_WINDOW_MS),
        lastActiveAt: user.lastActiveAt,
        session: {
          sessionId: user.currentSession.sessionId,
          startedAt: user.currentSession.startedAt,
          lastSeenAt: user.currentSession.lastSeenAt,
          durationMs: user.currentSession.durationMs,
          device: user.currentSession.device
        },
        totalActiveMs: user.totalActiveMs,
        activeWindowMs: ACTIVE_WINDOW_MS
      }
    });
  } catch (error) {
    console.error('IsActive Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user activity',
      error: error.message
    });
  }
};

// @desc    Save FCM token for push notifications
// @route   POST /api/auth/save-fcm-token
// @access  Private
const saveFcmToken = async (req, res) => {
  try {
    const { fcmToken } = req.body;

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        message: 'FCM token is required'
      });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Save FCM token
    user.fcmToken = fcmToken;
    await user.save();

    res.status(200).json({
      success: true,
      message: 'FCM token saved successfully'
    });

  } catch (error) {
    console.error('Save FCM Token Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save FCM token',
      error: error.message
    });
  }
};

module.exports = {
  sendOtp,
  verifyOtp,
  adminLogin,
  refreshToken,
  getProfile,
  updateProfile,
  logout,
  isActive,
  saveFcmToken
};
