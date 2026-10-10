const express = require('express');
const router = express.Router();
const { resolveProject } = require('../middleware/tenant');
const { getTenantDb } = require('../config/database');
const { als } = require('../config/tenantContext');
const PromoPage = require('../models/PromoPage');
const Category = require('../models/Category');
const ProductMaster = require('../models/ProductMaster');

// @route   GET /api/public/promo-page/:projectCode
// @desc    Public (unauthenticated) download/promo landing page for a
//          tenant, shown at <admin-panel-domain>/<projectcode>. Project code
//          comes from the URL, not X-Project-Code, so this route is mounted
//          BEFORE the global tenantResolver in server.js and resolves the
//          tenant manually (same resolveProject() the header flow uses).
// @access  Public
router.get('/:projectCode', async (req, res) => {
  try {
    const projectCode = String(req.params.projectCode || '').trim().toUpperCase();
    if (!projectCode) {
      return res.status(404).json({ success: false, message: 'Page not found' });
    }

    const project = await resolveProject(projectCode);
    if (!project) {
      return res.status(404).json({ success: false, message: 'Page not found' });
    }

    const connection = getTenantDb(project.db_name);

    await als.run({ connection, project }, async () => {
      const promo = await PromoPage.findOne({}).lean();
      if (!promo || !promo.is_enabled) {
        return res.status(404).json({ success: false, message: 'Page not found' });
      }

      const [categories, products] = await Promise.all([
        Category.find({ is_visible: true })
          .select('category_name image_link')
          .limit(6)
          .lean(),
        ProductMaster.find({ 'stores.pcode_status': 'Y' })
          .select('p_code product_name pcode_img stores')
          .limit(6)
          .lean()
      ]);

      const shapedProducts = products.map((p) => {
        const listing = (p.stores || []).find((s) => s.pcode_status === 'Y') || {};
        return {
          p_code: p.p_code,
          product_name: p.product_name,
          image: p.pcode_img || '',
          price: listing.our_price != null ? Number(listing.our_price.toString()) : null,
          mrp: listing.product_mrp != null ? Number(listing.product_mrp.toString()) : null
        };
      });

      res.json({
        success: true,
        data: {
          project: {
            project_code: project.project_code,
            app_name: project.config?.app_name || '',
            logo_url: project.config?.logo_url || ''
          },
          promo: {
            headline: promo.headline,
            subheadline: promo.subheadline,
            hero_image_url: promo.hero_image_url,
            bullets: promo.bullets,
            android_url: promo.android_url,
            ios_url: promo.ios_url
          },
          categories: categories.map((c) => ({ name: c.category_name, image: c.image_link || '' })),
          products: shapedProducts
        }
      });
    });
  } catch (error) {
    console.error('Public promo page error:', error);
    res.status(500).json({ success: false, message: 'Something went wrong' });
  }
});

module.exports = router;
