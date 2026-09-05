/**
 * Onboarding script: builds the catalog (departments, categories,
 * subcategories, products) for a brand-new tenant — Shree Mega Mart
 * (RET2690) — from the two CSV exports the client sent:
 *
 *   Shree_Mega_mart_product_category_master_1CDN_final.csv
 *     - one row per product, carrying its department/category/subcategory.
 *       The header is misleading: the file's actual columns, positionally,
 *       are (id_product, pcode, <barcode in scientific notation, unused —
 *       the product master CSV has the real one>, <real product_name>,
 *       <junk free-text column, discarded — cross-checking a sample against
 *       the product master shows it doesn't reliably describe the product>,
 *       <department>, <category>, <subcategory>). The header labels these
 *       last three "department_name"/"category_name"/"sub_category_name"
 *       one column too early — verified against the data itself: the column
 *       the header calls "category_name" has only 14 raw values (a
 *       department-sized set), and the column the header calls
 *       "department_name" has 817 (clearly not a department).
 *
 *   Shree_Mega_mart_PRODUCT_MASTER_WITH_BALANCE.CSV
 *     - one row per product with pricing/stock/barcode/package size. Its
 *       header is accurate. Joined to the file above by pcode.
 *
 * Department/category/subcategory names are case-normalized for grouping
 * (the client's own export has case-duplicates, e.g. "Beverages" and
 * "BEVERAGES" as literally different strings for the same department) and
 * displayed in Title Case. A category or subcategory name that legitimately
 * appears under more than one parent in the source data (e.g. "Dairy
 * Products" under both the Beverages and Bakery/Dairy/Frozen departments)
 * becomes two separate records, one per parent — this schema has never
 * required category/subcategory names to be globally unique, only scoped
 * under their parent (see models/Category.js, models/Subcategory.js), so
 * that's a faithful, lossless mapping of what the client actually sent, not
 * a data-loss shortcut.
 *
 * 25 pcodes exist in the product-master file but not in the category-master
 * file (no department/category/subcategory to place them under) — these are
 * also, independently, the file's only rows with nonsense product/brand/price
 * combinations (e.g. a "STUDY TABLE 3D PRINTED" branded "SATTHWA", priced
 * 975, packaged "5LT", identical to 15 other unrelated rows). They're
 * excluded rather than dumped into a synthetic "Uncategorized" bucket.
 *
 * Idempotent: re-running deletes this tenant's existing rows in the four
 * collections first, then reinserts fresh ones from the CSVs — safe to run
 * again after the client sends a corrected export.
 *
 * Reads are the default. Nothing is written without --apply:
 *   node scripts/onboard_shree_mega_mart.js                # dry run
 *   node scripts/onboard_shree_mega_mart.js --apply
 *   node scripts/onboard_shree_mega_mart.js --apply --cat-file /path --prod-file /path
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { getProjectModel } = require('../models/Project');
require('../models/Department');
require('../models/Category');
require('../models/Subcategory');
require('../models/ProductMaster');

const PROJECT_CODE = 'RET2690';
// store_code is no longer hardcoded here — it comes from the product
// master CSV's own BR_CODE column (the client's real branch code), one per
// product row. History: this was hardcoded first as 'SMM001' (this
// session's own guess), then 'SMM' (to match a Store record the admin had
// already created by hand), and finally replaced 2026-09-05 with BR_CODE
// once the client confirmed BR_CODE *is* the store/branch code — for this
// export every row's BR_CODE is 'BHANPURI', a single-store CSV, so this
// still resolves to one store_code, just sourced from the data instead of
// invented. If a future export ever carries more than one distinct BR_CODE,
// this script will need each Category to point at one store_code the same
// way products already do (Category.store_code is currently one value per
// category, not per product — see the categories.set(...) block below).
// Keep whatever store_code(s) resolve here in sync with the real Store
// documents (models/Store.js, collection pincodestoremasters) — the admin
// panel's Categories/Subcategories/Products pages gate on a store_code
// dropdown populated from Store.find(), so drift between the two is
// invisible in the UI (hit once already, see the memory file for this
// tenant).

const DEFAULT_CAT_CSV =
  '/Users/gauravpawar/Downloads/Universal_Setup/Databases/Shree_Mega_mart_product_category_master_1CDN_final.csv';
const DEFAULT_PROD_CSV =
  '/Users/gauravpawar/Downloads/Universal_Setup/Databases/Shree_Mega_mart_PRODUCT_MASTER_WITH_BALANCE.CSV';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const apply = process.argv.includes('--apply');

// RFC4180-ish CSV parser (needed here — the category-master file has a
// handful of quoted fields containing commas; a naive split(',') would
// misalign every column after them).
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

const norm = (s) => s.trim().replace(/\s+/g, ' ').toUpperCase();
const title = (s) =>
  s
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => (w === '&' || w === '' ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');

function loadCategoryMasterRows(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text).slice(1); // drop header
  return rows
    .filter((r) => r.length >= 8 && r[1].trim())
    .map((r) => ({
      pcode: r[1].trim(),
      productName: r[3].trim(),
      rawDept: r[5].trim(),
      rawCat: r[6].trim(),
      rawSub: r[7].trim(),
    }));
}

function loadProductMasterRows(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
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

function buildCatalog(catRows, prodByPcode) {
  const departments = new Map(); // normDept -> { department_id, department_name }
  const categories = new Map(); // "normDept||normCat" -> { idcategory_master, category_name, dept_id }
  const subcategories = new Map(); // "normDept||normCat||normSub" -> { idsub_category_master, sub_category_name, category_id, main_category_name }
  const products = [];
  const excludedNoProduct = [];
  const excludedBadPackage = [];
  const storeCodeCounts = new Map(); // BR_CODE -> how many products carried it
  const PACKAGE_RE = /^([0-9.]+)\s*([A-Za-z]+)$/;

  for (const row of catRows) {
    const nd = norm(row.rawDept);
    const nc = norm(row.rawCat);
    const ns = norm(row.rawSub);

    if (!departments.has(nd)) {
      departments.set(nd, {
        department_id: String(departments.size + 1),
        department_name: title(row.rawDept),
      });
    }
    const deptId = departments.get(nd).department_id;

    const catKey = `${nd}||${nc}`;
    if (!categories.has(catKey)) {
      categories.set(catKey, {
        idcategory_master: String(categories.size + 1),
        category_name: title(row.rawCat),
        dept_id: deptId,
      });
    }
    const cat = categories.get(catKey);

    const subKey = `${nd}||${nc}||${ns}`;
    if (!subcategories.has(subKey)) {
      subcategories.set(subKey, {
        idsub_category_master: String(subcategories.size + 1),
        sub_category_name: title(row.rawSub),
        category_id: cat.idcategory_master,
        main_category_name: cat.category_name,
      });
    }
    const sub = subcategories.get(subKey);

    const prod = prodByPcode.get(row.pcode);
    if (!prod) {
      excludedNoProduct.push(row.pcode);
      continue;
    }

    const m = PACKAGE_RE.exec(prod.packageSize);
    if (!m) {
      excludedBadPackage.push({ pcode: row.pcode, packageSize: prod.packageSize });
      continue;
    }

    const storeCode = prod.storeCode || null;
    if (storeCode) storeCodeCounts.set(storeCode, (storeCodeCounts.get(storeCode) || 0) + 1);

    products.push({
      p_code: row.pcode,
      barcode: prod.barcode || undefined,
      product_name: row.productName,
      package_size: parseFloat(m[1]),
      package_unit: m[2].toUpperCase(),
      product_mrp: prod.productMrp,
      our_price: prod.ourPrice,
      brand_name: prod.brandName || undefined,
      store_code: storeCode,
      pcode_status: prod.status === 'N' ? 'N' : 'Y',
      dept_id: deptId,
      category_id: cat.idcategory_master,
      sub_category_id: sub.idsub_category_master,
      store_quantity: Number(prod.quantity) || 0,
      project_code: PROJECT_CODE,
    });
  }

  return { departments, categories, subcategories, products, excludedNoProduct, excludedBadPackage, storeCodeCounts };
}

async function run() {
  const catPath = arg('cat-file') || DEFAULT_CAT_CSV;
  const prodPath = arg('prod-file') || DEFAULT_PROD_CSV;

  console.log(apply ? '🚚 Onboarding Shree Mega Mart (RET2690) — applying\n' : '🔍 Onboarding Shree Mega Mart (RET2690) — dry run (pass --apply to write)\n');
  console.log(`Category/product master: ${catPath}`);
  console.log(`Product master (pricing/stock): ${prodPath}\n`);

  const catRows = loadCategoryMasterRows(catPath);
  const prodRows = loadProductMasterRows(prodPath);
  const prodByPcode = new Map(prodRows.map((p) => [p.pcode, p]));

  console.log(`📄 Parsed ${catRows.length} category-master row(s), ${prodRows.length} product-master row(s)`);

  const { departments, categories, subcategories, products, excludedNoProduct, excludedBadPackage, storeCodeCounts } =
    buildCatalog(catRows, prodByPcode);

  const distinctStoreCodes = [...storeCodeCounts.keys()];
  if (distinctStoreCodes.length === 0) {
    console.error('\n❌ No BR_CODE value found on any product row — cannot resolve a store_code. Check the product master CSV has a BR_CODE column.');
    process.exit(1);
  }
  // Category.store_code is one value per category (see models/Category.js),
  // not per product, so when BR_CODE varies we fall back to whichever code
  // covers the most products for the categories — every product still keeps
  // its own row's real BR_CODE regardless.
  const STORE_CODE = distinctStoreCodes.sort((a, b) => storeCodeCounts.get(b) - storeCodeCounts.get(a))[0];
  console.log(`\n🏪 Store code (from BR_CODE): ${STORE_CODE}${distinctStoreCodes.length > 1 ? ` — dominant of ${distinctStoreCodes.length} distinct codes seen: ${JSON.stringify(Object.fromEntries(storeCodeCounts))}` : ''}`);

  console.log(`\n📊 Resolved:`);
  console.log(`   ${departments.size} department(s)`);
  console.log(`   ${categories.size} categor(y/ies)`);
  console.log(`   ${subcategories.size} subcategor(y/ies)`);
  console.log(`   ${products.length} product(s) ready to import`);
  if (excludedNoProduct.length) {
    console.log(`   ⚠️  ${excludedNoProduct.length} pcode(s) skipped — no matching row in the pricing file: ${excludedNoProduct.slice(0, 10).join(', ')}${excludedNoProduct.length > 10 ? ', ...' : ''}`);
  }
  if (excludedBadPackage.length) {
    console.log(`   ⚠️  ${excludedBadPackage.length} pcode(s) skipped — unparseable package_size: ${JSON.stringify(excludedBadPackage.slice(0, 10))}`);
  }

  const catPcodes = new Set(catRows.map((r) => r.pcode));
  const prodOnlyPcodes = [...prodByPcode.keys()].filter((p) => !catPcodes.has(p));
  if (prodOnlyPcodes.length) {
    console.log(`   ℹ️  ${prodOnlyPcodes.length} pcode(s) in the pricing file have no department/category/subcategory at all and are excluded entirely: ${prodOnlyPcodes.slice(0, 10).join(', ')}${prodOnlyPcodes.length > 10 ? ', ...' : ''}`);
  }

  console.log('\n🏬 Departments:');
  for (const d of departments.values()) console.log(`   ${d.department_id}. ${d.department_name}`);

  await connectDB();

  const project = await getProjectModel().findOne({ project_code: PROJECT_CODE }).lean();
  if (!project) {
    console.error(`\n❌ No project registered for ${PROJECT_CODE} yet — run scripts/seed_projects.js first (add the tenant there).`);
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
    Department.countDocuments({ project_code: PROJECT_CODE }),
    Category.countDocuments({ project_code: PROJECT_CODE }),
    Subcategory.countDocuments({ project_code: PROJECT_CODE }),
    ProductMaster.countDocuments({ project_code: PROJECT_CODE }),
  ]);
  console.log(`\n🗑  Existing rows for ${PROJECT_CODE} that would be replaced: ${existingDepts} department(s), ${existingCats} categor(y/ies), ${existingSubs} subcategor(y/ies), ${existingProds} product(s)`);

  if (!apply) {
    console.log('\nDry run only — no writes. Re-run with --apply to write these records.');
    await disconnectDB();
    return;
  }

  await Promise.all([
    Department.deleteMany({ project_code: PROJECT_CODE }),
    Category.deleteMany({ project_code: PROJECT_CODE }),
    Subcategory.deleteMany({ project_code: PROJECT_CODE }),
    ProductMaster.deleteMany({ project_code: PROJECT_CODE }),
  ]);

  const deptDocs = [...departments.values()].map((d, i) => ({
    ...d,
    dept_type_id: '1',
    dept_no_of_col: 1,
    store_code: null,
    sequence_id: i + 1,
    project_code: PROJECT_CODE,
  }));
  const catDocs = [...categories.values()].map((c, i) => ({
    ...c,
    sequence_id: i + 1,
    store_code: STORE_CODE,
    no_of_col: '3',
    project_code: PROJECT_CODE,
  }));
  const subDocs = [...subcategories.values()].map((s) => ({ ...s, project_code: PROJECT_CODE }));

  const insertedDepts = await Department.insertMany(deptDocs, { ordered: true });
  const insertedCats = await Category.insertMany(catDocs, { ordered: true });
  const insertedSubs = await Subcategory.insertMany(subDocs, { ordered: true });
  const insertedProds = await ProductMaster.insertMany(products, { ordered: false });

  console.log(`\n✅ Inserted ${insertedDepts.length} department(s), ${insertedCats.length} categor(y/ies), ${insertedSubs.length} subcategor(y/ies), ${insertedProds.length} product(s) into ${project.db_name}.`);

  await disconnectDB();
}

run().catch((err) => {
  console.error('❌ Onboarding failed:', err);
  process.exit(1);
});
