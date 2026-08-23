const mongoose = require('mongoose');

// Per-tenant content for the customer-facing loyalty membership card
// (mobile app, front + back). Singleton document (one per tenant DB),
// same pattern as DigitalCartSettings - schema defaults double as the
// "not configured yet" response, so `new Model().toObject()` = defaults.
//
// Per-tier colors (how the card looks) live on LoyaltyTier
// (cardPrimaryColor/cardAccentColor) instead of here, since a tenant with
// four tiers wants four different-looking cards, not one shared color; this
// document only holds what's the same across every tier's card.
//
// card_primary_color/card_accent_color below are the exception: a fallback
// pair used only while a customer hasn't reached any tier yet (brand-new
// account, currentTierCode still null), so the card they see on day one is
// still tenant-configured instead of a hardcoded color baked into the
// client. See routes/loyalty.js's GET /card for how tier colors win once a
// tier applies.
const benefitSchema = new mongoose.Schema({
  icon: {
    // A Flutter Material icon name the app maps to a glyph (card_giftcard,
    // star, local_offer, ...) - not a URL, so there's no asset to host.
    type: String,
    trim: true,
    default: 'card_giftcard'
  },
  title: { type: String, trim: true, default: '' },
  subtitle: { type: String, trim: true, default: '' }
}, { _id: false });

const loyaltyCardSettingsSchema = new mongoose.Schema({
  brand_title: {
    type: String,
    trim: true,
    default: 'LOYALTY'
  },
  brand_subtitle: {
    type: String,
    trim: true,
    default: 'MEMBER'
  },
  member_label: {
    type: String,
    trim: true,
    default: 'LOYAL MEMBER'
  },
  card_number_prefix: {
    type: String,
    trim: true,
    default: 'LP'
  },
  thank_you_message: {
    type: String,
    trim: true,
    default: 'Thank you for being a valued member'
  },
  benefits: {
    type: [benefitSchema],
    default: [
      { icon: 'card_giftcard', title: 'Earn Points', subtitle: 'For every purchase' },
      { icon: 'star', title: 'Exclusive Rewards', subtitle: 'Enjoy member only benefits' },
      { icon: 'local_offer', title: 'Special Offers', subtitle: 'Just for you' }
    ]
  },
  support_phone: {
    type: String,
    trim: true,
    default: ''
  },
  website: {
    type: String,
    trim: true,
    default: ''
  },
  terms_text: {
    type: String,
    trim: true,
    default: 'Terms & Conditions Apply'
  },
  card_primary_color: {
    type: String,
    trim: true,
    default: '#1A1A1A'
  },
  card_accent_color: {
    type: String,
    trim: true,
    default: '#D4AF37'
  }
}, {
  timestamps: true,
  collection: 'loyalty_card_settings'
});

module.exports = require('./tenantModel')('LoyaltyCardSettings', loyaltyCardSettingsSchema);
