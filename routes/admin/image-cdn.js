const os = require('os');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const router = express.Router();

const { requireImageCdnAccess } = require('../../middleware/checkPermission');
const { upload } = require('../../config/mediaStorage');
const { syncProject, uploadPoolImage, bulkAddToPool, bulkUploadForTenant, findPoolFile } = require('../../utils/imageSync');
const {
  generateCrossTenantSuggestions,
  startWebSearchJob,
  listWebSearchJobs,
  getWebSearchJob,
  acceptSuggestion,
  rejectSuggestion,
  getSuggestionStats
} = require('../../utils/imageSuggest');
const { getOrCreateSettings } = require('../../models/PlatformSetting');

// Separate multer instance from config/mediaStorage's — bulk pool uploads
// can be dozens of files at once, too many to hold in memory together, so
// these land on disk (OS temp dir) and are streamed into the pool one at a
// time (see bulkAddToPool), each temp file removed as soon as it's read.
const bulkUpload = multer({
  storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, os.tmpdir()) }),
  limits: { fileSize: 10 * 1024 * 1024, files: 25 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

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
    // Capped well above any real catalog size so the admin UI's CSV export
    // (which asks for everything, not just a page) can still get the full
    // list in one call by passing a big limit and leaving page unset.
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 10000);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const query = {
      project_code: projectCode,
      $or: [{ pcode_img: null }, { pcode_img: '' }]
    };

    const [missing, total] = await Promise.all([
      ProductMaster.find(query)
        .select('p_code barcode product_name')
        .sort({ p_code: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ProductMaster.countDocuments(query)
    ]);

    res.json({
      success: true,
      count: missing.length,
      total,
      page,
      pages: Math.max(Math.ceil(total / limit), 1),
      data: missing
    });
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

// POST /api/admin/image-cdn/pool/bulk-upload — multipart, field "images"
// (up to 25 files per call — the admin panel chunks a larger batch into
// several of these). Adds straight to the shared pool, tenant-agnostic —
// this is the "restock the pool" action, not tied to whichever project_code
// happens to be selected. Each file must already be named <barcode>_1.<ext>
// (or _2, or bare <barcode>.<ext>) by whoever supplied the photos; nothing
// here copies into any tenant's public folder — run "Sync now" per tenant
// afterwards to pick up newly-added barcodes.
router.post('/pool/bulk-upload', bulkUpload.array('images', 25), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No image files were uploaded' });
    }

    const { saved, skipped } = await bulkAddToPool(req.files);

    res.json({
      success: true,
      message: `Added ${saved.length} image(s) to the pool${skipped.length ? `, ${skipped.length} skipped` : ''}`,
      data: { saved, skipped }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/image-cdn/missing/bulk-upload — multipart, field
// "images" (up to 25 files per call). This is the bulk version of /upload
// above: files are named <p_code>_1.<ext> (or _2, or bare <p_code>.<ext>)
// — THIS tenant's own product codes, not barcodes — and each one closes
// its own missing-list gap immediately (pcode_img/pcode_img_2 updated
// right away, no separate sync needed). Still keys the shared pool by that
// product's real barcode under the hood, so other tenants sharing the same
// barcode benefit too.
router.post('/missing/bulk-upload', bulkUpload.array('images', 25), async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No image files were uploaded' });
    }

    const { saved, skipped } = await bulkUploadForTenant(req.files, projectCode);

    res.json({
      success: true,
      message: `Uploaded ${saved.length} image(s) for ${projectCode}${skipped.length ? `, ${skipped.length} skipped` : ''}`,
      data: { saved, skipped }
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------
// Image Match Suggestions — see the "Image Match Suggestions" architecture
// plan (published as an Artifact, all three sources tested live before any
// of this was built). Platform-wide, not tenant-scoped: one Gemini key
// serves every tenant's suggestion generation, same as the shared pool.

// GET /api/admin/image-cdn/settings — never returns the key itself, only
// whether one is configured (same write-only convention as
// routes/admin/project-settings.js's SECRET_FIELDS).
router.get('/settings', async (req, res, next) => {
  try {
    const settings = await getOrCreateSettings('+gemini_api_key +gemini_api_key_updated_at');
    res.json({
      success: true,
      data: {
        gemini_configured: !!settings.gemini_api_key,
        gemini_updated_at: settings.gemini_api_key_updated_at || null
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/image-cdn/settings — { gemini_api_key }. Empty string
// clears it. Write-only: this response never echoes the value back either.
router.post('/settings', async (req, res, next) => {
  try {
    const { gemini_api_key: geminiApiKey } = req.body;
    if (typeof geminiApiKey !== 'string') {
      return res.status(400).json({ success: false, message: 'gemini_api_key is required (use "" to clear it)' });
    }

    const settings = await getOrCreateSettings();
    settings.gemini_api_key = geminiApiKey.trim();
    settings.gemini_api_key_updated_by = req.user._id;
    settings.gemini_api_key_updated_at = new Date();
    await settings.save();

    res.json({ success: true, message: geminiApiKey.trim() ? 'Gemini API key saved' : 'Gemini API key cleared' });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/image-cdn/suggestions/generate — cross-tenant text
// matching + vision pre-filter. Free (no Gemini key required — vision
// verification is skipped gracefully if none is configured, matching only
// still runs on plain text). Manual-only, same as /sync.
router.post('/suggestions/generate', async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const result = await generateCrossTenantSuggestions(projectCode, {
      deepseekApiKey: process.env.DEEPSEEK_API_KEY || null
    });

    let message = `Generated ${result.created} suggestion(s) for ${projectCode}`;
    if (result.created === 0) {
      // A plain "Generated 0" reads as broken when really it just means
      // nothing NEW turned up — the deterministic matcher already saw
      // every missing product in the last run. Say that explicitly.
      message = result.skipped_existing > 0
        ? `No new matches — ${result.skipped_existing} product(s) already have a suggestion from a previous run`
        : `No matches found among ${result.total_missing} missing product(s)`;
    }

    res.json({ success: true, message, data: result });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/image-cdn/suggestions/web-search — { p_codes } to search
// exactly the products the admin picked from the Missing Images list
// (takes priority), or { limit } to auto-pick the next N missing products
// without hand-picking. Real cost (Gemini search grounding). Only ever
// processes products with no existing web_search suggestion yet — a
// product that came back NONE_FOUND has no doc, so re-selecting it is a
// legitimate retry; one that already found something is skipped either way
// (and shows up in the finished job's results as ALREADY_HAS_SUGGESTION, so
// "10 selected, only 5 actually searched" is visible instead of looking
// like a bug).
//
// Queued, not run inline: each product can take several seconds (a Gemini
// web search, a download, then vision verification), so a batch of even 10
// can exceed a typical reverse-proxy timeout. This responds immediately
// with a job id — poll GET .../web-search/jobs/:id for progress, or GET
// .../web-search/jobs for recent history. Only one job per tenant runs at a
// time; starting a second while one is running is rejected with 409 and
// the running job's id, so the admin panel can just start polling that one.
router.post('/suggestions/web-search', async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const pCodes = Array.isArray(req.body.p_codes)
      ? req.body.p_codes.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim())
      : null;
    const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 0, 1), 1000);

    if ((!pCodes || pCodes.length === 0) && !req.body.limit) {
      return res.status(400).json({ success: false, message: 'Provide either p_codes (selected products) or limit' });
    }

    const job = await startWebSearchJob(projectCode, {
      limit,
      pCodes,
      triggeredByEmail: req.user.email,
      deepseekApiKey: process.env.DEEPSEEK_API_KEY || null
    });

    res.json({
      success: true,
      message: `Search job started for ${job.requested} product(s) — track progress via the job status`,
      data: { job_id: job._id, status: job.status, requested: job.requested }
    });
  } catch (error) {
    if (error.code === 'NO_GEMINI_KEY') {
      return res.status(400).json({ success: false, message: error.message });
    }
    if (error.code === 'JOB_ALREADY_RUNNING') {
      return res.status(409).json({ success: false, message: error.message, data: { job_id: error.jobId } });
    }
    next(error);
  }
});

// GET /api/admin/image-cdn/suggestions/web-search/jobs?limit=10 — recent
// jobs (running or finished), newest first, without the (possibly large)
// per-product results array. Lets the admin panel show progress and detect
// a job already running for this tenant without guessing.
router.get('/suggestions/web-search/jobs', async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    const jobs = await listWebSearchJobs(projectCode, limit);
    res.json({ success: true, count: jobs.length, data: jobs });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/image-cdn/suggestions/web-search/jobs/:id — full detail
// including the per-product results array, for polling one specific job.
router.get('/suggestions/web-search/jobs/:id', async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const job = await getWebSearchJob(projectCode, req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    res.json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/image-cdn/suggestions/stats — counts for the UI's own KPI
// row (pending/accepted/rejected, split by source for pending), separate
// from the plain coverage/missing tiles that describe the catalog itself.
router.get('/suggestions/stats', async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const stats = await getSuggestionStats(projectCode);
    res.json({ success: true, data: stats });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/image-cdn/suggestions?status=pending&page=1&limit=20 — the
// review queue can easily run into the hundreds (cross-tenant matching in
// particular), so this is paginated the same way /missing is: an explicit
// sort plus skip/limit, never relying on natural document order to stay
// stable across pages.
router.get('/suggestions', async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const ImageSuggestion = req.tenant.db.models.ImageSuggestion;
    const status = ['pending', 'accepted', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const query = { project_code: projectCode, status };
    const [suggestions, total] = await Promise.all([
      ImageSuggestion.find(query).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      ImageSuggestion.countDocuments(query)
    ]);

    res.json({
      success: true,
      count: suggestions.length,
      total,
      page,
      pages: Math.max(Math.ceil(total / limit), 1),
      data: suggestions
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/image-cdn/suggestions/:id/preview — streams the
// candidate's actual bytes from the pool. Deliberately NOT a public CDN
// URL: an unreviewed candidate (especially a web_search one, keyed by a
// barcode that's about to become "real" for this tenant) stays behind
// requireImageCdnAccess until an admin accepts it.
router.get('/suggestions/:id/preview', async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const ImageSuggestion = req.tenant.db.models.ImageSuggestion;
    const suggestion = await ImageSuggestion.findOne({ _id: req.params.id, project_code: projectCode });
    if (!suggestion) return res.status(404).json({ success: false, message: 'Suggestion not found' });

    const poolPath = findPoolFile(suggestion.suggested_barcode, suggestion.suffix);
    if (!poolPath) return res.status(404).json({ success: false, message: 'Candidate image is no longer in the pool' });

    res.set('Content-Type', 'image/webp');
    fs.createReadStream(poolPath).pipe(res);
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/image-cdn/suggestions/:id/accept
router.post('/suggestions/:id/accept', async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const ImageSuggestion = req.tenant.db.models.ImageSuggestion;
    const suggestion = await ImageSuggestion.findOne({ _id: req.params.id, project_code: projectCode });
    if (!suggestion) return res.status(404).json({ success: false, message: 'Suggestion not found' });
    if (suggestion.status !== 'pending') {
      return res.status(409).json({ success: false, message: `Already ${suggestion.status}` });
    }

    const url = await acceptSuggestion(suggestion, req.user._id);
    res.json({ success: true, message: `Image set for ${suggestion.p_code}`, data: { url } });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/image-cdn/suggestions/:id/reject — final; regenerating
// suggestions never re-proposes a rejected p_code+source.
router.post('/suggestions/:id/reject', async (req, res, next) => {
  try {
    const { projectCode } = req.tenant;
    const ImageSuggestion = req.tenant.db.models.ImageSuggestion;
    const suggestion = await ImageSuggestion.findOne({ _id: req.params.id, project_code: projectCode });
    if (!suggestion) return res.status(404).json({ success: false, message: 'Suggestion not found' });
    if (suggestion.status !== 'pending') {
      return res.status(409).json({ success: false, message: `Already ${suggestion.status}` });
    }

    await rejectSuggestion(suggestion, req.user._id);
    res.json({ success: true, message: 'Rejected' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
