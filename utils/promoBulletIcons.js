// Shared between models/PromoPage.js (schema enum), routes/admin/promo-page.js
// (PUT validation) — a small fixed icon set so the public page renderer never
// has to deal with an arbitrary/invalid Iconify name typed by an admin. The
// admin panel's promo-page settings page and public renderer mirror this same
// list of keys.
const PROMO_BULLET_ICONS = ['diamond', 'search', 'gift', 'star', 'truck', 'percent'];

module.exports = { PROMO_BULLET_ICONS };
