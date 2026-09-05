const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  mobile: {
    type: String,
    required: [true, 'Mobile number is required'],
    unique: true,
    match: [/^[6-9]\d{9}$/, 'Please enter a valid 10-digit mobile number']
  },
  // Admin-panel credential. Customers keep using OTP and never set this, so
  // it stays optional. Never selected by default — an admin list query must
  // not be able to leak hashes.
  password: {
    type: String,
    required: false,
    select: false
  },
  otp: {
    type: String,
    required: false
  },
  otpExpiresAt: {
    type: Date,
    required: false
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  name: {
    type: String,
    trim: true,
    maxlength: [50, 'Name cannot be more than 50 characters']
  },
  email: {
    type: String,
    lowercase: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  // Optional. Only used by the loyalty BIRTHDAY earning rule
  // (scripts/loyalty_award_birthday_points.js) - never required at signup.
  dateOfBirth: {
    type: Date,
    default: null
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  isSuperAdmin: {
    type: Boolean,
    default: false
  },
  // Account block. Only a super admin can set this (see routes/admin/users.js).
  // A blocked account keeps all of its data — orders, addresses, loyalty — but
  // cannot log in and is rejected on every authenticated request, so an
  // already-issued token stops working the moment the block lands.
  isBlocked: {
    type: Boolean,
    default: false
  },
  blockedAt: {
    type: Date,
    default: null
  },
  blockedReason: {
    type: String,
    default: null
  },
  // The super admin who applied the current block.
  blockedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // Tenant scoping for admins: project codes this admin may operate on.
  // Super admins ignore this (access to every project). Customers never use it.
  allowed_project_codes: {
    type: [String],
    default: []
  },
  // Gate for the image-CDN tools (barcode-image pool, per-tenant sync, manual
  // upload). Deliberately separate from `isSuperAdmin` and from `permissions`:
  // every other permission check in this file bypasses for isSuperAdmin (see
  // middleware/checkPermission.js), but this feature is meant to stay
  // invisible to most super admins too — set by hand, per admin, by whoever
  // already manages admin accounts.
  imageCdnAccess: {
    type: Boolean,
    default: false
  },
  permissions: {
    dashboard: {
      view: { type: Boolean, default: false }
    },
    users: {
      view: { type: Boolean, default: false },
      create: { type: Boolean, default: false },
      edit: { type: Boolean, default: false },
      delete: { type: Boolean, default: false }
    },
    orders: {
      view: { type: Boolean, default: false },
      create: { type: Boolean, default: false },
      edit: { type: Boolean, default: false },
      delete: { type: Boolean, default: false }
    },
    notifications: {
      view: { type: Boolean, default: false },
      create: { type: Boolean, default: false },
      edit: { type: Boolean, default: false },
      delete: { type: Boolean, default: false }
    },
    ecommerce: {
      view: { type: Boolean, default: false },
      create: { type: Boolean, default: false },
      edit: { type: Boolean, default: false },
      delete: { type: Boolean, default: false }
    },
    outlet: {
      view: { type: Boolean, default: false },
      create: { type: Boolean, default: false },
      edit: { type: Boolean, default: false },
      delete: { type: Boolean, default: false }
    },
    dynamicSection: {
      view: { type: Boolean, default: false },
      create: { type: Boolean, default: false },
      edit: { type: Boolean, default: false },
      delete: { type: Boolean, default: false }
    },
    offers: {
      view: { type: Boolean, default: false },
      create: { type: Boolean, default: false },
      edit: { type: Boolean, default: false },
      delete: { type: Boolean, default: false }
    },
    digitalCart: {
      view: { type: Boolean, default: false },
      create: { type: Boolean, default: false },
      edit: { type: Boolean, default: false },
      delete: { type: Boolean, default: false }
    },
    // Only 'view' is meaningful in practice (routes/admin/reports.js checks
    // it alone — a report has nothing to create/edit/delete) but all four
    // are declared for consistency with every other section here.
    reports: {
      view: { type: Boolean, default: false },
      create: { type: Boolean, default: false },
      edit: { type: Boolean, default: false },
      delete: { type: Boolean, default: false }
    },
    loyalty: {
      view: { type: Boolean, default: false },
      create: { type: Boolean, default: false },
      edit: { type: Boolean, default: false },
      delete: { type: Boolean, default: false }
    }
  },
  addresses: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Address'
  }],
  favorites: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  }],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  lastLoginAt: {
    type: Date
  },
  lastActiveAt: {
    type: Date
  },
  totalActiveMs: {
    type: Number,
    default: 0
  },
  currentSession: {
    sessionId: { type: String },
    startedAt: { type: Date },
    lastSeenAt: { type: Date },
    durationMs: { type: Number, default: 0 },
    device: {
      platform: { type: String },       // ios | android | web
      deviceId: { type: String },       // optional
      appVersion: { type: String }      // optional
    }
  },
  fcmToken: {
    type: String,
    default: null
  },
  // Live refresh tokens for this account, one per signed-in device.
  //
  // Only the SHA-256 hash is stored: a leaked database dump then yields no
  // usable session, exactly as with the password hash. `select: false` keeps
  // the array out of every ordinary query — `protect` loads the user on every
  // authenticated request and has no business carrying session material.
  refreshTokens: {
    type: [{
      tokenHash: { type: String, required: true },
      expiresAt: { type: Date, required: true },
      createdAt: { type: Date, default: Date.now },
      device: { type: String, default: '' },

      // When this token was rotated away, rather than deleting it outright.
      //
      // Rotation used to $pull the spent hash in the same breath as issuing its
      // replacement, so the old token died the instant the server answered —
      // before the client could possibly have stored the new one. A client that
      // lost that response (backgrounded mid-request, killed by the OS, write
      // failed) was left holding a token the server had already destroyed, and
      // its next refresh was rejected as a dead session. The app treats a
      // rejected refresh as a sign-out, so the shopper was silently logged out.
      //
      // The Razorpay checkout is where this bites: it backgrounds the app for
      // as long as a bank OTP takes, which is precisely the window in which a
      // response goes missing.
      //
      // Keeping the entry with a timestamp lets a genuine retry inside
      // REFRESH_GRACE_MS succeed, and turns a reuse *after* that window into
      // something detectable rather than indistinguishable from a lost reply.
      supersededAt: { type: Date, default: null }
    }],
    default: [],
    select: false
  }
}, {
  timestamps: true,
  // Defensive: even when a query explicitly selects +password, serialising the
  // document must never emit the hash.
  toJSON: {
    virtuals: true,
    transform: (doc, ret) => {
      delete ret.password;
      return ret;
    }
  },
  toObject: { virtuals: true }
});

// Index for better query performance
// Note: mobile field already has unique: true, so index is automatically created
userSchema.index({ otp: 1, otpExpiresAt: 1 });
userSchema.index({ lastActiveAt: 1 });

// Hash the password whenever it is set to a new plaintext value. Guarded by
// isModified so an ordinary user.save() (session touch, profile edit) never
// re-hashes an already-hashed value.
userSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) {
    return next();
  }

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare a plaintext password against the stored hash. Requires the document
// to have been loaded with .select('+password').
userSchema.methods.comparePassword = async function (candidate) {
  if (!this.password || !candidate) {
    return false;
  }
  return bcrypt.compare(candidate, this.password);
};

// Virtual for checking if OTP is expired
userSchema.virtual('isOtpExpired').get(function () {
  return this.otpExpiresAt ? this.otpExpiresAt < new Date() : true;
});

// Instance method to generate OTP
userSchema.methods.generateOtp = function () {
  // For testing purposes, always return "0000"
  // In production, this would generate a random 4-digit OTP
  this.otp = '0000';
  this.otpExpiresAt = new Date(Date.now() + 1 * 60 * 1000); // 5 minutes from now
  return this.otp;
};

// Instance method to verify OTP
userSchema.methods.verifyOtp = function (enteredOtp) {
  if (this.isOtpExpired) {
    return { valid: false, message: 'OTP has expired' };
  }

  if (this.otp !== enteredOtp) {
    return { valid: false, message: 'Invalid OTP' };
  }

  this.isVerified = true;
  this.otp = undefined;
  this.otpExpiresAt = undefined;
  this.lastLoginAt = new Date();

  return { valid: true, message: 'OTP verified successfully' };
};

// Static method to find user by mobile for authentication
userSchema.statics.findByMobile = function (mobile) {
  return this.findOne({ mobile });
};

// Static method to create user if not exists
userSchema.statics.findOrCreateByMobile = function (mobile) {
  return this.findOne({ mobile }).then(user => {
    if (user) {
      return user;
    }

    const newUser = new this({
      mobile,
      isVerified: false
    });

    return newUser.save();
  });
};

// Generate simple session id (avoid extra dependency)
userSchema.methods._newSessionId = function () {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

// Start a new session
userSchema.methods.startSession = function (device) {
  const now = new Date();
  const sessionId = this._newSessionId();
  this.currentSession = {
    sessionId,
    startedAt: now,
    lastSeenAt: now,
    durationMs: 0,
    device: {
      platform: device?.platform,
      deviceId: device?.deviceId,
      appVersion: device?.appVersion
    }
  };
  this.lastActiveAt = now;
  return sessionId;
};

// Touch activity and accumulate duration
// capGapMs avoids adding huge gaps (e.g., app was backgrounded/offline)
userSchema.methods.touchActivity = function (now = new Date(), capGapMs = 5 * 60 * 1000) {
  if (!this.currentSession?.lastSeenAt) {
    this.startSession();
    return;
  }
  const last = new Date(this.currentSession.lastSeenAt).getTime();
  const gap = Math.max(0, Math.min(now.getTime() - last, capGapMs));
  this.currentSession.durationMs += gap;
  this.totalActiveMs += gap;
  this.currentSession.lastSeenAt = now;
  this.lastActiveAt = now;
};

// Utility: whether user is considered active within a window (e.g., 10 minutes)
userSchema.methods.isActiveWithin = function (windowMs = 10 * 60 * 1000) {
  if (!this.lastActiveAt) return false;
  return (Date.now() - new Date(this.lastActiveAt).getTime()) <= windowMs;
};

module.exports = require('./tenantModel')('User', userSchema);
