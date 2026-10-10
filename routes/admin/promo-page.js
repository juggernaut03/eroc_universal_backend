const express = require('express');
const router = express.Router();
const PromoPage = require('../../models/PromoPage');
const { checkPermission } = require('../../middleware/checkPermission');
const { PROMO_BULLET_ICONS } = require('../../utils/promoBulletIcons');

// protect / authorize('admin') / requireProjectAccess are already applied
// globally in routes/admin.js, above every sub-router including this one.
const view = checkPermission('promoPage', 'view');
const edit = checkPermission('promoPage', 'edit');

const MAX_BULLETS = 4;

// @route   GET /api/admin/promo-page
// @desc    Get this tenant's promo/download landing page config (creates a
//          disabled default shape in the response if none is saved yet —
//          nothing is written until the admin actually saves).
// @access  Private/Admin (promoPage:view)
router.get('/', view, async (req, res) => {
  try {
    const promo = await PromoPage.findOne({}).lean();

    res.json({
      success: true,
      data: promo || {
        is_enabled: false,
        headline: '',
        subheadline: '',
        hero_image_url: '',
        bullets: [],
        android_url: '',
        ios_url: ''
      },
      icon_options: PROMO_BULLET_ICONS
    });
  } catch (error) {
    console.error('Get promo page error:', error);
    res.status(500).json({ success: false, message: 'Failed to load promo page settings' });
  }
});

// @route   PUT /api/admin/promo-page
// @desc    Upsert this tenant's promo/download landing page config
// @access  Private/Admin (promoPage:edit)
router.put('/', edit, async (req, res) => {
  try {
    const { is_enabled, headline, subheadline, hero_image_url, bullets, android_url, ios_url } = req.body;

    if (bullets !== undefined) {
      if (!Array.isArray(bullets)) {
        return res.status(400).json({ success: false, message: 'bullets must be an array' });
      }
      if (bullets.length > MAX_BULLETS) {
        return res.status(400).json({ success: false, message: `At most ${MAX_BULLETS} bullets are allowed` });
      }
      for (const b of bullets) {
        if (b.icon && !PROMO_BULLET_ICONS.includes(b.icon)) {
          return res.status(400).json({ success: false, message: `Invalid icon: ${b.icon}` });
        }
      }
    }

    const update = {};
    if (is_enabled !== undefined) update.is_enabled = Boolean(is_enabled);
    if (headline !== undefined) update.headline = String(headline).trim();
    if (subheadline !== undefined) update.subheadline = String(subheadline).trim();
    if (hero_image_url !== undefined) update.hero_image_url = String(hero_image_url).trim();
    if (android_url !== undefined) update.android_url = String(android_url).trim();
    if (ios_url !== undefined) update.ios_url = String(ios_url).trim();
    if (bullets !== undefined) {
      update.bullets = bullets.map((b) => ({
        icon: PROMO_BULLET_ICONS.includes(b.icon) ? b.icon : 'star',
        title: String(b.title || '').trim(),
        subtitle: String(b.subtitle || '').trim()
      }));
    }

    const promo = await PromoPage.findOneAndUpdate(
      {},
      { $set: update },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({ success: true, message: 'Promo page saved', data: promo });
  } catch (error) {
    console.error('Update promo page error:', error);
    res.status(500).json({ success: false, message: 'Failed to save promo page settings' });
  }
});

module.exports = router;
