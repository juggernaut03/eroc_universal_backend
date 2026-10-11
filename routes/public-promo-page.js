const express = require('express');
const router = express.Router();
const { resolveProject } = require('../middleware/tenant');
const { getTenantDb } = require('../config/database');
const { als } = require('../config/tenantContext');
const PromoPage = require('../models/PromoPage');
const BestSeller = require('../models/BestSeller');
const SeasonalCategory = require('../models/SeasonalCategory');
const Category = require('../models/Category');
const Subcategory = require('../models/Subcategory');
const ProductMaster = require('../models/ProductMaster');

const PICKS_LIMIT = 8;
const CATEGORIES_LIMIT = 8;

// "Today's Special Picks" — active bestsellers, tenant-wide (no store
// filter, same as /api/best-sellers/list with no store_code given — see
// routes/best-sellers.js). A BestSeller doc is itself one section with its
// own products[]; flatten every active section's products together.
async function buildSpecialPicks() {
  const sections = await BestSeller.find({ is_active: true }).select('products').lean();

  const codes = [];
  const seen = new Set();
  for (const section of sections) {
    for (const item of section.products || []) {
      if (!seen.has(item.p_code)) {
        seen.add(item.p_code);
        codes.push(item.p_code);
      }
      if (codes.length >= PICKS_LIMIT) break;
    }
    if (codes.length >= PICKS_LIMIT) break;
  }
  if (codes.length === 0) return [];

  const productDocs = await ProductMaster.find({
    p_code: { $in: codes },
    stores: { $elemMatch: { pcode_status: 'Y' } }
  })
    .select('p_code product_name pcode_img stores')
    .lean();

  const byCode = new Map(productDocs.map((p) => [p.p_code, p]));

  return codes
    .map((code) => byCode.get(code))
    .filter(Boolean)
    .map((p) => {
      const listing = (p.stores || []).find((s) => s.pcode_status === 'Y') || {};
      return {
        p_code: p.p_code,
        product_name: p.product_name,
        image: p.pcode_img || '',
        price: listing.our_price != null ? Number(listing.our_price.toString()) : null,
        mrp: listing.product_mrp != null ? Number(listing.product_mrp.toString()) : null
      };
    });
}

// "Shop by Category" — currently-active seasonal categories (is_active +
// in date range, same as SeasonalCategory.findActiveBySeason), tenant-wide.
// Each item references either a Category or a Subcategory depending on
// reference_type — resolve both in one batched lookup per collection.
async function buildShopByCategory() {
  const sections = await SeasonalCategory.findActiveBySeason('all').select('subcategories').lean();

  const items = [];
  const seen = new Set();
  for (const section of sections) {
    for (const item of section.subcategories || []) {
      const key = `${item.reference_type || 'subcategory'}:${item.sub_category_id}`;
      if (!seen.has(key)) {
        seen.add(key);
        items.push(item);
      }
      if (items.length >= CATEGORIES_LIMIT) break;
    }
    if (items.length >= CATEGORIES_LIMIT) break;
  }
  if (items.length === 0) return [];

  const categoryIds = items.filter((i) => i.reference_type === 'category').map((i) => i.sub_category_id);
  const subcategoryIds = items
    .filter((i) => i.reference_type !== 'category')
    .map((i) => i.sub_category_id);

  const [categoryDocs, subcategoryDocs] = await Promise.all([
    categoryIds.length
      ? Category.find({ idcategory_master: { $in: categoryIds } })
          .select('idcategory_master category_name image_link')
          .lean()
      : [],
    subcategoryIds.length
      ? Subcategory.find({ idsub_category_master: { $in: subcategoryIds } })
          .select('idsub_category_master sub_category_name image_link')
          .lean()
      : []
  ]);

  const categoryMap = new Map(categoryDocs.map((c) => [c.idcategory_master, c]));
  const subcategoryMap = new Map(subcategoryDocs.map((s) => [s.idsub_category_master, s]));

  return items
    .map((item) => {
      if (item.reference_type === 'category') {
        const c = categoryMap.get(item.sub_category_id);
        return c ? { name: c.category_name, image: c.image_link || '' } : null;
      }
      const s = subcategoryMap.get(item.sub_category_id);
      return s ? { name: s.sub_category_name, image: s.image_link || '' } : null;
    })
    .filter(Boolean);
}

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

      const [products, categories] = await Promise.all([buildSpecialPicks(), buildShopByCategory()]);

      res.json({
        success: true,
        data: {
          project: {
            project_code: project.project_code,
            app_name: project.config?.app_name || '',
            logo_url: project.config?.logo_url || ''
          },
          promo: {
            top_tags: promo.top_tags || [],
            headline: promo.headline,
            subheadline: promo.subheadline,
            hero_image_url: promo.hero_image_url,
            bullets: promo.bullets,
            android_url: promo.android_url,
            ios_url: promo.ios_url
          },
          // "Today's Special Picks" (active bestsellers) and "Shop by
          // Category" (active seasonal categories) — see buildSpecialPicks/
          // buildShopByCategory above.
          products,
          categories
        }
      });
    });
  } catch (error) {
    console.error('Public promo page error:', error);
    res.status(500).json({ success: false, message: 'Something went wrong' });
  }
});

module.exports = router;
