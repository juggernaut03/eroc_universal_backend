// Hands an order off to SHALVI PICKER (warehouse picking + rider delivery)
// the moment it's placed, and lets Picker know if it's later cancelled.
// Fire-and-forget, same pattern as utils/loyaltyOrderHooks.js's hooks — never
// blocks or fails the status change that triggered it.
//
// A no-op for any tenant that hasn't turned this on (see
// utils/tenantIntegrations.js's getPickerIntegrationConfig) — every call site
// is safe to leave in place even for tenants that never configure Picker.
const { getPickerIntegrationConfig } = require('./tenantIntegrations');

const REQUEST_TIMEOUT_MS = 10_000;

// Two different secrets, two different directions — do not conflate them:
//
// 1. PICKER_SHARED_WEBHOOK_SECRET (env, platform-wide): the secret Picker's
//    OWN deployment requires on every inbound call to its
//    /api/webhook/order* endpoints (picker_app_backend's WEBHOOK_SECRET —
//    one fixed value for every caller, not something Universal gets to
//    choose per tenant). Sent as the X-Webhook-Secret header BY this file.
//
// 2. config.webhookSecret (project.secrets.picker_webhook_secret, per
//    tenant, generated when the integration is configured): the secret
//    Universal owns for the OPPOSITE direction — it's handed to Picker as
//    upstream_webhook_secret so Picker sends it back as X-Webhook-Secret
//    when it POSTs to routes/picker-webhook.js, which validates incoming
//    requests against this same per-tenant value.
function pickerSharedSecret() {
  return process.env.PICKER_SHARED_WEBHOOK_SECRET || '';
}

// Where Picker should POST status updates back to — see routes/picker-webhook.js.
function ownCallbackUrl() {
  const base = process.env.PUBLIC_API_BASE_URL || '';
  return base ? `${base.replace(/\/$/, '')}/api/webhook/picker/status` : null;
}

function buildItemsPayload(order) {
  return (order.order_items || [])
    .filter((item) => !item.removed)
    .map((item) => ({
      p_code: item.p_code,
      item_name: item.product_name,
      ordered_quantity: item.quantity,
      product_offer_price: item.unit_price,
      product_mrp: item.mrp ?? item.unit_price,
      total_amt_our_price: item.total_price,
      total_amt_mrp: (item.mrp ?? item.unit_price) * item.quantity,
      pack_size: item.package_size && item.package_unit ? `${item.package_size}${item.package_unit}` : null,
      pcode_img: item.pcode_img || null,
    }));
}

async function postToPicker(path, body, config) {
  const headers = { 'Content-Type': 'application/json' };
  const sharedSecret = pickerSharedSecret();
  if (sharedSecret) headers['X-Webhook-Secret'] = sharedSecret;

  const res = await fetch(`${config.webhookUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

/**
 * Hands one order off to Picker for warehouse fulfillment. Call once, right
 * after the order is placed (still 'pending' — no admin action required) so
 * a picker is auto-assigned immediately. Picker's own duplicate check
 * (scoped by project_code + orders_idorders) makes a repeat call harmless,
 * so calling this again later is always safe.
 */
async function sendOrderToPicker(order, project) {
  const config = await getPickerIntegrationConfig(project);
  if (!config.enabled || !config.webhookUrl) return { skipped: true };

  const items = buildItemsPayload(order);
  if (items.length === 0) return { skipped: true, reason: 'no_items' };

  const address = order.delivery_info?.delivery_address;

  const body = {
    project_code: order.project_code,
    store_code: order.store_code,
    // Picker parses this with Number(...) — "0007" -> 7. Dedup is scoped by
    // (project_code, orders_idorders), so every tenant restarting its own
    // counter at "0001" is fine (confirmed in picker_app_backend's own code).
    orders_idorders: order.order_number,
    order_date: order.order_placed_at,
    delivery_date: order.delivery_info?.delivery_date,
    delivery_slot: order.delivery_info
      ? `${order.delivery_info.delivery_slot_from} - ${order.delivery_info.delivery_slot_to}`
      : null,
    delivery_details: address
      ? [address.line_1, address.line_2, address.city, address.pincode].filter(Boolean).join(', ')
      : null,
    latitude: address?.latitude || null,
    longitude: address?.longitude || null,
    items,
    upstream_webhook_url: ownCallbackUrl(),
    upstream_webhook_secret: config.webhookSecret || undefined,
  };

  try {
    const result = await postToPicker('/api/webhook/order', body, config);
    return { ok: true, result };
  } catch (err) {
    console.error(`[picker-integration] order ${order.order_number} handoff failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

/** Tells Picker an already-handed-off order was cancelled on Universal's side. */
async function sendOrderCancelToPicker(order, project, reason) {
  const config = await getPickerIntegrationConfig(project);
  if (!config.enabled || !config.webhookUrl) return { skipped: true };

  try {
    const result = await postToPicker(
      '/api/webhook/order/cancel',
      { orders_idorders: order.order_number, project_code: order.project_code, reason },
      config
    );
    return { ok: true, result };
  } catch (err) {
    console.error(`[picker-integration] order ${order.order_number} cancel-sync failed:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendOrderToPicker, sendOrderCancelToPicker };
