const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const Category = require('../../models/Category');
const { checkPermission } = require('../../middleware/checkPermission');
const {
  ORDER_STATUS,
  NON_REVENUE_STATUSES,
  LEGACY_STATUS_ALIASES
} = require('../../constants/orderStatus');

// All dashboard routes require dashboard:view permission
router.use(checkPermission('dashboard', 'view'));

// @route   GET /api/admin/dashboard/overview
// @desc    Get overall dashboard statistics
// @access  Admin
router.get('/overview', async (req, res) => {
  try {
    // Get current date ranges
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const thisWeek = new Date(today);
    thisWeek.setDate(thisWeek.getDate() - 7);

    const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);

    // Users statistics
    const totalUsers = await User.countDocuments();
    const newUsersToday = await User.countDocuments({ createdAt: { $gte: today } });
    const newUsersThisMonth = await User.countDocuments({ createdAt: { $gte: thisMonth } });
    const newUsersLastMonth = await User.countDocuments({
      createdAt: { $gte: lastMonth, $lte: lastMonthEnd }
    });

    // Products statistics
    const totalProducts = await Product.countDocuments();
    const activeProducts = await Product.countDocuments({ status: 'active' });
    const outOfStock = await Product.countDocuments({ 'stock.quantity': 0 });
    const lowStock = await Product.countDocuments({
      $expr: {
        $and: [
          { $gt: ['$stock.quantity', 0] },
          { $lte: ['$stock.quantity', '$stock.minStockLevel'] }
        ]
      }
    });

    // Orders statistics
    const totalOrders = await Order.countDocuments();
    const ordersToday = await Order.countDocuments({ order_placed_at: { $gte: today } });
    const ordersThisWeek = await Order.countDocuments({ order_placed_at: { $gte: thisWeek } });
    const ordersThisMonth = await Order.countDocuments({ order_placed_at: { $gte: thisMonth } });
    const ordersLastMonth = await Order.countDocuments({
      order_placed_at: { $gte: lastMonth, $lte: lastMonthEnd }
    });

    const pendingOrders = await Order.countDocuments({
      order_status: {
        $in: [
          ...LEGACY_STATUS_ALIASES[ORDER_STATUS.PENDING],
          ...LEGACY_STATUS_ALIASES[ORDER_STATUS.ACCEPTED],
          ...LEGACY_STATUS_ALIASES[ORDER_STATUS.ACCEPTED_BY_STORE]
        ]
      }
    });

    const deliveredOrders = await Order.countDocuments({
      order_status: 'delivered'
    });

    // 'refunded' was folded into 'cancelled' when the status vocabulary was
    // aligned with the admin panel; only pre-rename documents still carry it.
    const refundedOrders = await Order.countDocuments({
      order_status: 'refunded'
    });

    // Revenue statistics
    const revenueStats = await Order.aggregate([
      {
        $match: {
          order_status: { $nin: NON_REVENUE_STATUSES }
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$order_summary.total_amount' },
          averageOrderValue: { $avg: '$order_summary.total_amount' }
        }
      }
    ]);

    const revenueToday = await Order.aggregate([
      {
        $match: {
          order_placed_at: { $gte: today },
          order_status: { $nin: NON_REVENUE_STATUSES }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$order_summary.total_amount' }
        }
      }
    ]);

    const revenueThisMonth = await Order.aggregate([
      {
        $match: {
          order_placed_at: { $gte: thisMonth },
          order_status: { $nin: NON_REVENUE_STATUSES }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$order_summary.total_amount' }
        }
      }
    ]);

    const revenueLastMonth = await Order.aggregate([
      {
        $match: {
          order_placed_at: { $gte: lastMonth, $lte: lastMonthEnd },
          order_status: { $nin: NON_REVENUE_STATUSES }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$order_summary.total_amount' }
        }
      }
    ]);

    // Calculate growth percentages
    const userGrowth = newUsersLastMonth > 0
      ? ((newUsersThisMonth - newUsersLastMonth) / newUsersLastMonth * 100).toFixed(2)
      : 0;

    const orderGrowth = ordersLastMonth > 0
      ? ((ordersThisMonth - ordersLastMonth) / ordersLastMonth * 100).toFixed(2)
      : 0;

    const revenueGrowth = revenueLastMonth[0]?.total > 0
      ? ((revenueThisMonth[0]?.total - revenueLastMonth[0]?.total) / revenueLastMonth[0]?.total * 100).toFixed(2)
      : 0;

    res.status(200).json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          newToday: newUsersToday,
          newThisMonth: newUsersThisMonth,
          newLastMonth: newUsersLastMonth,
          growth: parseFloat(userGrowth)
        },
        products: {
          total: totalProducts,
          active: activeProducts,
          outOfStock,
          lowStock
        },
        orders: {
          total: totalOrders,
          today: ordersToday,
          thisWeek: ordersThisWeek,
          thisMonth: ordersThisMonth,
          lastMonth: ordersLastMonth,
          pending: pendingOrders,
          delivered: deliveredOrders,
          refunded: refundedOrders,
          growth: parseFloat(orderGrowth)
        },
        revenue: {
          total: revenueStats[0]?.totalRevenue || 0,
          today: revenueToday[0]?.total || 0,
          thisMonth: revenueThisMonth[0]?.total || 0,
          lastMonth: revenueLastMonth[0]?.total || 0,
          averageOrderValue: revenueStats[0]?.averageOrderValue || 0,
          growth: parseFloat(revenueGrowth)
        }
      }
    });
  } catch (error) {
    console.error('Get dashboard overview error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching dashboard overview',
      error: error.message
    });
  }
});

// @route   GET /api/admin/dashboard/sales-trend
// @desc    Get sales trend data (last 30 days)
// @access  Admin
router.get('/sales-trend', async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const salesTrend = await Order.aggregate([
      {
        $match: {
          order_placed_at: { $gte: startDate },
          order_status: { $nin: NON_REVENUE_STATUSES }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$order_placed_at' } },
          orders: { $sum: 1 },
          revenue: { $sum: '$order_summary.total_amount' },
          items: { $sum: '$order_summary.total_items' }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ]);

    res.status(200).json({
      success: true,
      data: salesTrend
    });
  } catch (error) {
    console.error('Get sales trend error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching sales trend',
      error: error.message
    });
  }
});

// @route   GET /api/admin/dashboard/top-products
// @desc    Get top selling products
// @access  Admin
router.get('/top-products', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const topProducts = await Order.aggregate([
      {
        $match: {
          order_status: { $nin: NON_REVENUE_STATUSES }
        }
      },
      { $unwind: '$order_items' },
      {
        $group: {
          _id: '$order_items.p_code',
          productName: { $first: '$order_items.product_name' },
          totalQuantity: { $sum: '$order_items.quantity' },
          totalRevenue: { $sum: '$order_items.total_price' },
          orderCount: { $sum: 1 }
        }
      },
      {
        $sort: { totalQuantity: -1 }
      },
      {
        $limit: parseInt(limit)
      }
    ]);

    res.status(200).json({
      success: true,
      data: topProducts
    });
  } catch (error) {
    console.error('Get top products error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching top products',
      error: error.message
    });
  }
});

// @route   GET /api/admin/dashboard/top-categories
// @desc    Get top categories by sales
// @access  Admin
router.get('/top-categories', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const topCategories = await Product.aggregate([
      {
        $lookup: {
          from: 'categories',
          localField: 'category',
          foreignField: '_id',
          as: 'categoryInfo'
        }
      },
      { $unwind: '$categoryInfo' },
      {
        $group: {
          _id: '$category',
          categoryName: { $first: '$categoryInfo.name' },
          productCount: { $sum: 1 },
          totalStock: { $sum: '$stock.quantity' }
        }
      },
      {
        $sort: { productCount: -1 }
      },
      {
        $limit: parseInt(limit)
      }
    ]);

    res.status(200).json({
      success: true,
      data: topCategories
    });
  } catch (error) {
    console.error('Get top categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching top categories',
      error: error.message
    });
  }
});

// @route   GET /api/admin/dashboard/recent-orders
// @desc    Get recent orders
// @access  Admin
router.get('/recent-orders', async (req, res) => {
  try {
    const { limit = 10 } = req.query;

    const recentOrders = await Order.find()
      .sort({ order_placed_at: -1 })
      .limit(parseInt(limit))
      .select('order_number mobile_no order_status order_summary.total_amount order_placed_at customer_info');

    res.status(200).json({
      success: true,
      data: recentOrders
    });
  } catch (error) {
    console.error('Get recent orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching recent orders',
      error: error.message
    });
  }
});

// @route   GET /api/admin/dashboard/order-status-distribution
// @desc    Get order distribution by status
// @access  Admin
router.get('/order-status-distribution', async (req, res) => {
  try {
    const distribution = await Order.aggregate([
      {
        $group: {
          _id: '$order_status',
          count: { $sum: 1 },
          totalValue: { $sum: '$order_summary.total_amount' }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);

    res.status(200).json({
      success: true,
      data: distribution
    });
  } catch (error) {
    console.error('Get order distribution error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching order distribution',
      error: error.message
    });
  }
});

// @route   GET /api/admin/dashboard/payment-status-distribution
// @desc    Get payment distribution by status
// @access  Admin
router.get('/payment-status-distribution', async (req, res) => {
  try {
    const distribution = await Order.aggregate([
      {
        $group: {
          _id: '$payment_info.payment_status',
          count: { $sum: 1 },
          totalValue: { $sum: '$order_summary.total_amount' }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);

    res.status(200).json({
      success: true,
      data: distribution
    });
  } catch (error) {
    console.error('Get payment distribution error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching payment distribution',
      error: error.message
    });
  }
});

// @route   GET /api/admin/dashboard/user-activity
// @desc    Get user activity statistics
// @access  Admin
router.get('/user-activity', async (req, res) => {
  try {
    const now = new Date();

    // Active in last hour
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const activeLastHour = await User.countDocuments({
      lastActiveAt: { $gte: oneHourAgo }
    });

    // Active in last 24 hours
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const activeLastDay = await User.countDocuments({
      lastActiveAt: { $gte: oneDayAgo }
    });

    // Active in last 7 days
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const activeLastWeek = await User.countDocuments({
      lastActiveAt: { $gte: sevenDaysAgo }
    });

    res.status(200).json({
      success: true,
      data: {
        activeLastHour,
        activeLastDay,
        activeLastWeek
      }
    });
  } catch (error) {
    console.error('Get user activity error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching user activity',
      error: error.message
    });
  }
});

module.exports = router;
