const express = require('express');
const router = express.Router();
const Order = require('../../models/Order');
const User = require('../../models/User');
const { createOrderStatusNotification, createPaymentStatusNotification } = require('../../utils/notificationService');
const { checkPermission } = require('../../middleware/checkPermission');
const {
  ORDER_STATUS,
  ORDER_STATUSES,
  NON_REVENUE_STATUSES,
  LEGACY_STATUS_ALIASES,
  isValidStatus,
  normalizeStatus,
  buildStatusQuery
} = require('../../constants/orderStatus');
const { adminActor, buildTimeline, buildHistoryEntry } = require('../../utils/orderStatusHistory');

// @route   GET /api/admin/orders
// @desc    Get all orders with filtering and pagination
// @access  Admin
router.get('/', checkPermission('orders', 'view'), async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      status = '',
      paymentStatus = '',
      startDate = '',
      endDate = '',
      sortBy = 'order_placed_at',
      sortOrder = 'desc'
    } = req.query;

    // Build query. Conditions go through $and because both the search filter
    // and the Payment Processing status bucket need their own $or.
    const query = {};
    const conditions = [];

    // Search by order number or mobile number
    if (search) {
      conditions.push({
        $or: [
          { order_number: { $regex: search, $options: 'i' } },
          { mobile_no: { $regex: search, $options: 'i' } },
          { 'customer_info.name': { $regex: search, $options: 'i' } },
          { 'customer_info.email': { $regex: search, $options: 'i' } }
        ]
      });
    }

    // Filter by order status. Buckets are mutually exclusive — see
    // constants/orderStatus.js for how Pending and Payment Processing split.
    if (status) {
      conditions.push(buildStatusQuery(normalizeStatus(status)));
    }

    // Filter by payment status
    if (paymentStatus) {
      conditions.push({ 'payment_info.payment_status': paymentStatus });
    }

    // Filter by date range
    if (startDate || endDate) {
      query.order_placed_at = {};
      if (startDate) {
        query.order_placed_at.$gte = new Date(startDate);
      }
      if (endDate) {
        query.order_placed_at.$lte = new Date(endDate);
      }
    }

    if (conditions.length) {
      query.$and = conditions;
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const orders = await Order.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    // Get total count for pagination
    const total = await Order.countDocuments(query);

    res.status(200).json({
      success: true,
      data: orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching orders',
      error: error.message
    });
  }
});

// @route   GET /api/admin/orders/:id
// @desc    Get single order by ID
// @access  Admin
router.get('/:id', checkPermission('orders', 'view'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    res.status(200).json({
      success: true,
      data: order
    });
  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching order',
      error: error.message
    });
  }
});

// @route   GET /api/admin/orders/:id/history
// @desc    Status change timeline for one order. Orders placed before
//          status_history existed get a timeline derived from their
//          timestamps, with those entries marked `derived`.
// @access  Admin
router.get('/:id/history', checkPermission('orders', 'view'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .select('order_number order_status status_history order_placed_at order_confirmed_at order_completed_at actual_delivery_date cancelled_at cancel_reason last_updated_at createdAt updatedAt')
      .lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const timeline = buildTimeline(order);

    res.status(200).json({
      success: true,
      data: {
        order_number: order.order_number,
        current_status: normalizeStatus(order.order_status),
        // True when nothing was recorded and the timeline had to be inferred.
        derived: timeline.length > 0 && timeline.every((entry) => entry.derived),
        timeline
      }
    });
  } catch (error) {
    console.error('Get order history error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching order history',
      error: error.message
    });
  }
});

// @route   PATCH /api/admin/orders/:id/status
// @desc    Update order status
// @access  Admin
router.patch('/:id/status', checkPermission('orders', 'edit'), async (req, res) => {
  try {
    const { status, note } = req.body;

    if (!status || !isValidStatus(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${ORDER_STATUSES.join(', ')}`
      });
    }

    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Use the instance method to update status. Passing the admin through
    // records who made the change on the order's timeline.
    await order.updateStatus(status, adminActor(req.user), note);

    // Create in-app notification for the user (API-based, no Firebase)
    if (order.mobile_no) {
      console.log(`📋 Looking up user for mobile: ${order.mobile_no}`);
      const user = await User.findOne({ mobile: order.mobile_no });
      if (user) {
        console.log(`✅ User found: ${user._id}, creating notification...`);
        createOrderStatusNotification(user._id, order.order_number, status);
      } else {
        console.log(`⚠️ No user found for mobile: ${order.mobile_no}`);
      }
    } else {
      console.log(`⚠️ Order has no mobile_no: ${order.order_number}`);
    }

    res.status(200).json({
      success: true,
      message: `Order status updated to ${status} successfully`,
      data: order
    });
  } catch (error) {
    console.error('Update order status error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating order status',
      error: error.message
    });
  }
});

// @route   PATCH /api/admin/orders/:id/payment-status
// @desc    Update payment status
// @access  Admin
router.patch('/:id/payment-status', checkPermission('orders', 'edit'), async (req, res) => {
  try {
    const { paymentStatus, transactionId } = req.body;

    const validPaymentStatuses = ['pending', 'processing', 'completed', 'failed', 'cancelled'];
    if (!paymentStatus || !validPaymentStatuses.includes(paymentStatus)) {
      return res.status(400).json({
        success: false,
        message: `Invalid payment status. Must be one of: ${validPaymentStatuses.join(', ')}`
      });
    }

    const updateData = {
      'payment_info.payment_status': paymentStatus,
      last_updated_at: new Date()
    };

    if (transactionId) {
      updateData['payment_info.transaction_id'] = transactionId;
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Create in-app notification for the user (API-based, no Firebase)
    if (order.mobile_no) {
      const user = await User.findOne({ mobile: order.mobile_no });
      if (user) {
        createPaymentStatusNotification(user._id, order.order_number, paymentStatus);
      }
    }

    res.status(200).json({
      success: true,
      message: `Payment status updated to ${paymentStatus} successfully`,
      data: order
    });
  } catch (error) {
    console.error('Update payment status error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating payment status',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/orders/:id
// @desc    Update order details
// @access  Admin
router.put('/:id', checkPermission('orders', 'edit'), async (req, res) => {
  try {
    // A status change coming through here would bypass the timeline, so it is
    // held back and applied separately below via updateStatus().
    const { order_status: requestedStatus, status_history, ...rest } = req.body;

    if (requestedStatus && !isValidStatus(normalizeStatus(requestedStatus))) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${ORDER_STATUSES.join(', ')}`
      });
    }

    const updateData = {
      ...rest,
      last_updated_at: new Date()
    };

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    if (requestedStatus && normalizeStatus(requestedStatus) !== normalizeStatus(order.order_status)) {
      await order.updateStatus(requestedStatus, adminActor(req.user));
    }

    res.status(200).json({
      success: true,
      message: 'Order updated successfully',
      data: order
    });
  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating order',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/orders/:id
// @desc    Delete order (only if not processed)
// @access  Admin
router.delete('/:id', checkPermission('orders', 'delete'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Only allow deletion if order is in placed or cancelled status
    const deletableStatuses = [
      ...LEGACY_STATUS_ALIASES[ORDER_STATUS.PENDING],
      ...LEGACY_STATUS_ALIASES[ORDER_STATUS.CANCELLED]
    ];
    if (!deletableStatuses.includes(order.order_status)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete order that is being processed or completed'
      });
    }

    await Order.findByIdAndDelete(req.params.id);

    res.status(200).json({
      success: true,
      message: 'Order deleted successfully'
    });
  } catch (error) {
    console.error('Delete order error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting order',
      error: error.message
    });
  }
});

// @route   GET /api/admin/orders/stats/status-counts
// @desc    Count orders in each admin status tab
// @access  Admin
// Counts honour the search and date filters but deliberately ignore the status
// filter, so the tab badges stay stable while the admin switches between tabs.
router.get('/stats/status-counts', checkPermission('orders', 'view'), async (req, res) => {
  try {
    const { search = '', startDate = '', endDate = '' } = req.query;

    const baseQuery = {};

    if (search) {
      baseQuery.$or = [
        { order_number: { $regex: search, $options: 'i' } },
        { mobile_no: { $regex: search, $options: 'i' } },
        { 'customer_info.name': { $regex: search, $options: 'i' } },
        { 'customer_info.email': { $regex: search, $options: 'i' } }
      ];
    }

    if (startDate || endDate) {
      baseQuery.order_placed_at = {};
      if (startDate) baseQuery.order_placed_at.$gte = new Date(startDate);
      if (endDate) baseQuery.order_placed_at.$lte = new Date(endDate);
    }

    const hasBaseFilters = Object.keys(baseQuery).length > 0;

    const entries = await Promise.all(
      ORDER_STATUSES.map(async (status) => {
        const statusQuery = buildStatusQuery(status);
        const query = hasBaseFilters ? { $and: [baseQuery, statusQuery] } : statusQuery;
        return [status, await Order.countDocuments(query)];
      })
    );

    const counts = Object.fromEntries(entries);
    const total = await Order.countDocuments(baseQuery);

    res.status(200).json({
      success: true,
      data: { total, counts }
    });
  } catch (error) {
    console.error('Get order status counts error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching order status counts',
      error: error.message
    });
  }
});

// @route   GET /api/admin/orders/stats/overview
// @desc    Get order statistics overview
// @access  Admin
router.get('/stats/overview', checkPermission('orders', 'view'), async (req, res) => {
  try {
    const totalOrders = await Order.countDocuments();

    // Get orders by status
    const statusCounts = await Order.aggregate([
      {
        $group: {
          _id: '$order_status',
          count: { $sum: 1 }
        }
      }
    ]);

    // Get payment status counts
    const paymentStatusCounts = await Order.aggregate([
      {
        $group: {
          _id: '$payment_info.payment_status',
          count: { $sum: 1 }
        }
      }
    ]);

    // Get total revenue
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
          averageOrderValue: { $avg: '$order_summary.total_amount' },
          totalItems: { $sum: '$order_summary.total_items' }
        }
      }
    ]);

    // Get today's orders
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayOrders = await Order.countDocuments({
      order_placed_at: { $gte: today }
    });

    // Get this month's orders
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthOrders = await Order.countDocuments({
      order_placed_at: { $gte: firstDayOfMonth }
    });

    res.status(200).json({
      success: true,
      data: {
        totalOrders,
        todayOrders,
        monthOrders,
        statusCounts: statusCounts.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        paymentStatusCounts: paymentStatusCounts.reduce((acc, item) => {
          acc[item._id] = item.count;
          return acc;
        }, {}),
        revenue: revenueStats[0] || {
          totalRevenue: 0,
          averageOrderValue: 0,
          totalItems: 0
        }
      }
    });
  } catch (error) {
    console.error('Get order stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching order statistics',
      error: error.message
    });
  }
});

// @route   GET /api/admin/orders/stats/revenue
// @desc    Get revenue statistics by date range
// @access  Admin
router.get('/stats/revenue', checkPermission('orders', 'view'), async (req, res) => {
  try {
    const {
      startDate = new Date(new Date().setDate(new Date().getDate() - 30)),
      endDate = new Date(),
      groupBy = 'day'
    } = req.query;

    let dateFormat;
    switch (groupBy) {
      case 'day':
        dateFormat = { $dateToString: { format: '%Y-%m-%d', date: '$order_placed_at' } };
        break;
      case 'month':
        dateFormat = { $dateToString: { format: '%Y-%m', date: '$order_placed_at' } };
        break;
      case 'year':
        dateFormat = { $dateToString: { format: '%Y', date: '$order_placed_at' } };
        break;
      default:
        dateFormat = { $dateToString: { format: '%Y-%m-%d', date: '$order_placed_at' } };
    }

    const revenueByDate = await Order.aggregate([
      {
        $match: {
          order_placed_at: {
            $gte: new Date(startDate),
            $lte: new Date(endDate)
          },
          order_status: { $nin: NON_REVENUE_STATUSES }
        }
      },
      {
        $group: {
          _id: dateFormat,
          totalRevenue: { $sum: '$order_summary.total_amount' },
          orderCount: { $sum: 1 },
          averageOrderValue: { $avg: '$order_summary.total_amount' }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ]);

    res.status(200).json({
      success: true,
      data: revenueByDate
    });
  } catch (error) {
    console.error('Get revenue stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching revenue statistics',
      error: error.message
    });
  }
});

// @route   POST /api/admin/orders/bulk-update-status
// @desc    Bulk update order status
// @access  Admin
router.post('/bulk-update-status', checkPermission('orders', 'edit'), async (req, res) => {
  try {
    const { orderIds, status } = req.body;

    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Order IDs array is required'
      });
    }

    if (!status || !isValidStatus(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${ORDER_STATUSES.join(', ')}`
      });
    }

    // Done as one bulkWrite rather than updateMany so each order can record
    // its own from_status on the timeline — updateMany has no way to reference
    // the value it is replacing.
    const targets = await Order.find({ _id: { $in: orderIds } })
      .select('_id order_status')
      .lean();

    const actor = adminActor(req.user);
    const changedAt = new Date();
    const operations = targets.map((target) => ({
      updateOne: {
        filter: { _id: target._id },
        update: {
          $set: { order_status: status, last_updated_at: changedAt },
          $push: {
            status_history: buildHistoryEntry(status, {
              from: target.order_status,
              actor,
              at: changedAt,
              note: 'Bulk status update'
            })
          }
        }
      }
    }));

    const result = operations.length
      ? await Order.bulkWrite(operations)
      : { matchedCount: 0, modifiedCount: 0 };

    res.status(200).json({
      success: true,
      message: `Updated ${result.modifiedCount} orders to ${status}`,
      data: {
        matched: result.matchedCount,
        modified: result.modifiedCount
      }
    });
  } catch (error) {
    console.error('Bulk update error:', error);
    res.status(500).json({
      success: false,
      message: 'Error in bulk update',
      error: error.message
    });
  }
});

module.exports = router;
