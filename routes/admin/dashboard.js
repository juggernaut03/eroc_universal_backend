const express = require('express');
const router = express.Router();
const User = require('../../models/User');
const Product = require('../../models/Product');
const Order = require('../../models/Order');
const Category = require('../../models/Category');
const { checkPermission, requireStoreAccess } = require('../../middleware/checkPermission');
const {
  ORDER_STATUS,
  NON_REVENUE_STATUSES,
  LEGACY_STATUS_ALIASES
} = require('../../constants/orderStatus');

// All dashboard routes require dashboard:view permission, and — like every
// other admin surface — respect store-level restriction. Unlike
// products/orders (which require an explicit store_code up front),
// dashboard queries default to full-tenant totals when nothing is
// selected, so requireStoreAccess only rejects an explicit ?store_code an
// admin isn't allowed to see; resolveStoreFilter below is what actually
// pins a store-restricted admin's numbers to their own branch(es) even
// when they never send store_code at all.
router.use(checkPermission('dashboard', 'view'));
router.use(requireStoreAccess);

// Every KPI in this file is either an Order query (which carries its own
// store_code) or a Users query (which doesn't — a customer isn't tied to
// one branch). This resolves what to filter Orders by:
//   - an explicit ?store_code, already access-checked by requireStoreAccess
//     above — lets any admin (including an unrestricted one) drill into one
//     branch, same as the store switcher elsewhere in the panel
//   - otherwise, a store-restricted admin (allowed_store_codes set) is
//     pinned to their own store(s) — never merged with a param, so an
//     unattended request that simply omits store_code still can't fall
//     through to the whole tenant
//   - otherwise (unrestricted, nothing selected) null — today's behavior,
//     full-tenant totals
// Returns either a plain string (single store) or { $in: [...] } (a
// restricted admin with more than one store) — both drop straight into a
// Mongo match as `store_code: <result>`.
function resolveStoreFilter(req) {
  const explicit = req.query.store_code;
  if (explicit) return explicit;
  if (req.user.allowed_store_codes && req.user.allowed_store_codes.length > 0) {
    return { $in: req.user.allowed_store_codes };
  }
  return null;
}

// Customers aren't tied to a store directly, so a store-scoped "users"
// figure is derived from who has actually ordered from that store —
// distinct mobile numbers off the Order collection, matched back to User.
// Returns null when there's no store filter (nothing to restrict by).
async function resolveStoreCustomerFilter(storeFilter) {
  if (!storeFilter) return null;
  const mobiles = await Order.distinct('mobile_no', { store_code: storeFilter });
  return { mobile: { $in: mobiles } };
}

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

    const storeFilter = resolveStoreFilter(req);
    const orderBase = storeFilter ? { store_code: storeFilter } : {};
    // Base for every Users query below — restricted to this store's
    // customers when a store filter is active, {} (everyone) otherwise.
    const userBase = (await resolveStoreCustomerFilter(storeFilter)) || {};

    // Users statistics — role: 'user' excludes admin accounts, which were
    // previously counted alongside real customers here.
    const totalUsers = await User.countDocuments({ ...userBase, role: 'user' });
    const newUsersToday = await User.countDocuments({
      ...userBase,
      role: 'user',
      createdAt: { $gte: today }
    });
    const newUsersThisMonth = await User.countDocuments({
      ...userBase,
      role: 'user',
      createdAt: { $gte: thisMonth }
    });
    const newUsersLastMonth = await User.countDocuments({
      ...userBase,
      role: 'user',
      createdAt: { $gte: lastMonth, $lte: lastMonthEnd }
    });

    // Products statistics — reads the legacy Product catalog, which is a
    // different, unpopulated collection from ProductMaster (what every
    // other admin surface actually uses), so this already returns all
    // zeros regardless of store. Left unscoped rather than pretending to
    // fix a collection nothing writes to; the panel doesn't render this
    // block today anyway.
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
    const totalOrders = await Order.countDocuments(orderBase);
    const ordersToday = await Order.countDocuments({ ...orderBase, order_placed_at: { $gte: today } });
    const ordersThisWeek = await Order.countDocuments({ ...orderBase, order_placed_at: { $gte: thisWeek } });
    const ordersThisMonth = await Order.countDocuments({ ...orderBase, order_placed_at: { $gte: thisMonth } });
    const ordersLastMonth = await Order.countDocuments({
      ...orderBase,
      order_placed_at: { $gte: lastMonth, $lte: lastMonthEnd }
    });

    const pendingOrders = await Order.countDocuments({
      ...orderBase,
      order_status: {
        $in: [
          ...LEGACY_STATUS_ALIASES[ORDER_STATUS.PENDING],
          ...LEGACY_STATUS_ALIASES[ORDER_STATUS.ACCEPTED],
          ...LEGACY_STATUS_ALIASES[ORDER_STATUS.ACCEPTED_BY_STORE]
        ]
      }
    });

    const deliveredOrders = await Order.countDocuments({
      ...orderBase,
      order_status: 'delivered'
    });

    // 'refunded' was folded into 'cancelled' when the status vocabulary was
    // aligned with the admin panel; only pre-rename documents still carry it.
    const refundedOrders = await Order.countDocuments({
      ...orderBase,
      order_status: 'refunded'
    });

    // Revenue statistics
    const revenueStats = await Order.aggregate([
      {
        $match: {
          ...orderBase,
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
          ...orderBase,
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
          ...orderBase,
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
          ...orderBase,
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
      // Echoes what was actually applied — the explicit selection, or the
      // admin's own store(s) when one was silently pinned, or null for a
      // genuine full-tenant view — so the panel can show which scope a
      // restricted admin is looking at even if it never sent store_code.
      store_code: storeFilter,
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
    const storeFilter = resolveStoreFilter(req);

    const salesTrend = await Order.aggregate([
      {
        $match: {
          ...(storeFilter ? { store_code: storeFilter } : {}),
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
    const storeFilter = resolveStoreFilter(req);

    const topProducts = await Order.aggregate([
      {
        $match: {
          ...(storeFilter ? { store_code: storeFilter } : {}),
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
    const storeFilter = resolveStoreFilter(req);

    const recentOrders = await Order.find(storeFilter ? { store_code: storeFilter } : {})
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
    const storeFilter = resolveStoreFilter(req);

    const distribution = await Order.aggregate([
      ...(storeFilter ? [{ $match: { store_code: storeFilter } }] : []),
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
    const storeFilter = resolveStoreFilter(req);

    const distribution = await Order.aggregate([
      ...(storeFilter ? [{ $match: { store_code: storeFilter } }] : []),
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
    const storeFilter = resolveStoreFilter(req);
    const userBase = (await resolveStoreCustomerFilter(storeFilter)) || {};

    // Active in last hour
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const activeLastHour = await User.countDocuments({
      ...userBase,
      role: 'user',
      lastActiveAt: { $gte: oneHourAgo }
    });

    // Active in last 24 hours
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const activeLastDay = await User.countDocuments({
      ...userBase,
      role: 'user',
      lastActiveAt: { $gte: oneDayAgo }
    });

    // Active in last 7 days
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const activeLastWeek = await User.countDocuments({
      ...userBase,
      role: 'user',
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
