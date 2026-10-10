const express = require('express');
const router = express.Router();
const {
    sendNotificationToUser,
    sendNotificationToAllUsers,
    getUsersWithFcmTokens
} = require('../../controllers/notifications');
const AdminNotification = require('../../models/AdminNotification');
const { checkPermission } = require('../../middleware/checkPermission');

// Mirrors User.canAccessStore: a super admin or one with no allowed_store_codes
// sees every notification; otherwise only ones tagged with one of their stores.
// Notifications with no store_code (e.g. a future platform-wide 'system' alert)
// are never filtered out by this.
const storeScopeFilter = (user) => {
  if (user.isSuperAdmin) return {};
  if (!user.allowed_store_codes || user.allowed_store_codes.length === 0) return {};
  return {
    $or: [
      { 'data.store_code': { $in: user.allowed_store_codes } },
      { 'data.store_code': { $exists: false } }
    ]
  };
};

// @route   POST /api/admin/notifications/send-to-user
// @desc    Send push notification to a specific user
// @access  Private/Admin
router.post('/send-to-user', checkPermission('notifications', 'create'), sendNotificationToUser);

// @route   POST /api/admin/notifications/send-to-all
// @desc    Send push notification to all users
// @access  Private/Admin
router.post('/send-to-all', checkPermission('notifications', 'create'), sendNotificationToAllUsers);

// @route   GET /api/admin/notifications/users
// @desc    Get all users with FCM tokens
// @access  Private/Admin
router.get('/users', checkPermission('notifications', 'view'), getUsersWithFcmTokens);

// ==================== ADMIN NOTIFICATIONS (order alerts, etc.) ====================

// @route   GET /api/admin/notifications/admin-alerts
// @desc    Get admin notifications (order placed, etc.)
// @access  Private/Admin
router.get('/admin-alerts', checkPermission('notifications', 'view'), async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const scope = storeScopeFilter(req.user);

    const [notifications, total, unreadCount] = await Promise.all([
      AdminNotification.find(scope)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      AdminNotification.countDocuments(scope),
      AdminNotification.countDocuments({ ...scope, isRead: false })
    ]);

    res.status(200).json({
      success: true,
      data: notifications,
      unreadCount,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get admin notifications error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   GET /api/admin/notifications/admin-alerts/unread-count
// @desc    Get unread count for admin notifications
// @access  Private/Admin
router.get('/admin-alerts/unread-count', checkPermission('notifications', 'view'), async (req, res) => {
  try {
    const scope = storeScopeFilter(req.user);
    const count = await AdminNotification.countDocuments({ ...scope, isRead: false });
    res.status(200).json({ success: true, data: { count } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   PUT /api/admin/notifications/admin-alerts/mark-read
// @desc    Mark all admin notifications as read
// @access  Private/Admin
router.put('/admin-alerts/mark-read', checkPermission('notifications', 'view'), async (req, res) => {
  try {
    const scope = storeScopeFilter(req.user);
    await AdminNotification.updateMany({ ...scope, isRead: false }, { isRead: true });
    res.status(200).json({ success: true, message: 'All notifications marked as read' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   PUT /api/admin/notifications/admin-alerts/:id/read
// @desc    Mark single admin notification as read
// @access  Private/Admin
router.put('/admin-alerts/:id/read', checkPermission('notifications', 'view'), async (req, res) => {
  try {
    const scope = storeScopeFilter(req.user);
    await AdminNotification.findOneAndUpdate({ _id: req.params.id, ...scope }, { isRead: true });
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// @route   DELETE /api/admin/notifications/admin-alerts/:id
// @desc    Delete single admin notification
// @access  Private/Admin
router.delete('/admin-alerts/:id', checkPermission('notifications', 'delete'), async (req, res) => {
  try {
    const scope = storeScopeFilter(req.user);
    await AdminNotification.findOneAndDelete({ _id: req.params.id, ...scope });
    res.status(200).json({ success: true, message: 'Notification deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
