const express = require('express');
const { body } = require('express-validator');
const { sendOtp, verifyOtp, adminLogin, refreshToken, getProfile, updateProfile, logout, isActive, saveFcmToken } = require('../controllers/auth');
const { protect } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { MOBILE_REGEX, MOBILE_MESSAGE } = require('../utils/phone');

const router = express.Router();

// Validation rules
const sendOtpValidation = [
  body('mobile')
    .matches(MOBILE_REGEX)
    .withMessage(MOBILE_MESSAGE)
];

const verifyOtpValidation = [
  body('mobile')
    .matches(MOBILE_REGEX)
    .withMessage(MOBILE_MESSAGE),
  body('otp')
    .isLength({ min: 4, max: 4 })
    .withMessage('OTP must be exactly 4 digits')
    .isNumeric()
    .withMessage('OTP must contain only numbers')
];

const adminLoginValidation = [
  body('mobile')
    .matches(MOBILE_REGEX)
    .withMessage(MOBILE_MESSAGE),
  body('password')
    .isLength({ min: 1 })
    .withMessage('Password is required')
];

const updateProfileValidation = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Name must be between 2 and 50 characters'),
  body('email')
    .optional()
    .isEmail()
    .withMessage('Please enter a valid email address')
    .normalizeEmail()
];

// Routes

// @route   POST /api/auth/send-otp
// @desc    Send OTP to mobile number
// @access  Public
router.post('/send-otp', sendOtpValidation, validate, sendOtp);

// @route   POST /api/auth/verify-otp
// @desc    Verify OTP and get authentication token
// @access  Public
router.post('/verify-otp', verifyOtpValidation, validate, verifyOtp);

// @route   POST /api/auth/admin-login
// @desc    Admin panel login with mobile + password (no OTP, no SMS spend)
// @access  Public
router.post('/admin-login', adminLoginValidation, validate, adminLogin);

// @route   POST /api/auth/refresh-token
// @desc    Exchange a refresh token for a fresh access/refresh pair
// @access  Public — deliberately not `protect`ed, since the whole point is to
//          be callable once the access token has expired. The refresh token in
//          the body is the credential.
router.post('/refresh-token', refreshToken);

// @route   GET /api/auth/profile
// @desc    Get current user profile
// @access  Private
router.get('/profile', protect, getProfile);

// @route   PUT /api/auth/profile
// @desc    Update user profile
// @access  Private
router.put('/profile', protect, updateProfileValidation, validate, updateProfile);

// @route   POST /api/auth/logout
// @desc    Logout user
// @access  Private
router.post('/logout', protect, logout);

// @route   POST /api/auth/is-active
// @desc    Update user session/activity and report status
// @access  Private
router.post('/is-active', protect, isActive);

// @route   POST /api/auth/save-fcm-token
// @desc    Save FCM token for push notifications
// @access  Private
router.post('/save-fcm-token', protect, saveFcmToken);

module.exports = router;
