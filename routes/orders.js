const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const AdminNotification = require('../models/AdminNotification');
const { protect } = require('../middleware/auth');
const { placeOrder } = require('../utils/orderService');
const { createOrderPlacedNotification } = require('../utils/notificationService');
const { CANCELLABLE_STATUSES } = require('../constants/orderStatus');

/**
 * @route   POST /api/orders/place-order
 * @desc    Place a new order. Every amount on the order is computed server-side
 *          from the cart, catalogue, store and offers — the body only selects
 *          which address / slot / payment mode / offer to apply.
 * @access  Private (requires JWT token)
 * @body    {
 *   "store_code": "PAG001",
 *   "delivery_slot_id": 1,
 *   "delivery_date": "2026-08-15",
 *   "address_id": "68f9fcfaa8873e89d5faf4f9",
 *   "payment_mode_id": 2,
 *   "order_notes": "Please handle with care",
 *   "offer_id": "...",            // optional
 *   "deal_items": [...],          // optional
 *   "payment_details": {          // required for online payment modes
 *     "razorpay_order_id": "order_...",
 *     "razorpay_payment_id": "pay_...",
 *     "razorpay_signature": "..."
 *   }
 * }
 * @header  Authorization: Bearer <jwt_token>
 * @header  X-Project-Code: <tenant code>
 */
router.post('/place-order', protect, async (req, res, next) => {
  try {
    const savedOrder = await placeOrder({
      user: req.user,
      body: req.body,
      project: req.tenant?.project,
    });

    // Notifications are best-effort: a failure here must not fail a placed order.
    if (req.user?._id) {
      createOrderPlacedNotification(
        req.user._id,
        savedOrder.order_number,
        savedOrder.order_summary.total_amount
      );
    }

    AdminNotification.create({
      title: 'New Order Placed',
      body: `Order #${savedOrder.order_number} — ₹${savedOrder.order_summary.total_amount} by ${req.user?.name || req.user?.mobile || 'Customer'}`,
      type: 'order',
      data: {
        order_number: savedOrder.order_number,
        order_id: savedOrder._id,
        total_amount: savedOrder.order_summary.total_amount,
        customer_name: req.user?.name,
        customer_mobile: req.user?.mobile,
        store_code: savedOrder.store_code
      }
    })
      .then((saved) => {
        const io = req.app.get('io');
        if (io) {
          io.to('admins').emit('new-admin-notification', {
            _id: saved._id,
            title: saved.title,
            body: saved.body,
            type: saved.type,
            data: saved.data,
            isRead: false,
            createdAt: saved.createdAt
          });
        }
      })
      .catch(err => console.error('Admin notification error:', err));

    res.status(201).json({
      success: true,
      message: 'Order placed successfully',
      order: {
        order_number: savedOrder.order_number,
        order_status: savedOrder.order_status,
        order_placed_at: savedOrder.order_placed_at,
        estimated_delivery_date: savedOrder.estimated_delivery_date,
        delivery_slot: `${savedOrder.delivery_info.delivery_slot_from} - ${savedOrder.delivery_info.delivery_slot_to}`,
        delivery_address: {
          full_name: savedOrder.delivery_info.delivery_address.full_name,
          line_1: savedOrder.delivery_info.delivery_address.line_1,
          city: savedOrder.delivery_info.delivery_address.city,
          pincode: savedOrder.delivery_info.delivery_address.pincode
        },
        payment_mode: savedOrder.payment_info.payment_mode_name,
        payment_status: savedOrder.payment_info.payment_status,
        order_summary: savedOrder.order_summary,
        items_count: savedOrder.order_summary.total_items
      }
    });
  } catch (error) {
    // Cart/pricing/payment rejections carry their own status and item details.
    if (error.name === 'OrderError') {
      return res.status(error.statusCode || 400).json({
        success: false,
        error: error.message,
        ...(error.details && { details: error.details })
      });
    }
    next(error);
  }
});

/**
 * @route   GET /api/orders/my-orders
 * @desc    Get user's order history
 * @access  Private (requires JWT token)
 * @header  Authorization: Bearer <jwt_token>
 */
router.get('/my-orders', protect, async (req, res, next) => {
  try {
    const userMobile = req.user.mobile;
    const limit = parseInt(req.query.limit) || 20;

    const orders = await Order.findByMobile(userMobile, limit);

    if (!orders || orders.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: 'No orders found',
        orders: []
      });
    }

    const ordersData = orders.map(order => ({
      order_number: order.order_number,
      order_status: order.order_status,
      order_placed_at: order.order_placed_at,
      estimated_delivery_date: order.estimated_delivery_date,
      actual_delivery_date: order.actual_delivery_date,
      delivery_slot: `${order.delivery_info.delivery_slot_from} - ${order.delivery_info.delivery_slot_to}`,
      delivery_address: {
        full_name: order.delivery_info.delivery_address.full_name,
        line_1: order.delivery_info.delivery_address.line_1,
        city: order.delivery_info.delivery_address.city,
        pincode: order.delivery_info.delivery_address.pincode
      },
      payment_mode: order.payment_info.payment_mode_name,
      payment_status: order.payment_info.payment_status,
      order_summary: order.order_summary,
      items_count: order.order_summary.total_items,
      order_items: order.order_items.map(item => ({
        product_code: item.p_code,
        product_name: item.product_name,
        product_brand: item.brand_name,
        product_image: item.pcode_img, // Map pcode_img to product_image
        unit_price: item.unit_price,
        quantity: item.quantity,
        total_price: item.total_price,
        uom: item.package_unit
      }))
    }));

    res.status(200).json({
      success: true,
      count: ordersData.length,
      message: `Found ${ordersData.length} order(s)`,
      orders: ordersData
    });

  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/orders/:orderNumber
 * @desc    Get order details by order number
 * @access  Private (requires JWT token)
 * @header  Authorization: Bearer <jwt_token>
 */
router.get('/:orderNumber', protect, async (req, res, next) => {
  try {
    const { orderNumber } = req.params;
    const userMobile = req.user.mobile;

    const order = await Order.findOne({
      order_number: orderNumber,
      mobile_no: userMobile
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    res.status(200).json({
      success: true,
      order: {
        order_number: order.order_number,
        order_status: order.order_status,
        order_placed_at: order.order_placed_at,
        order_confirmed_at: order.order_confirmed_at,
        order_completed_at: order.order_completed_at,
        estimated_delivery_date: order.estimated_delivery_date,
        actual_delivery_date: order.actual_delivery_date,
        delivery_info: order.delivery_info,
        payment_info: {
          payment_mode_name: order.payment_info.payment_mode_name,
          payment_status: order.payment_info.payment_status,
          transaction_id: order.payment_info.transaction_id
        },
        order_items: order.order_items,
        order_summary: order.order_summary,
        order_notes: order.order_notes
      }
    });

  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/orders/:orderNumber/cancel
 * @desc    Cancel own order (only before it is being prepared/shipped)
 * @access  Private (requires JWT token)
 */
router.post('/:orderNumber/cancel', protect, async (req, res, next) => {
  try {
    const { orderNumber } = req.params;
    const { cancel_reason } = req.body;

    const order = await Order.findOne({
      order_number: orderNumber,
      mobile_no: req.user.mobile
    });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    if (!CANCELLABLE_STATUSES.includes(order.order_status)) {
      return res.status(400).json({
        success: false,
        message: `Order cannot be cancelled once it is ${order.order_status}. Please contact support.`
      });
    }

    const previousStatus = order.order_status;
    order.order_status = 'cancelled';
    order.cancelled_at = new Date();
    order.last_updated_at = new Date();
    if (cancel_reason && String(cancel_reason).trim()) {
      order.cancel_reason = String(cancel_reason).trim();
    }
    order.recordStatusChange('cancelled', {
      from: previousStatus,
      at: order.cancelled_at,
      actor: { id: req.user._id, name: req.user.name, role: 'customer' },
      note: order.cancel_reason
    });
    await order.save();

    res.status(200).json({
      success: true,
      message: 'Order cancelled successfully',
      order: {
        order_number: order.order_number,
        order_status: order.order_status,
        cancelled_at: order.cancelled_at,
        cancel_reason: order.cancel_reason
      }
    });

  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/orders
 * @desc    Get all orders (for admin/testing purposes)
 * @access  Public
 */
router.get('/', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const status = req.query.status;

    let query = {};
    if (status) {
      query.order_status = status;
    }

    const orders = await Order.find(query)
      .sort({ order_placed_at: -1 })
      .limit(limit);

    if (!orders || orders.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: 'No orders found',
        orders: []
      });
    }

    const ordersData = orders.map(order => ({
      order_number: order.order_number,
      mobile_no: order.mobile_no,
      order_status: order.order_status,
      order_placed_at: order.order_placed_at,
      total_amount: order.order_summary.total_amount,
      total_items: order.order_summary.total_items,
      store_code: order.store_code
    }));

    res.status(200).json({
      success: true,
      count: ordersData.length,
      message: `Found ${ordersData.length} order(s)`,
      orders: ordersData
    });

  } catch (error) {
    next(error);
  }
});

module.exports = router;