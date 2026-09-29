/**
 * Notification Service
 * Creates in-app notifications for order events. Most of these are in-app
 * only (no Firebase push) — createOrderItemChangedNotification is the
 * exception, since it also pushes via FCM.
 */

const Notification = require('../models/Notification');
const { normalizeStatus } = require('../constants/orderStatus');
const fcm = require('./fcm');

/**
 * Create notification when user places an order
 * @param {string} userId - MongoDB User ID
 * @param {string} orderNumber - Order number
 * @param {number} totalAmount - Order total amount
 */
const createOrderPlacedNotification = async (userId, orderNumber, totalAmount) => {
    try {
        await Notification.create({
            user: userId,
            title: 'Order Placed Successfully! 🎉',
            body: `Your order #${orderNumber} worth ₹${totalAmount.toLocaleString('en-IN')} has been placed successfully. We'll notify you when it's confirmed.`,
            type: 'order',
            data: {
                orderNumber,
                totalAmount,
                action: 'order_placed'
            }
        });
        console.log(`📦 Notification created: Order placed #${orderNumber}`);
    } catch (error) {
        console.error('Error creating order placed notification:', error);
        // Don't throw - notification creation shouldn't break order flow
    }
};

/**
 * Create notification when order status is updated
 * @param {string} userId - MongoDB User ID
 * @param {string} orderNumber - Order number
 * @param {string} newStatus - New order status
 */
const createOrderStatusNotification = async (userId, orderNumber, newStatus) => {
    try {
        // Map status to user-friendly messages. Keyed by the current status
        // vocabulary; legacy values are folded first so pre-rename callers
        // still get the right copy.
        const statusMessages = {
            'pending': 'Your order has been placed and is awaiting confirmation.',
            'accepted': 'Your order has been accepted! We are preparing it.',
            'accepted_by_store': 'The store has accepted your order.',
            'in_packaging': 'Your order is being packed and will be dispatched soon!',
            'out_for_delivery': 'Your order is on its way! 🚚',
            'delivered': 'Your order has been delivered! Thank you for shopping with us. 🎉',
            'cancelled': 'Your order has been cancelled.'
        };

        const statusEmojis = {
            'pending': '🕒',
            'accepted': '✅',
            'accepted_by_store': '🏬',
            'in_packaging': '📦',
            'out_for_delivery': '🚚',
            'delivered': '🎉',
            'cancelled': '❌'
        };

        const status = normalizeStatus(newStatus);
        const emoji = statusEmojis[status] || '📋';
        const message = statusMessages[status] || `Order status updated to ${status}.`;

        await Notification.create({
            user: userId,
            title: `Order Update ${emoji}`,
            body: `Order #${orderNumber}: ${message}`,
            type: 'order',
            data: {
                orderNumber,
                status,
                action: 'order_status_updated'
            }
        });
        console.log(`📦 Notification created: Order status updated #${orderNumber} -> ${status}`);
    } catch (error) {
        console.error('Error creating order status notification:', error);
    }
};

/**
 * Create notification when payment status is updated
 * @param {string} userId - MongoDB User ID
 * @param {string} orderNumber - Order number
 * @param {string} paymentStatus - New payment status
 */
const createPaymentStatusNotification = async (userId, orderNumber, paymentStatus) => {
    try {
        const paymentMessages = {
            'completed': 'Payment received successfully! ✅',
            'failed': 'Payment failed. Please try again or contact support.',
            'processing': 'Payment is being processed.',
            'cancelled': 'Payment has been cancelled.',
            'pending': 'Payment is pending.'
        };

        const message = paymentMessages[paymentStatus] || `Payment status: ${paymentStatus}`;

        await Notification.create({
            user: userId,
            title: 'Payment Update 💳',
            body: `Order #${orderNumber}: ${message}`,
            type: 'order',
            data: {
                orderNumber,
                paymentStatus,
                action: 'payment_status_updated'
            }
        });
        console.log(`💳 Notification created: Payment status updated #${orderNumber} -> ${paymentStatus}`);
    } catch (error) {
        console.error('Error creating payment status notification:', error);
    }
};

/**
 * Notify a customer that an admin edited an already-placed order: a line's
 * quantity was changed, or a line was removed entirely. Unlike the other
 * notifications in this file, this one also pushes via FCM — an admin
 * changing what's actually going to arrive needs to reach the customer
 * even if the app isn't open, not just wait in their in-app list.
 * @param {import('mongoose').Document} user - full User document (needs fcmToken)
 * @param {string} orderNumber
 * @param {'quantity'|'removed'} changeType
 * @param {Object} details - { productName, oldQuantity?, newQuantity? }
 * @param {string} [projectCode] - tenant, to send via its own Firebase project
 */
const createOrderItemChangedNotification = async (user, orderNumber, changeType, details, projectCode) => {
    const { productName, oldQuantity, newQuantity } = details;

    const title = changeType === 'removed' ? 'Item Removed from Your Order 📝' : 'Order Quantity Updated 📝';
    const body = changeType === 'removed'
        ? `Order #${orderNumber}: ${productName} was removed from your order. Your order total has been updated.`
        : `Order #${orderNumber}: ${productName} quantity changed from ${oldQuantity} to ${newQuantity}. Your order total has been updated.`;

    const data = {
        orderNumber,
        action: 'order_item_changed',
        changeType,
        productName,
        // The app's push-tap handler navigates by this field alone (see
        // firebase_notification_service.dart's _handleMessageNavigation) —
        // there's no deep-link route for one specific order yet, only the
        // list, so this lands the customer somewhere they can find the
        // change rather than at a dead end.
        url: '/my-orders',
        ...(oldQuantity !== undefined ? { oldQuantity: String(oldQuantity) } : {}),
        ...(newQuantity !== undefined ? { newQuantity: String(newQuantity) } : {})
    };

    try {
        await Notification.create({
            user: user._id,
            title,
            body,
            type: 'order',
            data
        });
    } catch (error) {
        console.error('Error creating order item change notification:', error);
    }

    if (!user.fcmToken) {
        console.log(`📝 Order item change: no FCM token for user ${user._id}, in-app only`);
        return;
    }

    try {
        await fcm.sendNotificationToUser(user, title, body, data, projectCode);
        console.log(`📝 Push sent: order item change #${orderNumber} (${changeType})`);
    } catch (error) {
        console.error('Error sending order item change push:', error.message);
    }
};

module.exports = {
    createOrderPlacedNotification,
    createOrderStatusNotification,
    createPaymentStatusNotification,
    createOrderItemChangedNotification
};
