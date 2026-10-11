const mongoose = require('mongoose');
const { PROMO_BULLET_ICONS } = require('../utils/promoBulletIcons');

const promoBulletSchema = new mongoose.Schema(
  {
    icon: {
      type: String,
      enum: PROMO_BULLET_ICONS,
      default: 'star'
    },
    title: {
      type: String,
      trim: true,
      default: ''
    },
    subtitle: {
      type: String,
      trim: true,
      default: ''
    }
  },
  { _id: false }
);

// One document per tenant DB (singleton) — the public download/promo
// landing page shown at <admin-panel-domain>/<projectcode>, editable from
// the admin panel's "Promo Page" settings section.
const promoPageSchema = new mongoose.Schema(
  {
    is_enabled: {
      type: Boolean,
      default: false
    },
    // Short eyebrow lines above the headline (e.g. "Grocery • Daily
    // Essentials") — plain text, no icon, unlike `bullets` below.
    top_tags: {
      type: [String],
      default: []
    },
    headline: {
      type: String,
      trim: true,
      default: ''
    },
    subheadline: {
      type: String,
      trim: true,
      default: ''
    },
    hero_image_url: {
      type: String,
      trim: true,
      default: ''
    },
    bullets: {
      type: [promoBulletSchema],
      default: []
    },
    android_url: {
      type: String,
      trim: true,
      default: ''
    },
    ios_url: {
      type: String,
      trim: true,
      default: ''
    }
  },
  { timestamps: true }
);

module.exports = require('./tenantModel')('PromoPage', promoPageSchema);
