/**
 * Targeted price/stock refresh for Shree Mega Mart (RET2690) from a NEW,
 * smaller export — Databases/PRODUCT_MASTER_WITH_BALANCE_test.CSV (350
 * rows) — NOT a full-catalog reseed. The live catalog has 2,467 products,
 * 1,717 of which carry a real synced image from the image-match-suggestions
 * pipeline; the onboarding script's usual delete-all-then-reinsert approach
 * would destroy all of that for the ~2,100 products this file doesn't even
 * mention. Confirmed with the user before writing this: update only the
 * p_codes present in the file, touch only the fields it carries
 * (barcode/package_size/package_unit/brand_name/store_code/product_mrp/
 * our_price/store_quantity/pcode_status/product_name), and leave
 * pcode_img/pcode_img_2/dept_id/category_id/sub_category_id and every other
 * product entirely alone.
 *
 * Real motivating example found while building this (not hypothetical):
 * p_code 83 "7 OILS IN ONE 200 ML" was live with our_price 975 / MRP 2650 /
 * package "5 LT" / brand "SATTHWA" — the exact same bogus price/package/
 * brand combination onboard_shree_mega_mart.js's own header comment already
 * documented as contaminated data from the original import ("a STUDY TABLE
 * 3D PRINTED branded SATTHWA, priced 975, packaged 5LT, identical to 15
 * other unrelated rows"). The new file has this same p_code at our_price
 * 112.8 / MRP 120 / package "200ML" / brand "EMAMI" — consistent with what
 * the product's own name says. This script is a real data-quality fix, not
 * just a routine refresh.
 *
 * A p_code in the file with no existing ProductMaster row is reported and
 * skipped — inserting it would need a department/category/subcategory,
 * which this file doesn't carry (only the category-master CSV does, and
 * this run is deliberately not touching that file). Checked live: only 2 of
 * 350 fall in this bucket (9677, 9691 — "CLIP TIFFINE 8X2/8X3"), and neither
 * has a category-master row either, so they're excluded the same way the
 * original onboarding script already excludes uncategorized pcodes.
 *
 *   node scripts/update_shree_mega_mart_pricing.js                  # dry run
 *   node scripts/update_shree_mega_mart_pricing.js --apply
 *   node scripts/update_shree_mega_mart_pricing.js --apply --file /path
 */

require('dotenv').config();
const fs = require('fs');

const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { getProjectModel } = require('../models/Project');
require('../models/ProductMaster');

const PROJECT_CODE = 'RET2690';
const DEFAULT_CSV = '/Users/gauravpawar/Downloads/Universal_Setup/Databases/PRODUCT_MASTER_WITH_BALANCE_test.CSV';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const apply = process.argv.includes('--apply');

// RFC4180-ish parser — same as onboard_shree_mega_mart.js, since this
// export could in principle carry a quoted comma the same way that one did.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

const PACKAGE_RE = /^([0-9.]+)\s*([A-Za-z]+)$/;

function loadRows(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = rows[0].map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return rows
    .slice(1)
    .filter((r) => r.length > 1 && r[idx.P_CODE] && r[idx.P_CODE].trim())
    .map((r) => ({
      pcode: r[idx.P_CODE].trim(),
      barcode: (r[idx.BARCODE] || '').trim(),
      productName: (r[idx.product_name] || '').trim(),
      packageSize: (r[idx.package_size] || '').trim(),
      brandName: (r[idx.BRAND_NAME] || '').trim(),
      storeCode: (r[idx.BR_CODE] || '').trim(),
      ourPrice: (r[idx.our_price] || '').trim(),
      productMrp: (r[idx.product_mrp] || '').trim(),
      quantity: (r[idx.quantity] || '').trim(),
      status: (r[idx.store_code_status] || '').trim(),
    }));
}

async function run() {
  const csvPath = arg('file') || DEFAULT_CSV;

  console.log(apply ? '🚚 Updating Shree Mega Mart (RET2690) pricing/stock — applying\n' : '🔍 Updating Shree Mega Mart (RET2690) pricing/stock — dry run (pass --apply to write)\n');
  console.log(`Source: ${csvPath}\n`);

  const rows = loadRows(csvPath);
  console.log(`📄 Parsed ${rows.length} row(s)`);

  await connectDB();

  const project = await getProjectModel().findOne({ project_code: PROJECT_CODE }).lean();
  if (!project) {
    console.error(`\n❌ No project registered for ${PROJECT_CODE}.`);
    await disconnectDB();
    process.exit(1);
  }
  console.log(`✔ Project ${PROJECT_CODE} → ${project.db_name} (${project.client_name})`);

  const db = getTenantDb(project.db_name);
  const ProductMaster = db.models.ProductMaster;

  const pcodes = rows.map((r) => r.pcode);
  const existing = await ProductMaster.find({ project_code: PROJECT_CODE, p_code: { $in: pcodes } })
    .select('p_code product_name our_price product_mrp package_size package_unit brand_name pcode_img')
    .lean();
  const existingByPcode = new Map(existing.map((p) => [p.p_code, p]));

  const toUpdate = [];
  const skippedNoProduct = [];
  const skippedBadPackage = [];

  for (const row of rows) {
    const current = existingByPcode.get(row.pcode);
    if (!current) { skippedNoProduct.push(row.pcode); continue; }

    const m = PACKAGE_RE.exec(row.packageSize);
    if (!m) { skippedBadPackage.push({ pcode: row.pcode, packageSize: row.packageSize }); continue; }

    toUpdate.push({
      pcode: row.pcode,
      set: {
        barcode: row.barcode || undefined,
        product_name: row.productName,
        package_size: parseFloat(m[1]),
        package_unit: m[2].toUpperCase(),
        brand_name: row.brandName || undefined,
        store_code: row.storeCode || current.store_code,
        product_mrp: row.productMrp,
        our_price: row.ourPrice,
        store_quantity: Number(row.quantity) || 0,
        pcode_status: row.status === 'N' ? 'N' : 'Y',
      },
      before: current,
    });
  }

  console.log(`\n📊 Resolved:`);
  console.log(`   ${toUpdate.length} product(s) to update (existing rows matched by p_code — dept/category/images untouched)`);
  if (skippedNoProduct.length) {
    console.log(`   ⚠️  ${skippedNoProduct.length} pcode(s) skipped — no existing product for this tenant, and this file carries no department/category to insert one under: ${skippedNoProduct.join(', ')}`);
  }
  if (skippedBadPackage.length) {
    console.log(`   ⚠️  ${skippedBadPackage.length} pcode(s) skipped — unparseable package_size: ${JSON.stringify(skippedBadPackage)}`);
  }

  // A quick, honest look at the size of the real changes — not just a count.
  const priceChanges = toUpdate.filter((u) => {
    const before = parseFloat(u.before.our_price?.toString() || '0');
    const after = parseFloat(u.set.our_price);
    return Math.abs(before - after) > 0.01;
  });
  console.log(`   ${priceChanges.length} of those have an actual price change`);
  console.log('\n   Sample of the largest price changes:');
  priceChanges
    .map((u) => ({ ...u, delta: Math.abs(parseFloat(u.before.our_price.toString()) - parseFloat(u.set.our_price)) }))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 5)
    .forEach((u) => {
      console.log(`     ${u.pcode} ${u.before.product_name} — ₹${u.before.our_price} → ₹${u.set.our_price} (${u.before.package_size}${u.before.package_unit} → ${u.set.package_size}${u.set.package_unit}, ${u.before.brand_name} → ${u.set.brand_name})`);
    });

  if (!apply) {
    console.log('\nDry run only — no writes. Re-run with --apply to write these updates.');
    await disconnectDB();
    return;
  }

  let updated = 0;
  for (const u of toUpdate) {
    await ProductMaster.updateOne(
      { project_code: PROJECT_CODE, p_code: u.pcode },
      { $set: u.set }
    );
    updated++;
  }

  console.log(`\n✅ Updated ${updated} product(s) in ${project.db_name}. pcode_img and category placement were not touched.`);

  await disconnectDB();
}

run().catch((err) => {
  console.error('❌ Update failed:', err);
  process.exit(1);
});
