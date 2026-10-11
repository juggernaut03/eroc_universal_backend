const mongoose = require('mongoose');
const { PROMO_BULLET_ICONS } = require('../utils/promoBulletIcons');

// Hex colors, e.g. "#1565C0". Empty means "use the page's built-in default"
// — same convention as Project.config's *_color fields.
const colorField = () => ({ type: String, trim: true, default: '' });

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
    background_color: colorField(),
    headline_color: colorField(),
    button_color: colorField(),
    // Highlights section
    highlights_bg_color: colorField(),
    highlights_title_color: colorField(),
    highlights_subtitle_color: colorField(),
    // "Today's Special Picks" / "Shop by Category" sections — each gets its
    // own section background; the product/category cards in both share one
    // card background color.
    picks_bg_color: colorField(),
    category_bg_color: colorField(),
    card_bg_color: colorField(),
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
