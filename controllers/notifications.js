const User = require('../models/User');
const Notification = require('../models/Notification');
const fcm = require('../utils/fcm');

// @desc    Send notification to a specific user
// @route   POST /api/admin/notifications/send-to-user
// @access  Private/Admin
const sendNotificationToUser = async (req, res) => {
    try {
        const { userId, title, body, data } = req.body;

        // Validation
        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'User ID is required'
            });
        }

        if (!title || !body) {
            return res.status(400).json({
                success: false,
                message: 'Title and body are required'
            });
        }

        // Find user
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'User not found'
            });
        }

        // Create notification record in database regardless of FCM token presence
        // (User can see it in-app even if push fails)
        await Notification.create({
            user: userId,
            title,
            body,
            data: data || {},
            type: 'system'
        });

        if (!user.fcmToken) {
            return res.status(200).json({
                success: true,
                message: 'Notification saved to history (User has no FCM token for push)'
            });
        }

        // Send notification via this tenant's own Firebase project, if it has
        // one configured (falls back to the shared default app otherwise —
        // see utils/fcm.js).
        const result = await fcm.sendNotificationToUser(user, title, body, data || {}, req.tenant?.projectCode);

        res.status(200).json({
            success: true,
            message: 'Notification sent successfully',
            data: result
        });

    } catch (error) {
        console.error('Send Notification to User Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send notification',
            error: error.message
        });
    }
};

// @desc    Send notification to all users
// @route   POST /api/admin/notifications/send-to-all
// @access  Private/Admin
const sendNotificationToAllUsers = async (req, res) => {
    try {
        const { title, body, data } = req.body;

        // Validation
        if (!title || !body) {
            return res.status(400).json({
                success: false,
                message: 'Title and body are required'
            });
        }

        // Find all users (only need IDs and FCM tokens)
        const allUsers = await User.find({}, '_id fcmToken').lean();

        // Create notification records for ALL users in bulk (optimized)
        const notificationsToCreate = allUsers.map(user => ({
            user: user._id,
            title,
            body,
            data: data || {},
            type: 'general'
        }));

        if (notificationsToCreate.length > 0) {
            await Notification.insertMany(notificationsToCreate);
        }

        // Filter users with FCM tokens for push
        const usersWithTokens = allUsers.filter(user => user.fcmToken);

        if (usersWithTokens.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'Notifications saved to history (No users have FCM tokens for push)'
            });
        }

        // Send notification to all users via this tenant's own Firebase
        // project, if it has one configured.
        const result = await fcm.sendNotificationToAllUsers(usersWithTokens, title, body, data || {}, req.tenant?.projectCode);

        res.status(200).json({
            success: true,
            message: `Notification sent to ${result.successCount} users (Saved for ${allUsers.length} users)`,
            data: result
        });

    } catch (error) {
        console.error('Send Notification to All Users Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to send notifications',
            error: error.message
        });
    }
};

// @desc    Get all users with FCM tokens (for admin to see who can receive notifications)
// @route   GET /api/admin/notifications/users
// @access  Private/Admin
const getUsersWithFcmTokens = async (req, res) => {
    try {
        const users = await User.find(
            { fcmToken: { $ne: null, $exists: true } },
            { _id: 1, name: 1, mobile: 1, email: 1, lastActiveAt: 1 }
        ).sort({ lastActiveAt: -1 }).lean();

        res.status(200).json({
            success: true,
            count: users.length,
            data: users
        });

    } catch (error) {
        console.error('Get Users with FCM Tokens Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch users',
            error: error.message
        });
    }
};

// @desc    Get current user's notifications
// @route   GET /api/notifications
// @access  Private
const getUserNotifications = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const notifications = await Notification.find({ user: req.user._id })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(); // Add lean() for better performance

        const total = await Notification.countDocuments({ user: req.user._id });

        res.status(200).json({
            success: true,
            count: notifications.length,
            total,
            page,
            pages: Math.ceil(total / limit),
            data: notifications
        });

    } catch (error) {
        console.error('Get User Notifications Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch notifications',
            error: error.message
        });
    }
};

// @desc    Get unread notification count for current user (optimized endpoint)
// @route   GET /api/notifications/unread-count
// @access  Private
const getUnreadCount = async (req, res) => {
    try {
        const count = await Notification.countDocuments({
            user: req.user._id,
            isRead: false
        });

        res.status(200).json({
            success: true,
            count
        });

    } catch (error) {
        console.error('Get Unread Count Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch unread count',
            error: error.message
        });
    }
};

// @desc    Mark notification as read
// @route   PUT /api/notifications/:id/read
// @access  Private
const markNotificationRead = async (req, res) => {
    try {
        const notification = await Notification.findOneAndUpdate(
            { _id: req.params.id, user: req.user._id },
            { isRead: true },
            { new: true, lean: true }
        );

        if (!notification) {
            return res.status(404).json({
                success: false,
                message: 'Notification not found'
            });
        }

        res.status(200).json({
            success: true,
            data: notification
        });

    } catch (error) {
        console.error('Mark Notification Read Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update notification',
            error: error.message
        });
    }
};

// @desc    Mark ALL notifications as read
// @route   PUT /api/notifications/read-all
// @access  Private
const markAllNotificationsRead = async (req, res) => {
    try {
        await Notification.updateMany(
            { user: req.user._id, isRead: false },
            { $set: { isRead: true } }
        );

        res.status(200).json({
            success: true,
            message: 'All notifications marked as read'
        });

    } catch (error) {
        console.error('Mark All Read Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update notifications',
            error: error.message
        });
    }
};

module.exports = {
    sendNotificationToUser,
    sendNotificationToAllUsers,
    getUsersWithFcmTokens,
    getUserNotifications,
    getUnreadCount,
    markNotificationRead,
    markAllNotificationsRead
};
