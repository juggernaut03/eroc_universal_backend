// Inbound status callbacks from SHALVI PICKER (warehouse picking + rider
// delivery) — the other half of utils/pickerIntegration.js's outbound
// handoff. Picker POSTs here as an order it received moves through picking
// and delivery; see utils/pickerIntegration.js's ownCallbackUrl() for how it
// learns this URL (sent on every order handoff) and the plan doc for the
// full status-mapping rationale.
//
// Mounted under /api, so the global tenantResolver middleware (see
// middleware/tenant.js) already resolves req.tenant from this request's
// `project_code` body field — the same field every other POST route here
// relies on — before this handler ever runs. No separate tenant lookup
// needed; the tenant-proxied Order model (required below) already resolves
// against the right tenant DB via that context.
const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const { ORDER_STATUS } = require('../constants/orderStatus');
const { getPickerIntegrationConfig } = require('../utils/tenantIntegrations');

// buildHistoryEntry/recordStatusChange accept an actor shaped
// { id, name, role } — role 'system' is what every non-admin, non-customer
// change (loyalty hooks, this webhook) already uses.
const PICKER_ACTOR = { name: 'Picker', role: 'system' };

// Picker event -> Universal order_status. An event not in this map (e.g.
// "rider_assigned") is logged on the order's timeline but doesn't move
// order_status — Universal's enum has no distinct "rider assigned" stage.
const EVENT_TO_STATUS = {
  picking_started: ORDER_STATUS.IN_PACKAGING,
  out_for_delivery: ORDER_STATUS.OUT_FOR_DELIVERY,
  delivered: 'delivered',
  delivery_failed: ORDER_STATUS.CANCELLED,
};

router.post('/status', async (req, res) => {
  try {
    const { event, orders_idorders, rider, reason } = req.body;

    if (!req.tenant?.project) {
      return res.status(400).json({ success: false, message: 'project_code is required' });
    }
    if (!orders_idorders) {
      return res.status(400).json({ success: false, message: 'orders_idorders is required' });
    }

    const config = await getPickerIntegrationConfig(req.tenant.project);
    const incomingSecret = req.headers['x-webhook-secret'];
    if (!config.enabled || !config.webhookSecret || incomingSecret !== config.webhookSecret) {
      return res.status(401).json({ success: false, message: 'Invalid or missing X-Webhook-Secret' });
    }

    // orders_idorders is Universal's own order_number (see
    // utils/pickerIntegration.js), but Picker stores/sends it back as a
    // Number ("0068" -> 68, stripping the leading zeros) — re-pad to
    // Universal's 4-digit format before looking it up. Unique within this
    // tenant's own DB, no extra project scoping needed since the tenant
    // proxy already resolved us to the right one.
    const order = await Order.findOne({ order_number: String(orders_idorders).padStart(4, '0') });
    if (!order) {
      return res.status(404).json({ success: false, message: `Order ${orders_idorders} not found` });
    }

    const targetStatus = EVENT_TO_STATUS[event];

    if (targetStatus) {
      await order.updateStatus(targetStatus, PICKER_ACTOR, `Picker: ${event}${reason ? ` (${reason})` : ''}`);
    } else if (event === 'rider_assigned') {
      order.recordStatusChange(order.order_status, {
        from: order.order_status,
        actor: PICKER_ACTOR,
        note: `Picker: rider assigned${rider?.name ? ` (${rider.name})` : ''}`,
      });
      await order.save();
    } else {
      // Unrecognized event — acknowledge without changing anything, so a
      // future Picker event type doesn't hard-fail the webhook.
      return res.json({ success: true, message: `Event '${event}' acknowledged, no status change` });
    }

    res.json({ success: true, order_number: order.order_number, order_status: order.order_status });
  } catch (error) {
    console.error('[picker-webhook] status update failed:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
