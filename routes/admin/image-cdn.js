const express = require('express');
const router = express.Router();

const { requireImageCdnAccess } = require('../../middleware/checkPermission');
const { upload } = require('../../config/mediaStorage');
const { syncProject, uploadPoolImage } = require('../../utils/imageSync');

// Every route here needs the dedicated imageCdnAccess flag — NOT covered by
// the isSuperAdmin bypass every other admin route gets (see
// middleware/checkPermission.js). protect/authorize('admin')/
// requireProjectAccess/subscription are already applied one level up in
// routes/admin.js.
router.use(requireImageCdnAccess);

// GET /api/admin/image-cdn/coverage
// Coverage for the tenant resolved from X-Project-Code, same as every other
// admin/content endpoint. "Matched" means pcode_img is actually set — which
// only ever happens via a real sync or a manual upload (utils/imageSync.js),
// never a guessed URL — so this reflects files that really exist.
router.get('/coverage', async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const ProductMaster = req.tenant.db.models.ProductMaster;

    const [total, matchedPrimary, matchedSecondary] = await Promise.all([
      ProductMaster.countDocuments({ project_code: projectCode }),
      ProductMaster.countDocuments({ project_code: projectCode, pcode_img: { $nin: [null, ''] } }),
      ProductMaster.countDocuments({ project_code: projectCode, pcode_img_2: { $nin: [null, ''] } })
    ]);

    res.json({
      success: true,
      data: {
        project_code: projectCode,
        total,
        matched_primary: matchedPrimary,
        matched_secondary: matchedSecondary,
        missing: total - matchedPrimary,
        coverage_pct: total > 0 ? Math.round((matchedPrimary / total) * 1000) / 10 : 0
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/image-cdn/missing?limit=200
router.get('/missing', async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const ProductMaster = req.tenant.db.models.ProductMaster;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

    const missing = await ProductMaster.find({
      project_code: projectCode,
      $or: [{ pcode_img: null }, { pcode_img: '' }]
    })
      .select('p_code barcode product_name')
      .limit(limit)
      .lean();

    res.json({ success: true, count: missing.length, data: missing });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/image-cdn/sync — manual only, no auto-trigger anywhere
// else in the codebase (see the architecture plan, §07).
router.post('/sync', async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const result = await syncProject(projectCode, {
      triggeredBy: req.user._id,
      triggeredByEmail: req.user.email
    });
    res.json({ success: true, message: `Synced ${projectCode}`, data: result });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/image-cdn/runs?limit=20
router.get('/runs', async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const ImageSyncRun = req.tenant.db.models.ImageSyncRun;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    const runs = await ImageSyncRun.find({ project_code: projectCode })
      .sort({ ran_at: -1 })
      .limit(limit)
      .lean();

    res.json({ success: true, count: runs.length, data: runs });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/image-cdn/upload — multipart: p_code, suffix (1|2,
// default 1), image (file). The manual backfill path for the missing list
// — writes into the shared pool (keyed by that product's own barcode) and
// immediately copies it into this tenant's public folder, so the one gap
// closes right away without waiting on a full re-sync.
router.post('/upload', upload.single('image'), async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const { p_code: pcode } = req.body;
    const suffix = parseInt(req.body.suffix, 10) === 2 ? 2 : 1;

    if (!pcode) {
      return res.status(400).json({ success: false, message: 'p_code is required' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'image file is required' });
    }

    const ProductMaster = req.tenant.db.models.ProductMaster;
    const product = await ProductMaster.findOne({ project_code: projectCode, p_code: pcode }).select('barcode');
    if (!product) {
      return res.status(404).json({ success: false, message: `No product ${pcode} in ${projectCode}` });
    }
    if (!product.barcode) {
      return res.status(422).json({
        success: false,
        message: `Product ${pcode} has no barcode on file — nothing to key the pool image by.`
      });
    }

    const result = await uploadPoolImage({
      barcode: product.barcode,
      suffix,
      buffer: req.file.buffer,
      projectCode,
      pcode
    });

    res.json({ success: true, message: `Image saved for ${pcode}`, data: result });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
