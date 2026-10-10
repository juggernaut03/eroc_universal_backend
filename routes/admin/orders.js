const express = require('express');
const router = express.Router();
const Order = require('../../models/Order');
const User = require('../../models/User');
const { createOrderStatusNotification, createPaymentStatusNotification, createOrderItemChangedNotification } = require('../../utils/notificationService');
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
const Store = require('../../models/Store');

/**
 * Attach the outlet name for each order's store_code.
 *
 * Orders only store the code, but the pick list is headed by the store's name,
 * so it is resolved here in one query for the whole page rather than per row.
 * Orders whose store has since been removed keep a name of undefined and the
 * panel falls back to showing the code.
 */
const withStoreNames = async (orders) => {
  const codes = [...new Set(orders.map((order) => order.store_code).filter(Boolean))];
  if (codes.length === 0) return orders;

  const stores = await Store.find({ store_code: { $in: codes } })
    .select('store_code mobile_outlet_name')
    .lean();

  const nameByCode = new Map(stores.map((store) => [store.store_code, store.mobile_outlet_name]));

  return orders.map((order) => ({
    ...order,
    store_name: nameByCode.get(order.store_code)
  }));
};

/**
 * Mongo filter restricting a query to a store-restricted admin's own
 * store(s) — {} (no-op) for an unrestricted admin/super admin. Orders have
 * no per-request store_code the way /by-store does for products, so list
 * and stats queries need this injected rather than a simple presence check.
 */
const storeScope = (req) =>
  req.user.allowed_store_codes && req.user.allowed_store_codes.length > 0
    ? { store_code: { $in: req.user.allowed_store_codes } }
    : {};

/**
 * Loads one order by id, returning null if it doesn't exist OR belongs to a
 * store this admin can't access — callers respond 404 either way, so a
 * store-restricted admin can't tell "wrong id" from "not your store". Full
 * Mongoose document by default (callers that need instance methods like
 * order.updateStatus()); pass { lean: true } for read-only routes.
 */
const loadAccessibleOrder = async (req, id, { projection, lean = false } = {}) => {
  const query = Order.findById(id);
  // store_code is always needed for the access check below, regardless of
  // what the caller actually wants back.
  if (projection) query.select(`${projection} store_code`);
  if (lean) query.lean();
  const order = await query;
  if (!order || !req.user.canAccessStore(order.store_code)) return null;
  return order;
};

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
// Tax rate is baked into subtotal already (see utils/orderService.js) —
// this only recomputes the informational breakdown, never adds to the
// total, same convention as the checkout-time calculation.
const TAX_RATE = 0.18;
const includedTax = (amount) => round2((amount * TAX_RATE) / (1 + TAX_RATE));

/**
 * Recomputes order_summary from the current order_items after an admin
 * edits a line's quantity or removes it — subtotal/total_items/
 * total_quantity/total_amount/tax_amount only. Deliberately leaves
 * discount_amount, delivery_charges, packing_fee, applied_offer, and
 * applied_loyalty_redemption untouched: those were locked in against the
 * cart the customer actually checked out with, and re-evaluating offer/
 * loyalty eligibility against a now-smaller cart could retroactively take
 * away a discount the customer was already promised. A discount that's now
 * disproportionate to the edited order is a judgment call for the admin to
 * make separately, not something this recompute does automatically.
 */
const recomputeOrderSummary = (order) => {
  const activeItems = order.order_items.filter((item) => !item.removed);
  const subtotal = round2(activeItems.reduce((sum, item) => sum + item.total_price, 0));
  const discountAmount = order.order_summary.discount_amount || 0;
  const deliveryCharges = order.order_summary.delivery_charges || 0;
  const packingFee = order.order_summary.packing_fee || 0;

  order.order_summary.subtotal = subtotal;
  order.order_summary.total_items = activeItems.length;
  order.order_summary.total_quantity = activeItems.reduce((sum, item) => sum + item.quantity, 0);
  order.order_summary.total_amount = round2(subtotal + deliveryCharges + packingFee - discountAmount);
  order.order_summary.tax_amount = includedTax(subtotal - discountAmount);
};

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
    const query = { ...storeScope(req) };
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
      .skip(skip)
      .lean();

    // Get total count for pagination
    const total = await Order.countDocuments(query);

    res.status(200).json({
      success: true,
      data: await withStoreNames(orders),
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
    const order = await loadAccessibleOrder(req, req.params.id, { lean: true });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const [withName] = await withStoreNames([order]);

    res.status(200).json({
      success: true,
      data: withName
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
    const order = await loadAccessibleOrder(req, req.params.id, {
      lean: true,
      projection: 'order_number order_status status_history order_placed_at order_confirmed_at order_completed_at actual_delivery_date cancelled_at cancel_reason last_updated_at createdAt updatedAt store_code'
    });

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

    const order = await loadAccessibleOrder(req, req.params.id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Use the instance method to update status. Passing the admin through
    // records who made the change on the order's timeline.
    await order.updateStatus(status, adminActor(req.user), note);

    // Fire-and-forget: hand the order to SHALVI PICKER for warehouse
    // fulfillment the moment the admin accepts it — a no-op for any tenant
    // that hasn't turned this integration on (see utils/pickerIntegration.js).
    // Fires on ACCEPTED (the first/only manual click, labelled "Accept" in
    // the admin panel) rather than waiting for the separate ACCEPTED_BY_STORE
    // step — Picker's own picking_started sync already jumps the order
    // straight to IN_PACKAGING (see routes/picker-webhook.js's
    // EVENT_TO_STATUS), so accepted_by_store was never actually reached on
    // the automatic path; this just removes the redundant manual click
    // before handoff too.
    // Deliberately NOT inside order.updateStatus() itself: that method is
    // also called from the inbound Picker-status-sync webhook
    // (routes/webhooks/picker.js), where re-triggering a handoff on every
    // synced status would be wrong — this call only fires from a real
    // admin action.
    if (status === ORDER_STATUS.ACCEPTED) {
      require('../../utils/pickerIntegration')
        .sendOrderToPicker(order, req.tenant.project)
        .catch((e) => console.error('[picker-integration] handoff error:', e.message));
    } else if (status === ORDER_STATUS.CANCELLED) {
      // Only reaches Picker if the order was actually handed off already —
      // sendOrderCancelToPicker no-ops the same way sendOrderToPicker does
      // for a tenant without Picker enabled, and Picker's own cancel
      // endpoint is a no-op for an orders_idorders it never received.
      require('../../utils/pickerIntegration')
        .sendOrderCancelToPicker(order, req.tenant.project, note)
        .catch((e) => console.error('[picker-integration] cancel-sync error:', e.message));
    }

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

    const existing = await loadAccessibleOrder(req, req.params.id, { projection: '_id' });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

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

// @route   PATCH /api/admin/orders/:id/items/:pcode/quantity
// @desc    Change one line's quantity on an already-placed order (stock
//          shortfall, packing correction, etc). Recomputes order_summary
//          and pushes a notification to the customer.
// @access  Admin
router.patch('/:id/items/:pcode/quantity', checkPermission('orders', 'edit'), async (req, res) => {
  try {
    const quantity = Number(req.body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({
        success: false,
        message: 'quantity must be a whole number of at least 1 — use the remove endpoint to take a line out entirely'
      });
    }

    const order = await loadAccessibleOrder(req, req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const item = order.order_items.find((i) => i.p_code === req.params.pcode && !i.removed);
    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'This product is not an active line on this order (wrong p_code, or already removed)'
      });
    }

    if (item.quantity === quantity) {
      return res.status(200).json({ success: true, message: 'Quantity unchanged', data: order });
    }

    const oldQuantity = item.quantity;
    if (item.original_quantity === undefined) item.original_quantity = oldQuantity;
    item.quantity = quantity;
    item.total_price = round2(item.unit_price * quantity);
    item.edited_at = new Date();
    item.edited_by_name = adminActor(req.user).name;

    recomputeOrderSummary(order);
    order.last_updated_at = new Date();
    order.markModified('order_items');
    await order.save();

    if (order.mobile_no) {
      const user = await User.findOne({ mobile: order.mobile_no });
      if (user) {
        createOrderItemChangedNotification(
          user,
          order.order_number,
          'quantity',
          { productName: item.product_name, oldQuantity, newQuantity: quantity },
          req.tenant?.projectCode
        );
      }
    }

    res.status(200).json({
      success: true,
      message: `Quantity for ${item.product_name} updated to ${quantity}`,
      data: order
    });
  } catch (error) {
    console.error('Update order item quantity error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating item quantity',
      error: error.message
    });
  }
});

// @route   PATCH /api/admin/orders/:id/items/:pcode/remove
// @desc    Soft-remove one line from an already-placed order (out of
//          stock, unavailable, etc) — the line stays on the order marked
//          removed (shown strikethrough), never deleted. Recomputes
//          order_summary and pushes a notification to the customer.
// @access  Admin
router.patch('/:id/items/:pcode/remove', checkPermission('orders', 'edit'), async (req, res) => {
  try {
    const order = await loadAccessibleOrder(req, req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const item = order.order_items.find((i) => i.p_code === req.params.pcode && !i.removed);
    if (!item) {
      return res.status(404).json({
        success: false,
        message: 'This product is not an active line on this order (wrong p_code, or already removed)'
      });
    }

    const activeCount = order.order_items.filter((i) => !i.removed).length;
    if (activeCount <= 1) {
      return res.status(400).json({
        success: false,
        message: 'Cannot remove the last item on an order — cancel the order instead'
      });
    }

    if (item.original_quantity === undefined) item.original_quantity = item.quantity;
    item.removed = true;
    item.edited_at = new Date();
    item.edited_by_name = adminActor(req.user).name;

    recomputeOrderSummary(order);
    order.last_updated_at = new Date();
    order.markModified('order_items');
    await order.save();

    if (order.mobile_no) {
      const user = await User.findOne({ mobile: order.mobile_no });
      if (user) {
        createOrderItemChangedNotification(
          user,
          order.order_number,
          'removed',
          { productName: item.product_name },
          req.tenant?.projectCode
        );
      }
    }

    res.status(200).json({
      success: true,
      message: `${item.product_name} removed from the order`,
      data: order
    });
  } catch (error) {
    console.error('Remove order item error:', error);
    res.status(500).json({
      success: false,
      message: 'Error removing item',
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

    const existing = await loadAccessibleOrder(req, req.params.id, { projection: '_id' });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const order = await Order.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

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
    const order = await loadAccessibleOrder(req, req.params.id);

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

    const baseQuery = { ...storeScope(req) };

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
    const scope = storeScope(req);
    const totalOrders = await Order.countDocuments(scope);

    // Get orders by status
    const statusCounts = await Order.aggregate([
      { $match: scope },
      {
        $group: {
          _id: '$order_status',
          count: { $sum: 1 }
        }
      }
    ]);

    // Get payment status counts
    const paymentStatusCounts = await Order.aggregate([
      { $match: scope },
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
          ...scope,
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
      ...scope,
      order_placed_at: { $gte: today }
    });

    // Get this month's orders
    const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthOrders = await Order.countDocuments({
      ...scope,
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
          ...storeScope(req),
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
    //
    // storeScope filters this to the admin's own store(s) up front — a
    // store-restricted admin who submits someone else's store's order id
    // just has it silently dropped from the batch, same as a nonexistent id
    // already was.
    const targets = await Order.find({ _id: { $in: orderIds }, ...storeScope(req) })
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

    // bulkWrite bypasses Order.updateStatus() entirely (no save(), no
    // hooks), so the loyalty integration that lives inside it never fires
    // on its own for this route - fetch the now-updated full documents and
    // fire it explicitly for the two statuses loyalty cares about.
    if (status === 'delivered' || status === 'cancelled') {
      const { onOrderDelivered, onOrderCancelledOrRefunded } = require('../../utils/loyaltyOrderHooks');
      const updated = await Order.find({ _id: { $in: targets.map((t) => t._id) } });
      const hook = status === 'delivered' ? onOrderDelivered : onOrderCancelledOrRefunded;
      updated.forEach((order) => {
        hook(order).catch((e) => console.error('[loyalty] bulk-update hook error:', e));
      });
    }

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
