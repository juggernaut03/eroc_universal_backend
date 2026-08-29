const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { getTenantDb, DEFAULT_DB_NAME } = require('../config/database');

// Resolve the user for a token. Regular customers live in the current
// tenant's DB. Admin accounts live in the default (admin home) DB and may
// operate on any tenant, so fall back there — but only for admins, keeping
// customer identities strictly tenant-scoped.
const findUserById = async (id) => {
  const user = await User.findById(id);
  if (user) {
    return user;
  }

  const homeDb = getTenantDb(DEFAULT_DB_NAME);
  const HomeUser = homeDb.models.User;
  const homeUser = HomeUser ? await HomeUser.findById(id) : null;
  return homeUser && homeUser.role === 'admin' ? homeUser : null;
};

// Protect routes - verify JWT token
const protect = async (req, res, next) => {
  try {
    let token;

    // Check if token exists in header
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer')
    ) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.'
      });
    }

    try {
      // Verify token
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || 'your-secret-key'
      );

      // Refresh tokens are signed with the same secret but live far longer, so
      // one presented here would otherwise authenticate ordinary requests for
      // its whole 90 days and make the short access TTL pointless. Tokens
      // issued before `type` existed carry no claim and are still accepted, so
      // upgrading the server does not sign everyone out.
      if (decoded.type && decoded.type !== 'access') {
        return res.status(401).json({
          success: false,
          message: 'Token is not valid.'
        });
      }

      // Get user from token
      const user = await findUserById(decoded.id);

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Token is not valid. User not found.'
        });
      }

      if (!user.isVerified) {
        return res.status(401).json({
          success: false,
          message: 'Please verify your mobile number first.'
        });
      }

      // Checked on every authenticated request, not just at login, so a block
      // applied by a super admin takes effect immediately on tokens already in
      // the wild rather than when they happen to expire.
      if (user.isBlocked) {
        return res.status(403).json({
          success: false,
          message: 'Your account has been blocked. Please contact support.',
          code: 'ACCOUNT_BLOCKED'
        });
      }

      req.user = user;
      next();

    } catch (error) {
      return res.status(401).json({
        success: false,
        message: 'Token is not valid.'
      });
    }

  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error in authentication'
    });
  }
};

// Check if user is admin
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `User role ${req.user.role} is not authorized to access this route`
      });
    }
    next();
  };
};

// Optional auth - doesn't fail if no token, but adds user if token is valid
const optionalAuth = async (req, res, next) => {
  try {
    let token;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer')
    ) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
      try {
        const decoded = jwt.verify(
          token,
          process.env.JWT_SECRET || 'your-secret-key'
        );

        const user = await findUserById(decoded.id);

        if (user && user.isVerified && !user.isBlocked) {
          req.user = user;
        }
      } catch (error) {
        // Ignore invalid tokens in optional auth
      }
    }

    next();

  } catch (error) {
    next();
  }
};

module.exports = {
  protect,
  authorize,
  optionalAuth
};
