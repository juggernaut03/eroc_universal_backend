const fs = require('fs');
const path = require('path');

let sharp;
try {
  // eslint-disable-next-line global-require
  sharp = require('sharp');
} catch {
  sharp = null;
}

const { POOL_ROOT, CDN_STORE_ROOT, CDN_BASE_URL } = require('../config/imageCdn');
const { getProjectModel } = require('../models/Project');
const { getTenantDb } = require('../config/database');
require('../models/ProductMaster');
require('../models/ImageSyncRun');

const ensureDir = (dirPath) => fs.promises.mkdir(dirPath, { recursive: true });

const buildImageUrl = (projectCode, pcode, suffix) =>
  `${CDN_BASE_URL}/${projectCode}/${pcode}_${suffix}.webp`;

// Resolves a barcode + image slot (1 or 2) to a real file in the pool, or
// null. Slot 1 also accepts a bare `<barcode>.webp` with no suffix — a real,
// if messy, shape a few dozen files in the pool actually use (see the
// architecture plan's data-quality notes); slot 2 has no such fallback,
// there's no ambiguous "which image is this" case for a second image.
const findPoolFile = (barcode, suffix) => {
  if (!barcode) return null;
  const primary = path.join(POOL_ROOT, `${barcode}_${suffix}.webp`);
  if (fs.existsSync(primary)) return primary;
  if (suffix === 1) {
    const bare = path.join(POOL_ROOT, `${barcode}.webp`);
    if (fs.existsSync(bare)) return bare;
  }
  return null;
};

// Runs a full sync for one tenant: reads {p_code, barcode} straight from
// ProductMaster (the CSV is never re-read here — the database is the source
// of truth once a catalog is imported), looks each barcode up in the pool,
// and copies matches into that tenant's public folder as
// <p_code>_1.webp / <p_code>_2.webp. Manual-only by design — nothing calls
// this automatically; it's invoked from the admin "sync now" action.
async function syncProject(projectCode, { triggeredBy, triggeredByEmail } = {}) {
  const startedAt = Date.now();
  const Project = getProjectModel();
  const project = await Project.findOne({ project_code: projectCode }).lean();
  if (!project) {
    throw new Error(`Unknown project_code: ${projectCode}`);
  }

  const db = getTenantDb(project.db_name);
  const ProductMaster = db.models.ProductMaster;
  const ImageSyncRun = db.models.ImageSyncRun;

  const products = await ProductMaster.find({ project_code: projectCode })
    .select('p_code barcode product_name pcode_img pcode_img_2')
    .lean();

  const tenantDir = path.join(CDN_STORE_ROOT, projectCode);
  await ensureDir(tenantDir);

  let matchedPrimary = 0;
  let matchedSecondary = 0;
  const missing = [];
  const bulkOps = [];

  for (const product of products) {
    const { p_code: pcode, barcode } = product;
    const update = {};

    const primarySrc = findPoolFile(barcode, 1);
    if (primarySrc) {
      const dest = path.join(tenantDir, `${pcode}_1.webp`);
      await fs.promises.copyFile(primarySrc, dest);
      update.pcode_img = buildImageUrl(projectCode, pcode, 1);
      matchedPrimary += 1;
    }

    const secondarySrc = findPoolFile(barcode, 2);
    if (secondarySrc) {
      const dest = path.join(tenantDir, `${pcode}_2.webp`);
      await fs.promises.copyFile(secondarySrc, dest);
      update.pcode_img_2 = buildImageUrl(projectCode, pcode, 2);
      matchedSecondary += 1;
    }

    if (!primarySrc) {
      missing.push({ p_code: pcode, barcode, product_name: product.product_name });
    }

    if (Object.keys(update).length > 0) {
      bulkOps.push({
        updateOne: { filter: { _id: product._id }, update: { $set: update } }
      });
    }
  }

  if (bulkOps.length > 0) {
    await ProductMaster.bulkWrite(bulkOps, { ordered: false });
  }

  const run = await ImageSyncRun.create({
    project_code: projectCode,
    triggered_by: triggeredBy,
    triggered_by_email: triggeredByEmail,
    total_products: products.length,
    matched_primary: matchedPrimary,
    matched_secondary: matchedSecondary,
    missing_count: missing.length,
    missing_sample: missing.slice(0, 200),
    duration_ms: Date.now() - startedAt
  });

  return {
    project_code: projectCode,
    total_products: products.length,
    matched_primary: matchedPrimary,
    matched_secondary: matchedSecondary,
    missing_count: missing.length,
    missing_sample: missing.slice(0, 200),
    run_id: run._id,
    duration_ms: run.duration_ms
  };
}

// Only safe pool filename characters — a barcode becomes part of a real
// path.join() below, so this also doubles as the path-traversal guard (no
// "/", no "..", nothing that isn't a plain barcode-shaped token).
const SAFE_BARCODE_RE = /^[A-Za-z0-9_.-]+$/;

// Converts one input (a Buffer, or a path to an already-written temp file —
// sharp accepts either) to webp and writes it into the pool as
// <barcode>_<suffix>.webp. Shared by the single-image admin upload and the
// bulk pool-upload path below, so both go through the same conversion.
async function writeWebpToPool(barcode, suffix, input) {
  await ensureDir(POOL_ROOT);
  const poolPath = path.join(POOL_ROOT, `${barcode}_${suffix}.webp`);

  if (sharp) {
    await sharp(input, { failOn: 'none' })
      .rotate()
      .resize({ width: 1600, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(poolPath);
  } else {
    // Without sharp installed, write/copy the raw bytes under a .webp name —
    // degrades gracefully rather than blocking the upload entirely.
    if (typeof input === 'string') {
      await fs.promises.copyFile(input, poolPath);
    } else {
      await fs.promises.writeFile(poolPath, input);
    }
  }

  return poolPath;
}

// Converts an uploaded buffer to webp and writes it into the pool as
// <barcode>_<suffix>.webp, then immediately copies it into the one tenant
// folder the admin is working in — this is the single-image manual backfill
// path (§07 of the plan: missing images are closed by hand, not blocked on).
async function uploadPoolImage({ barcode, suffix, buffer, projectCode, pcode }) {
  if (!barcode) throw new Error('barcode is required');
  if (![1, 2].includes(suffix)) throw new Error('suffix must be 1 or 2');

  const poolPath = await writeWebpToPool(barcode, suffix, buffer);

  let publicUrl = null;
  if (projectCode && pcode) {
    const tenantDir = path.join(CDN_STORE_ROOT, projectCode);
    await ensureDir(tenantDir);
    const dest = path.join(tenantDir, `${pcode}_${suffix}.webp`);
    await fs.promises.copyFile(poolPath, dest);
    publicUrl = buildImageUrl(projectCode, pcode, suffix);

    const db = getTenantDb((await getProjectModel().findOne({ project_code: projectCode }).lean()).db_name);
    const ProductMaster = db.models.ProductMaster;
    const field = suffix === 1 ? 'pcode_img' : 'pcode_img_2';
    await ProductMaster.updateOne({ project_code: projectCode, p_code: pcode }, { $set: { [field]: publicUrl } });
  }

  return { pool_path: poolPath, url: publicUrl };
}

// A pool filename is <barcode>_1 / <barcode>_2 / bare <barcode> (mirrors the
// three shapes findPoolFile() already reads — see its comment). Bulk-uploaded
// files are expected to already be named this way by whoever's handling the
// photography (the same convention as the seeded pool), so this just reads
// the barcode/suffix back out of the name the admin gave the file, rather
// than asking them to enter it by hand for every file in a batch.
function parsePoolFilename(originalname) {
  const stem = originalname.replace(/\.[^./\\]+$/, '').trim();
  const suffixMatch = /^(.+)_([12])$/.exec(stem);
  const barcode = suffixMatch ? suffixMatch[1] : stem;
  const suffix = suffixMatch ? Number(suffixMatch[2]) : 1;

  if (!barcode || !SAFE_BARCODE_RE.test(barcode)) {
    return null;
  }
  return { barcode, suffix };
}

// Bulk pool add: many files in one call, each named <barcode>_1.<ext> (or
// _2, or bare <barcode>.<ext>) by whoever supplied them. Adds to the shared
// pool only — it does NOT copy into any tenant's public folder, since the
// pool is tenant-agnostic; run "Sync now" per tenant afterwards to pick up
// whatever these newly-added barcodes match. `files` is multer's disk-stored
// file list ({ path, originalname }); each temp file is removed once
// processed, matched or not.
async function bulkAddToPool(files) {
  const saved = [];
  const skipped = [];

  for (const file of files) {
    const parsed = parsePoolFilename(file.originalname);
    try {
      if (!parsed) {
        skipped.push({ filename: file.originalname, reason: 'Could not read a barcode from this filename' });
        continue;
      }
      await writeWebpToPool(parsed.barcode, parsed.suffix, file.path);
      saved.push({ filename: file.originalname, barcode: parsed.barcode, suffix: parsed.suffix });
    } catch (err) {
      skipped.push({ filename: file.originalname, reason: err.message });
    } finally {
      await fs.promises.unlink(file.path).catch(() => {});
    }
  }

  return { saved, skipped };
}

module.exports = {
  syncProject,
  uploadPoolImage,
  bulkAddToPool,
  parsePoolFilename,
  findPoolFile,
  buildImageUrl
};
