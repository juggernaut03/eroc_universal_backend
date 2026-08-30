const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const Order = require('../../models/Order');
const Notification = require('../../models/Notification');
const AddressBook = require('../../models/AddressBook');
const Favorite = require('../../models/Favorite');
const Cart = require('../../models/Cart');
// The catalogue customers actually browse/favorite is ProductMaster
// (collection `productmasters`, keyed by p_code) - not the unused legacy
// Product model, which has no data in any live tenant.
const ProductMaster = require('../../models/ProductMaster');
const { checkPermission, requireSuperAdmin } = require('../../middleware/checkPermission');
const { ORDER_STATUS } = require('../../constants/orderStatus');

// Statuses that mean an order is still "in flight" for a customer -
// mirrors CANCELLABLE_STATUSES-adjacent buckets plus everything short of a
// terminal state (delivered/cancelled).
const ACTIVE_ORDER_STATUSES = [
  ORDER_STATUS.PENDING,
  ORDER_STATUS.ACCEPTED,
  ORDER_STATUS.ACCEPTED_BY_STORE,
  ORDER_STATUS.IN_PACKAGING,
  ORDER_STATUS.OUT_FOR_DELIVERY,
];

// @route   GET /api/admin/users
// @desc    Get all users with pagination, search, and filters (with notification insights)
// @access  Admin
router.get('/', checkPermission('users', 'view'), async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      role = '',
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build query
    const query = {};

    // Search by mobile, name, or email
    if (search) {
      query.$or = [
        { mobile: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    // Filter by role
    if (role) {
      query.role = role;
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const users = await User.find(query)
      .select('-otp -otpExpiresAt')
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip)
      .lean();

    // Get total count for pagination
    const total = await User.countDocuments(query);

    // Aggregate notification counts for all users in this page
    const userIds = users.map(u => u._id);
    const notificationStats = await Notification.aggregate([
      { $match: { user: { $in: userIds } } },
      {
        $group: {
          _id: '$user',
          totalCount: { $sum: 1 },
          unreadCount: { $sum: { $cond: [{ $eq: ['$isRead', false] }, 1, 0] } }
        }
      }
    ]);

    // Create a map for quick lookup
    const notifMap = {};
    notificationStats.forEach(stat => {
      notifMap[stat._id.toString()] = {
        totalCount: stat.totalCount,
        unreadCount: stat.unreadCount
      };
    });

    // Enhance users with notification data
    const enhancedUsers = users.map(user => ({
      ...user,
      pushEnabled: !!user.fcmToken,
      platform: user.currentSession?.device?.platform || null,
      notificationCount: notifMap[user._id.toString()]?.totalCount || 0,
      unreadNotificationCount: notifMap[user._id.toString()]?.unreadCount || 0
    }));

    res.status(200).json({
      success: true,
      data: enhancedUsers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching users',
      error: error.message
    });
  }
});

// @route   GET /api/admin/users/:id
// @desc    Get single user by ID with a full drill-down: order history,
//          spend trend, addresses, favorites, and recent notifications.
// @access  Admin
//
// The customer's own data isn't linked to User via ObjectId refs anywhere
// except Notification - Order/AddressBook/Favorite all key off the plain
// `mobile_no` / `mobile_number` string, so every join below matches on
// user.mobile instead of user._id.
router.get('/:id', checkPermission('users', 'view'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-otp -otpExpiresAt').lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const mobile = user.mobile;

    const [orderStatsAgg, recentOrders, spendTrendAgg, addresses, favorites, notifications, notifStatsAgg, cart] =
      await Promise.all([
        Order.aggregate([
          { $match: { mobile_no: mobile } },
          {
            $group: {
              _id: null,
              totalOrders: { $sum: 1 },
              totalSpent: { $sum: '$order_summary.total_amount' },
              completedOrders: {
                $sum: { $cond: [{ $eq: ['$order_status', ORDER_STATUS.DELIVERED] }, 1, 0] }
              },
              cancelledOrders: {
                $sum: { $cond: [{ $eq: ['$order_status', ORDER_STATUS.CANCELLED] }, 1, 0] }
              },
              lastOrderAt: { $max: '$order_placed_at' }
            }
          }
        ]),
        Order.find({ mobile_no: mobile })
          .select(
            'order_number order_status order_placed_at store_code order_summary.total_amount order_summary.total_items order_summary.total_quantity'
          )
          .sort({ order_placed_at: -1 })
          .limit(50)
          .lean(),
        // Spend trend: last 12 months, grouped by calendar month.
        Order.aggregate([
          {
            $match: {
              mobile_no: mobile,
              order_placed_at: { $gte: new Date(new Date().setMonth(new Date().getMonth() - 11, 1)) }
            }
          },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m', date: '$order_placed_at' } },
              totalSpent: { $sum: '$order_summary.total_amount' },
              orderCount: { $sum: 1 }
            }
          },
          { $sort: { _id: 1 } }
        ]),
        AddressBook.find({ mobile_number: mobile }).sort({ is_default: -1, idaddress_book: 1 }).lean(),
        Favorite.find({ mobile_no: mobile }).sort({ createdAt: -1 }).lean(),
        Notification.find({ user: user._id }).sort({ createdAt: -1 }).limit(20).lean(),
        Notification.aggregate([
          { $match: { user: user._id } },
          {
            $group: {
              _id: null,
              totalCount: { $sum: 1 },
              unreadCount: { $sum: { $cond: [{ $eq: ['$isRead', false] }, 1, 0] } }
            }
          }
        ]),
        Cart.findOne({ mobile_no: mobile }).lean()
      ]);

    // Enrich favorites with product name/image/price - Favorite only stores
    // p_code + store_code, not a product ref. p_code is only unique per
    // store, so match on both.
    let enrichedFavorites = favorites;
    if (favorites.length) {
      const codePairs = favorites.map((f) => ({ p_code: f.p_code, store_code: f.store_code }));
      const products = await ProductMaster.find({ $or: codePairs })
        .select('p_code store_code product_name pcode_img product_mrp our_price')
        .lean();
      const productMap = new Map(products.map((p) => [`${p.p_code}::${p.store_code}`, p]));
      enrichedFavorites = favorites.map((f) => {
        const product = productMap.get(`${f.p_code}::${f.store_code}`);
        return {
          ...f,
          product: product
            ? {
                name: product.product_name,
                image: product.pcode_img || null,
                mrp: product.product_mrp ? parseFloat(product.product_mrp.toString()) : null,
                sellingPrice: product.our_price ? parseFloat(product.our_price.toString()) : null
              }
            : null
        };
      });
    }

    const stats = orderStatsAgg[0] || {
      totalOrders: 0,
      totalSpent: 0,
      completedOrders: 0,
      cancelledOrders: 0,
      lastOrderAt: null
    };
    stats.avgOrderValue = stats.totalOrders > 0 ? stats.totalSpent / stats.totalOrders : 0;

    res.status(200).json({
      success: true,
      data: {
        user: {
          ...user,
          pushEnabled: !!user.fcmToken,
          platform: user.currentSession?.device?.platform || null
        },
        stats,
        orders: recentOrders,
        spendTrend: spendTrendAgg,
        addresses,
        favorites: enrichedFavorites,
        cart: cart
          ? {
              store_code: cart.store_code,
              items: cart.items,
              subtotal: cart.subtotal,
              total_items: cart.total_items,
              total_quantity: cart.total_quantity,
              last_updated: cart.last_updated
            }
          : null,
        notifications,
        notificationStats: notifStatsAgg[0]
          ? { totalCount: notifStatsAgg[0].totalCount, unreadCount: notifStatsAgg[0].unreadCount }
          : { totalCount: 0, unreadCount: 0 }
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching user',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/users/:id
// @desc    Update user details
// @access  Admin
router.put('/:id', checkPermission('users', 'edit'), async (req, res) => {
  try {
    const { name, email, mobile, role, isVerified } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (mobile !== undefined) updateData.mobile = mobile;
    if (role !== undefined) updateData.role = role;
    if (isVerified !== undefined) updateData.isVerified = isVerified;

    const user = await User.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).select('-otp -otpExpiresAt');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'User updated successfully',
      data: user
    });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating user',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/users/:id
// @desc    Delete a user permanently
// @access  Super admin only
//
// Deleting an account is irreversible and takes the customer's identity with
// it, so it is not delegated through the `users.delete` permission the way
// every other destructive action in this file is - only a super admin may do
// it. Blocking (below) is the reversible alternative.
router.delete('/:id', requireSuperAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own account'
      });
    }

    // A super admin is the only account that can undo any of this; letting one
    // delete another leaves no way back if it was the last one.
    if (user.isSuperAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Super admin accounts cannot be deleted'
      });
    }

    // Check if user has active orders
    const activeOrders = await Order.countDocuments({
      mobile_no: user.mobile,
      order_status: { $in: ACTIVE_ORDER_STATUSES }
    });

    if (activeOrders > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete user with ${activeOrders} active order(s). Please complete or cancel them first.`
      });
    }

    // Actually delete the user (you can implement soft delete if needed)
    await User.findByIdAndDelete(req.params.id);

    res.status(200).json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting user',
      error: error.message
    });
  }
});

// @route   PATCH /api/admin/users/:id/block
// @desc    Block a user - they can no longer sign in, and any token they
//          already hold stops working on the next request (middleware/auth.js).
// @access  Super admin only
router.patch('/:id/block', requireSuperAdmin, async (req, res) => {
  try {
    const { reason } = req.body || {};

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        message: 'You cannot block your own account'
      });
    }

    if (user.isSuperAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Super admin accounts cannot be blocked'
      });
    }

    if (user.isBlocked) {
      return res.status(400).json({
        success: false,
        message: 'User is already blocked'
      });
    }

    // An update rather than doc.save(): save() revalidates the whole document,
    // and long-lived customer records predate some of the current field
    // validators - blocking must not fail because of an unrelated legacy value.
    //
    // Clearing refreshTokens kills every live session outright; otherwise the
    // account keeps valid refresh tokens and could mint fresh access tokens on
    // a device that is mid-refresh.
    const blocked = await User.findByIdAndUpdate(
      user._id,
      {
        $set: {
          isBlocked: true,
          blockedAt: new Date(),
          blockedReason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
          blockedBy: req.user._id,
          refreshTokens: []
        }
      },
      { new: true }
    )
      .select('-otp -otpExpiresAt')
      .lean();

    res.status(200).json({
      success: true,
      message: 'User blocked successfully',
      data: blocked
    });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({
      success: false,
      message: 'Error blocking user',
      error: error.message
    });
  }
});

// @route   PATCH /api/admin/users/:id/unblock
// @desc    Lift a block and let the user sign in again
// @access  Super admin only
router.patch('/:id/unblock', requireSuperAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.isBlocked) {
      return res.status(400).json({
        success: false,
        message: 'User is not blocked'
      });
    }

    const unblocked = await User.findByIdAndUpdate(
      user._id,
      { $set: { isBlocked: false, blockedAt: null, blockedReason: null, blockedBy: null } },
      { new: true }
    )
      .select('-otp -otpExpiresAt')
      .lean();

    res.status(200).json({
      success: true,
      message: 'User unblocked successfully',
      data: unblocked
    });
  } catch (error) {
    console.error('Unblock user error:', error);
    res.status(500).json({
      success: false,
      message: 'Error unblocking user',
      error: error.message
    });
  }
});

// @route   PATCH /api/admin/users/:id/role
// @desc    Change user role
// @access  Admin
router.patch('/:id/role', checkPermission('users', 'edit'), async (req, res) => {
  try {
    const { role } = req.body;

    if (!role || !['user', 'admin'].includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role. Must be either "user" or "admin"'
      });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true, runValidators: true }
    ).select('-otp -otpExpiresAt');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.status(200).json({
      success: true,
      message: `User role changed to ${role} successfully`,
      data: user
    });
  } catch (error) {
    console.error('Change role error:', error);
    res.status(500).json({
      success: false,
      message: 'Error changing user role',
      error: error.message
    });
  }
});

// @route   GET /api/admin/users/stats/overview
// @desc    Get user statistics overview
// @access  Admin
router.get('/stats/overview', checkPermission('users', 'view'), async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const verifiedUsers = await User.countDocuments({ isVerified: true });
    const adminUsers = await User.countDocuments({ role: 'admin' });

    // Get active users (last 24 hours)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const activeUsers = await User.countDocuments({
      lastActiveAt: { $gte: oneDayAgo }
    });

    // Get new users (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const newUsers = await User.countDocuments({
      createdAt: { $gte: sevenDaysAgo }
    });

    res.status(200).json({
      success: true,
      data: {
        totalUsers,
        verifiedUsers,
        adminUsers,
        activeUsers24h: activeUsers,
        newUsersLast7Days: newUsers
      }
    });
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching user statistics',
      error: error.message
    });
  }
});

module.exports = router;
