/**
 * Marks every Shree Mega Mart (RET2690) product NOT confirmed correct by
 * PRODUCT_MASTER_WITH_BALANCE_test.CSV as inactive (pcode_status: 'N') —
 * see scripts/update_shree_mega_mart_pricing.js for why this is needed:
 * that 350-row export corrected 348 products carrying a bogus placeholder
 * price/package/brand (our_price 975 / MRP 2650 / "5 LT" / SATTHWA), and a
 * live check afterward found 1,824 MORE products still carrying that exact
 * same signature. Rather than let customers see/buy products at a
 * fabricated price, this hides everything except the 348 just verified,
 * until a fuller corrected export arrives.
 *
 * pcode_status: 'N' is read by every customer-facing listing route
 * (routes/products.js, best-sellers.js, top-sellers.js, advertisements.js
 * all filter on pcode_status: 'Y') — it does not delete anything and is
 * trivially reversible (re-run with --reactivate, or flip back once a
 * corrected export lands and update_shree_mega_mart_pricing.js is re-run
 * for the newly-verified set).
 *
 *   node scripts/deactivate_shree_mega_mart_unverified.js                # dry run
 *   node scripts/deactivate_shree_mega_mart_unverified.js --apply
 *   node scripts/deactivate_shree_mega_mart_unverified.js --apply --file /path
 *   node scripts/deactivate_shree_mega_mart_unverified.js --reactivate --apply   # undo
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
const reactivate = process.argv.includes('--reactivate');

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

function loadVerifiedPcodes(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = rows[0].map((h) => h.trim());
  const idx = header.indexOf('P_CODE');
  return new Set(
    rows.slice(1).map((r) => (r[idx] || '').trim()).filter(Boolean)
  );
}

async function run() {
  const csvPath = arg('file') || DEFAULT_CSV;
  const verifiedPcodes = loadVerifiedPcodes(csvPath);

  console.log(
    reactivate
      ? (apply ? '🚚 Reactivating Shree Mega Mart (RET2690) products — applying\n' : '🔍 Reactivating — dry run (pass --apply to write)\n')
      : (apply ? '🚚 Deactivating unverified Shree Mega Mart (RET2690) products — applying\n' : '🔍 Deactivating unverified products — dry run (pass --apply to write)\n')
  );
  console.log(`Verified set: ${csvPath} (${verifiedPcodes.size} p_code(s))\n`);

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

  if (reactivate) {
    // Undo: every product this script previously touched, back to active.
    // Scoped the same way the deactivation was — everything OUTSIDE the
    // verified set — so re-running the pricing script for a bigger export
    // first, then this with an updated --file, only reactivates what's now
    // actually verified.
    const query = { project_code: PROJECT_CODE, p_code: { $nin: [...verifiedPcodes] }, pcode_status: 'N' };
    const count = await ProductMaster.countDocuments(query);
    console.log(`\n📊 ${count} product(s) currently inactive outside the verified set would be reactivated`);
    if (!apply) {
      console.log('\nDry run only — no writes. Re-run with --apply to write.');
      await disconnectDB();
      return;
    }
    const result = await ProductMaster.updateMany(query, { $set: { pcode_status: 'Y' } });
    console.log(`\n✅ Reactivated ${result.modifiedCount} product(s).`);
    await disconnectDB();
    return;
  }

  const query = { project_code: PROJECT_CODE, p_code: { $nin: [...verifiedPcodes] } };
  const [totalOutsideVerified, alreadyInactive, currentlyActive, totalCatalog] = await Promise.all([
    ProductMaster.countDocuments(query),
    ProductMaster.countDocuments({ ...query, pcode_status: 'N' }),
    ProductMaster.countDocuments({ ...query, pcode_status: 'Y' }),
    ProductMaster.countDocuments({ project_code: PROJECT_CODE }),
  ]);

  console.log(`\n📊 Resolved:`);
  console.log(`   ${totalCatalog} product(s) total for ${PROJECT_CODE}`);
  console.log(`   ${totalOutsideVerified} product(s) outside the verified set (${currentlyActive} currently active, would be set to 'N'; ${alreadyInactive} already inactive)`);

  if (!apply) {
    console.log('\nDry run only — no writes. Re-run with --apply to write.');
    await disconnectDB();
    return;
  }

  const result = await ProductMaster.updateMany(
    { ...query, pcode_status: 'Y' },
    { $set: { pcode_status: 'N' } }
  );

  console.log(`\n✅ Deactivated ${result.modifiedCount} product(s). The ${verifiedPcodes.size} verified p_codes were not touched.`);

  await disconnectDB();
}

run().catch((err) => {
  console.error('❌ Failed:', err);
  process.exit(1);
});
