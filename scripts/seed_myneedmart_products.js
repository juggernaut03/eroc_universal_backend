/**
 * Fresh reseed of My Need Mart's (RET6978) ProductMaster from the client's
 * two new CSV exports:
 *
 *   My_need _mart_Products_Master_1009.csv
 *     - one row per product: pcode, product_name, department_name,
 *       category_name, sub_category_name (always "All" in this export).
 *
 *   My_need_mart_PRODUCT_RATE_MASTER_1009.csv
 *     - one row per product: P_CODE, BARCODE (== pcode for this tenant,
 *       not a real barcode), package_size, BRAND_NAME, BR_CODE (store
 *       code), our_price, product_mrp, quantity, store_code_status.
 *       Joined to the file above by pcode.
 *
 * Fixes a real bug found in the live data before writing this: every one
 * of the 172 existing products was duplicated (86 real products × 2), and
 * roughly half of those rows pointed at dept_id/category_id values that
 * don't exist in this tenant's Department/Category collections at all
 * (e.g. dept "3", category "4" — orphaned references, likely left over
 * from an earlier broken import). This script deletes ALL of this
 * tenant's ProductMaster rows and reinserts exactly one fresh row per
 * pcode in the new export, with dept_id/category_id/sub_category_id
 * resolved correctly.
 *
 * Department and Category are NOT touched — their names in the new export
 * (Vegetable/Fruit, Whole Vegetables/Cut Vegetables/Whole Fruits/Mango
 * Special) match the tenant's existing records exactly, and those records
 * carry real curated image_link/category_bg_color set by hand in the
 * admin panel that a wipe-and-recreate would destroy. A department or
 * category name that DOESN'T already exist gets created fresh (extending,
 * never replacing). Subcategory: every product's sub_category_name in
 * this export is "All", which doesn't exist yet as a subcategory under
 * any of these categories (the existing ones are named after their own
 * category, e.g. "Whole Vegetables" under "Whole Vegetables") — one new
 * "All" subcategory is created per category the first time it's needed,
 * reused after that.
 *
 * Product images: the user explicitly chose to carry forward existing
 * pcode_img/pcode_img_2 (matched by p_code) rather than clear them —
 * unlike Shree Mega Mart's onboarding, these are REAL working images
 * already live on the storefront (confirmed live: retailmagic.in/cdn/
 * RET6978/101_1.webp really serves a photo), not a guessed/fabricated
 * formula, so preserving them is a data migration, not a policy
 * violation of "never guess pcode_img." A pcode with no prior image (a
 * genuinely new product) is left null, same as any other tenant's
 * missing-images workflow.
 *
 * Idempotent: safe to re-run after a corrected export — it always starts
 * from this tenant's current ProductMaster + whatever image URLs are on
 * it at the time.
 *
 *   node scripts/seed_myneedmart_products.js                  # dry run
 *   node scripts/seed_myneedmart_products.js --apply
 *   node scripts/seed_myneedmart_products.js --apply --prod-file /path --rate-file /path
 */

require('dotenv').config();
const fs = require('fs');

const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { getProjectModel } = require('../models/Project');
require('../models/Department');
require('../models/Category');
require('../models/Subcategory');
require('../models/ProductMaster');

const PROJECT_CODE = 'RET6978';

const DEFAULT_PROD_CSV =
  '/Users/gauravpawar/Downloads/Universal_Setup/MyNeedMart/My_need _mart_Products_Master_1009.csv';
const DEFAULT_RATE_CSV =
  '/Users/gauravpawar/Downloads/Universal_Setup/MyNeedMart/My_need_mart_PRODUCT_RATE_MASTER_1009.csv';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const apply = process.argv.includes('--apply');

// Minimal CSV parser — fine here, neither export has a quoted/escaped
// comma in any field (verified by inspection).
function parseCsv(text) {
  return text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(',').map((c) => c.trim()));
}

function loadProductsMaster(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = rows[0].map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return rows
    .slice(1)
    .filter((r) => r[idx.pcode])
    .map((r) => ({
      pcode: r[idx.pcode],
      productName: r[idx.product_name],
      description: r[idx.product_description] || '',
      deptName: r[idx.department_name],
      catName: r[idx.category_name],
      subName: r[idx.sub_category_name] || 'All',
    }));
}

function loadRateMaster(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  // Header row has a lot of trailing empty columns from stray commas in the
  // source — trim them off rather than let them shift indexes.
  const header = rows[0].map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return rows
    .slice(1)
    .filter((r) => r[idx.P_CODE])
    .map((r) => ({
      pcode: r[idx.P_CODE],
      barcode: r[idx.BARCODE] || '',
      packageSize: r[idx.package_size] || '',
      brandName: r[idx.BRAND_NAME] || '',
      storeCode: r[idx.BR_CODE] || '',
      ourPrice: r[idx.our_price] || '',
      productMrp: r[idx.product_mrp] || '',
      quantity: r[idx.quantity] || '',
      status: r[idx.store_code_status] || '',
    }));
}

const PACKAGE_RE = /^([0-9.]+)\s*([A-Za-z]+)$/;
const norm = (s) => s.trim().toUpperCase();

async function run() {
  const prodPath = arg('prod-file') || DEFAULT_PROD_CSV;
  const ratePath = arg('rate-file') || DEFAULT_RATE_CSV;

  console.log(apply ? '🚚 Reseeding My Need Mart (RET6978) products — applying\n' : '🔍 Reseeding My Need Mart (RET6978) products — dry run (pass --apply to write)\n');
  console.log(`Products master: ${prodPath}`);
  console.log(`Rate master: ${ratePath}\n`);

  const prodRows = loadProductsMaster(prodPath);
  const rateRows = loadRateMaster(ratePath);
  const rateByPcode = new Map(rateRows.map((r) => [r.pcode, r]));

  console.log(`📄 Parsed ${prodRows.length} product row(s), ${rateRows.length} rate row(s)`);

  const noRate = prodRows.filter((p) => !rateByPcode.has(p.pcode));
  const prodPcodes = new Set(prodRows.map((p) => p.pcode));
  const rateOnly = rateRows.filter((r) => !prodPcodes.has(r.pcode));
  if (noRate.length) console.log(`   ⚠️  ${noRate.length} pcode(s) with no matching rate row, excluded: ${noRate.map((p) => p.pcode).join(', ')}`);
  if (rateOnly.length) console.log(`   ⚠️  ${rateOnly.length} pcode(s) in the rate file have no product-master row, excluded: ${rateOnly.map((r) => r.pcode).join(', ')}`);

  await connectDB();

  const project = await getProjectModel().findOne({ project_code: PROJECT_CODE }).lean();
  if (!project) {
    console.error(`\n❌ No project registered for ${PROJECT_CODE}.`);
    await disconnectDB();
    process.exit(1);
  }
  console.log(`\n✔ Project ${PROJECT_CODE} → ${project.db_name} (${project.client_name})`);

  const db = getTenantDb(project.db_name);
  const Department = db.models.Department;
  const Category = db.models.Category;
  const Subcategory = db.models.Subcategory;
  const ProductMaster = db.models.ProductMaster;

  const [existingDepts, existingCats, existingSubs, existingProds] = await Promise.all([
    Department.find({ project_code: PROJECT_CODE }).lean(),
    Category.find({ project_code: PROJECT_CODE }).lean(),
    Subcategory.find({ project_code: PROJECT_CODE }).lean(),
    ProductMaster.find({ project_code: PROJECT_CODE }).select('p_code pcode_img pcode_img_2').lean(),
  ]);

  // Carry forward existing images — see the file header comment for why
  // this is a preservation, not a guess. Duplicated pcodes in the current
  // (buggy) data all share the same image, so "first one wins" is safe.
  const oldImageByPcode = new Map();
  for (const p of existingProds) {
    if (!oldImageByPcode.has(p.p_code)) {
      oldImageByPcode.set(p.p_code, { pcode_img: p.pcode_img || null, pcode_img_2: p.pcode_img_2 || null });
    }
  }

  const deptByName = new Map(existingDepts.map((d) => [norm(d.department_name), d]));
  const catByName = new Map(existingCats.map((c) => [norm(c.category_name), c]));
  // Reused across products: one "All" subcategory per category_id, created
  // on first use below if it doesn't already exist.
  const subByKey = new Map(existingSubs.map((s) => [`${s.category_id}||${norm(s.sub_category_name)}`, s]));

  let nextDeptId = Math.max(0, ...existingDepts.map((d) => Number(d.department_id) || 0)) + 1;
  let nextCatId = Math.max(0, ...existingCats.map((c) => Number(c.idcategory_master) || 0)) + 1;
  let nextSubId = Math.max(0, ...existingSubs.map((s) => Number(s.idsub_category_master) || 0)) + 1;

  const newDepts = [];
  const newCats = [];
  const newSubs = [];
  const products = [];
  const excludedBadPackage = [];
  let carriedImageCount = 0;

  for (const p of prodRows) {
    const rate = rateByPcode.get(p.pcode);
    if (!rate) continue;

    const dn = norm(p.deptName);
    let dept = deptByName.get(dn);
    if (!dept) {
      dept = { department_id: String(nextDeptId++), department_name: p.deptName.trim() };
      deptByName.set(dn, dept);
      newDepts.push(dept);
    }

    const cn = norm(p.catName);
    let cat = catByName.get(cn);
    if (!cat) {
      cat = { idcategory_master: String(nextCatId++), category_name: p.catName.trim(), dept_id: dept.department_id };
      catByName.set(cn, cat);
      newCats.push(cat);
    }

    const subKey = `${cat.idcategory_master}||${norm(p.subName)}`;
    let sub = subByKey.get(subKey);
    if (!sub) {
      sub = {
        idsub_category_master: String(nextSubId++),
        sub_category_name: p.subName.trim(),
        category_id: cat.idcategory_master,
        main_category_name: cat.category_name,
      };
      subByKey.set(subKey, sub);
      newSubs.push(sub);
    }

    const m = PACKAGE_RE.exec(rate.packageSize);
    if (!m) {
      excludedBadPackage.push({ pcode: p.pcode, packageSize: rate.packageSize });
      continue;
    }

    const oldImage = oldImageByPcode.get(p.pcode);
    if (oldImage?.pcode_img) carriedImageCount++;

    products.push({
      p_code: p.pcode,
      barcode: rate.barcode || undefined,
      product_name: p.productName,
      product_description: p.description,
      package_size: parseFloat(m[1]),
      package_unit: m[2],
      product_mrp: rate.productMrp,
      our_price: rate.ourPrice,
      brand_name: rate.brandName || undefined,
      store_code: rate.storeCode,
      pcode_status: rate.status === 'N' ? 'N' : 'Y',
      dept_id: dept.department_id,
      category_id: cat.idcategory_master,
      sub_category_id: sub.idsub_category_master,
      store_quantity: Number(rate.quantity) || 0,
      pcode_img: oldImage?.pcode_img || undefined,
      pcode_img_2: oldImage?.pcode_img_2 || undefined,
      project_code: PROJECT_CODE,
    });
  }

  console.log(`\n📊 Resolved:`);
  console.log(`   ${newDepts.length} new department(s)${newDepts.length ? ': ' + newDepts.map((d) => d.department_name).join(', ') : ''} (${deptByName.size} total)`);
  console.log(`   ${newCats.length} new categor(y/ies)${newCats.length ? ': ' + newCats.map((c) => c.category_name).join(', ') : ''} (${catByName.size} total)`);
  console.log(`   ${newSubs.length} new subcategor(y/ies): ${newSubs.map((s) => `${s.sub_category_name} (under ${s.main_category_name})`).join(', ')}`);
  console.log(`   ${products.length} product(s) ready to import — ${carriedImageCount} carrying forward an existing image, ${products.length - carriedImageCount} with none (new or previously missing)`);
  if (excludedBadPackage.length) {
    console.log(`   ⚠️  ${excludedBadPackage.length} pcode(s) skipped — unparseable package_size: ${JSON.stringify(excludedBadPackage)}`);
  }

  console.log(`\n🗑  Existing rows for ${PROJECT_CODE} that would be replaced: ${existingProds.length} product(s) (Department/Category are extended, not replaced)`);

  if (!apply) {
    console.log('\nDry run only — no writes. Re-run with --apply to write these records.');
    await disconnectDB();
    return;
  }

  if (newDepts.length) await Department.insertMany(newDepts.map((d, i) => ({
    ...d,
    dept_type_id: '1',
    dept_no_of_col: 1,
    store_code: null,
    sequence_id: existingDepts.length + i + 1,
    project_code: PROJECT_CODE,
  })), { ordered: true });

  if (newCats.length) await Category.insertMany(newCats.map((c, i) => ({
    ...c,
    sequence_id: existingCats.length + i + 1,
    store_code: products.find((p) => p.category_id === c.idcategory_master)?.store_code || null,
    no_of_col: '3',
    project_code: PROJECT_CODE,
  })), { ordered: true });

  if (newSubs.length) await Subcategory.insertMany(newSubs.map((s) => ({ ...s, project_code: PROJECT_CODE })), { ordered: true });

  await ProductMaster.deleteMany({ project_code: PROJECT_CODE });
  const inserted = await ProductMaster.insertMany(products, { ordered: false });

  console.log(`\n✅ Inserted ${newDepts.length} department(s), ${newCats.length} categor(y/ies), ${newSubs.length} subcategor(y/ies), ${inserted.length} product(s) into ${project.db_name}.`);

  await disconnectDB();
}

run().catch((err) => {
  console.error('❌ Reseed failed:', err);
  process.exit(1);
});
