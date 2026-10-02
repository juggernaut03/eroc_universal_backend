/**
 * Migration script: collapse ProductMaster from one document per
 * (p_code, store_code) into one document per p_code, with a `stores[]`
 * array holding the per-store price/stock/status fields.
 *
 * Why: today a product sold in 4 stores is 4 full documents, each with its
 * own copy of fields that should be identical everywhere (product_name,
 * barcode, dept_id/category_id/sub_category_id, pcode_img/pcode_img_2,
 * package_size/package_unit, brand_name). Nothing keeps those copies in
 * sync — this is the root cause behind several real bugs this session
 * (per-store barcode drift breaking image matching, the same product
 * ending up with different images per store). See
 * /Users/gauravpawar/.claude/plans/breezy-crunching-sifakis.md for the
 * full design.
 *
 * Runs entirely against the RAW MongoDB driver collections, never through
 * the Mongoose ProductMaster model — this script has to run BEFORE the
 * schema is updated to the new shape (the whole point is to prepare data
 * for a schema that doesn't exist yet in the running app), so it can't
 * depend on either the old or new Mongoose model being loaded.
 *
 * Per p_code, each identity field is reconciled independently across that
 * product's store-copies (a product can disagree on barcode while
 * agreeing on name):
 *   - barcode: discard values that are empty, fail a basic "safe barcode
 *     shape" check (mirrors utils/imageSync.js's own SAFE_BARCODE_RE), or
 *     look like Excel's scientific-notation mangling ("8.9E+12") — a real
 *     incident this session. Most frequent admissible value wins.
 *   - pcode_img / pcode_img_2: first non-empty value, in store-priority
 *     order (oldest store first) — NOT a frequency vote, since a vote
 *     would let "no image" outvote a real one.
 *   - dept_id / category_id / sub_category_id: most frequent value, but
 *     flagged for manual review on ANY disagreement (not just an
 *     unresolved one) — wrong classification is more consequential than
 *     e.g. a brand_name typo.
 *   - everything else: most frequent non-empty value.
 * Every disagreement (resolved or not) is logged to a JSON report for
 * human review — this script never silently guesses on something that
 * matters without leaving a trail.
 *
 * Same-store cross-listings: some tenants (confirmed live on Grahak Peth,
 * Sansar Pariwar, Pagariya) have more than one document for the exact same
 * (p_code, store_code) — identical price/stock/name, but a different
 * dept/category/sub_category_id, matching a deliberate "also show this
 * product under a promotional category too" pattern. These are NOT
 * reconciled like a normal field disagreement (stores[] can't hold two
 * entries for one store_code, and nothing should silently drop one
 * listing) — the oldest document (by _id) becomes that store's one
 * listing, and every other document's sub_category_id is preserved via
 * the codebase's existing SubcategoryProductMap collection instead, which
 * already exists for exactly "also list this product under this
 * subcategory too" (see models/SubcategoryProductMap.js).
 *

 * Three-stage, explicit, nothing automatic:
 *   1. Dry run (default): reads only, writes nothing, just reports what
 *      WOULD happen and produces the conflict report.
 *   2. --apply: writes the merged documents into a parallel
 *      `productmasters_migrated` collection. The live `productmasters`
 *      collection is untouched and keeps serving the old-shape app the
 *      whole time.
 *   3. --cutover: renames productmasters -> productmasters_pre_migration_backup,
 *      then productmasters_migrated -> productmasters. Only run this once
 *      productmasters_migrated has been verified AND the new schema/route
 *      code is ready to deploy immediately after — old code cannot read
 *      the new shape. This is the one moment of brief write-downtime
 *      (writes against the old collection during the two renames land on
 *      neither collection and are lost) per the agreed rollout plan.
 *      Rollback: rename productmasters_pre_migration_backup back to
 *      productmasters by hand.
 *
 * Usage:
 *   node scripts/migrate_productmaster_to_stores_array.js                      # dry run, every tenant
 *   node scripts/migrate_productmaster_to_stores_array.js --project RET2690    # dry run, one tenant
 *   node scripts/migrate_productmaster_to_stores_array.js --project RET2690 --apply
 *   node scripts/migrate_productmaster_to_stores_array.js --project RET2690 --cutover
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { getProjectModel } = require('../models/Project');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const cutover = args.includes('--cutover');
const projectFlagIndex = args.indexOf('--project');
const onlyProject = projectFlagIndex !== -1 ? args[projectFlagIndex + 1] : null;
const reportDir = path.join(__dirname, '..', 'tmp', 'productmaster-migration-reports');

// Mirrors utils/imageSync.js's own SAFE_BARCODE_RE — a barcode admissible
// for pool-file naming there is also what's admissible here as a real
// identity value; anything else is discarded, never voted on.
const SAFE_BARCODE_RE = /^[A-Za-z0-9_.-]+$/;
const SCI_NOTATION_RE = /e\+?\d+$/i;

const IDENTITY_FIELDS = [
  'barcode', 'product_name', 'product_description', 'package_size',
  'package_unit', 'brand_name', 'dept_id', 'category_id', 'sub_category_id',
  'pcode_img', 'pcode_img_2', 'search_keyword'
];

const FLAG_ON_ANY_DISAGREEMENT = new Set(['dept_id', 'category_id', 'sub_category_id']);
const FIRST_NON_EMPTY_FIELDS = new Set(['pcode_img', 'pcode_img_2']);

function isAdmissibleBarcode(value) {
  if (value === undefined || value === null) return false;
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  if (SCI_NOTATION_RE.test(trimmed)) return false;
  return SAFE_BARCODE_RE.test(trimmed);
}

function isPresent(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

// Resolves one identity field across a p_code's store-copies. Returns the
// chosen value plus enough detail to log a report row when they disagree.
function reconcileField(field, docs, storeOrder) {
  const values = docs.map((d) => ({ store_code: d.store_code, value: d[field] }));
  const admissible = field === 'barcode'
    ? values.filter((v) => isAdmissibleBarcode(v.value))
    : values.filter((v) => isPresent(v.value));

  const distinctValues = new Set(values.map((v) => (isPresent(v.value) ? String(v.value) : '')));
  const disagreement = distinctValues.size > 1;

  if (admissible.length === 0) {
    return { chosen: null, disagreement, reason: 'no admissible value found', values };
  }

  if (FIRST_NON_EMPTY_FIELDS.has(field)) {
    const ordered = [...admissible].sort(
      (a, b) => storeOrder.indexOf(a.store_code) - storeOrder.indexOf(b.store_code)
    );
    return { chosen: ordered[0].value, disagreement, reason: 'first non-empty by store priority', values };
  }

  const counts = new Map();
  for (const v of admissible) {
    const key = String(v.value);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bestKey = null;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) { bestKey = key; bestCount = count; }
  }
  const chosen = admissible.find((v) => String(v.value) === bestKey).value;
  return { chosen, disagreement, reason: `most frequent admissible value (${bestCount}/${admissible.length})`, values };
}

// Store priority for tiebreaks / first-non-empty fields: oldest store
// first, by that store's earliest document createdAt in this tenant.
function buildStoreOrder(docs) {
  const firstSeen = new Map();
  for (const d of docs) {
    const ts = d.createdAt ? new Date(d.createdAt).getTime() : Infinity;
    if (!firstSeen.has(d.store_code) || ts < firstSeen.get(d.store_code)) {
      firstSeen.set(d.store_code, ts);
    }
  }
  return [...firstSeen.entries()].sort((a, b) => a[1] - b[1]).map(([storeCode]) => storeCode);
}

async function migrateTenant(project, report) {
  const connection = mongoose.connection.useDb(project.db_name, { useCache: true });
  const sourceColl = connection.db.collection('productmasters');
  const targetColl = connection.db.collection('productmasters_migrated');
  // pincodestoremasters is models/Store.js's actual collection name (one
  // row per store today, despite the legacy name — see that model's own
  // comment).
  const storeColl = connection.db.collection('pincodestoremasters');

  const docs = await sourceColl.find({}).toArray();
  if (docs.length === 0) {
    console.log(`  ${project.project_code} (${project.db_name}): no products, skipping`);
    return { tenant: project.project_code, before: 0, after: 0, conflicts: 0, flaggedForReview: 0, orphaned: 0 };
  }

  // A document whose store_code isn't a real store for this tenant is
  // orphaned data (seen live: a single leftover row with store_code "1"
  // from an old import, carrying a completely different product under the
  // same p_code by coincidence) — never silently merge it in as if it were
  // a legitimate 5th store listing. Excluded from stores[], logged
  // separately, left untouched in the pre-migration backup for a human to
  // deal with by hand.
  const validStoreCodes = new Set(
    (await storeColl.find({}).project({ store_code: 1 }).toArray()).map((s) => s.store_code)
  );
  const orphanedDocs = docs.filter((d) => !validStoreCodes.has(d.store_code));
  const validDocs = docs.filter((d) => validStoreCodes.has(d.store_code));
  for (const d of orphanedDocs) {
    report.push({
      project_code: project.project_code,
      p_code: d.p_code,
      field: '(whole document)',
      values_seen: [{ store_code: d.store_code, value: d.product_name }],
      chosen_value: null,
      reason: `store_code ${JSON.stringify(d.store_code)} is not a real store for this tenant — excluded, needs manual handling`,
      needs_manual_review: true
    });
  }

  const storeOrder = buildStoreOrder(validDocs);

  const byPcode = new Map();
  for (const d of validDocs) {
    if (!byPcode.has(d.p_code)) byPcode.set(d.p_code, []);
    byPcode.get(d.p_code).push(d);
  }

  const merged = [];
  const subcategoryMapInserts = [];
  let conflictCount = 0;
  let flaggedCount = 0;
  let crossListedCount = 0;
  let extrasConsumedCount = 0;

  for (const [pcode, rawGroup] of byPcode) {
    // Some tenants have more than one document for the SAME (p_code,
    // store_code) — confirmed live on Grahak Peth/Sansar Pariwar/Pagariya:
    // identical price/stock/name, but a different dept/category/
    // sub_category_id, matching an existing deliberate pattern (same
    // product cross-listed under both its real department and a
    // promotional one, e.g. Best Seller). These are NOT different stores
    // and must never produce two stores[] entries with the same
    // store_code (nothing in Mongo enforces that uniqueness — see the
    // schema notes). The codebase already has a mechanism for exactly
    // "also list this product under another subcategory too" —
    // SubcategoryProductMap (models/SubcategoryProductMap.js) — so rather
    // than inventing new schema surface, the oldest same-store document
    // (by _id, which is time-ordered) becomes this store's one listing,
    // and every other same-store document's sub_category_id is preserved
    // there instead.
    const byStoreCode = new Map();
    for (const d of rawGroup) {
      if (!byStoreCode.has(d.store_code)) byStoreCode.set(d.store_code, []);
      byStoreCode.get(d.store_code).push(d);
    }
    const group = [];
    for (const [storeCode, docsForStore] of byStoreCode) {
      if (docsForStore.length === 1) {
        group.push(docsForStore[0]);
        continue;
      }
      const sorted = [...docsForStore].sort((a, b) => String(a._id).localeCompare(String(b._id)));
      const [primary, ...extras] = sorted;
      group.push(primary);
      crossListedCount++;
      extrasConsumedCount += extras.length;
      for (const extra of extras) {
        if (extra.sub_category_id && extra.sub_category_id !== primary.sub_category_id) {
          subcategoryMapInserts.push({
            idsub_category_master: extra.sub_category_id,
            p_code: pcode,
            store_code: storeCode,
            project_code: project.project_code
          });
        }
        report.push({
          project_code: project.project_code,
          p_code: pcode,
          field: '(cross-listing)',
          values_seen: [
            { store_code: `${storeCode} (kept, primary)`, value: `dept=${primary.dept_id} cat=${primary.category_id} sub=${primary.sub_category_id}` },
            { store_code: `${storeCode} (preserved as additional subcategory)`, value: `dept=${extra.dept_id} cat=${extra.category_id} sub=${extra.sub_category_id}` }
          ],
          chosen_value: `SubcategoryProductMap: {p_code: ${pcode}, store_code: ${storeCode}, idsub_category_master: ${extra.sub_category_id}}`,
          reason: 'same store listed this product under two classifications — kept both, second moved to SubcategoryProductMap',
          needs_manual_review: false
        });
      }
    }

    const identity = {};
    for (const field of IDENTITY_FIELDS) {
      const { chosen, disagreement, reason, values } = reconcileField(field, group, storeOrder);
      identity[field] = chosen;
      if (disagreement) {
        conflictCount++;
        const needsReview = FLAG_ON_ANY_DISAGREEMENT.has(field) || chosen === null;
        if (needsReview) flaggedCount++;
        report.push({
          project_code: project.project_code,
          p_code: pcode,
          field,
          values_seen: values,
          chosen_value: chosen,
          reason,
          needs_manual_review: needsReview
        });
      }
    }

    // Per-store fields copied as-is — no reconciliation, that's the whole
    // point of this field set staying per-store.
    const stores = group.map((d) => ({
      store_code: d.store_code,
      our_price: d.our_price,
      product_mrp: d.product_mrp,
      store_quantity: d.store_quantity,
      pcode_status: d.pcode_status,
      max_quantity_allowed: d.max_quantity_allowed,
      createdAt: d.createdAt || new Date(),
      updatedAt: d.updatedAt || new Date()
    }));

    const earliestCreatedAt = group.reduce(
      (min, d) => (d.createdAt && d.createdAt < min ? d.createdAt : min),
      group[0].createdAt || new Date()
    );

    merged.push({
      p_code: pcode,
      ...identity,
      project_code: group[0].project_code || project.project_code,
      stores,
      createdAt: earliestCreatedAt,
      updatedAt: new Date()
    });
  }

  const totalStoreListings = merged.reduce((sum, m) => sum + m.stores.length, 0);
  // Every source row lands exactly once: as a store listing, an excluded
  // orphan, or a same-store "extra" consumed into SubcategoryProductMap —
  // never more than one of those, never none of them.
  const countsMatch = totalStoreListings + orphanedDocs.length + extrasConsumedCount === docs.length;

  console.log(
    `  ${project.project_code} (${project.db_name}): ${docs.length} rows -> ${merged.length} products, ` +
    `${conflictCount} field conflicts (${flaggedCount + orphanedDocs.length} flagged for manual review` +
    `${orphanedDocs.length ? `, including ${orphanedDocs.length} orphaned row(s) with an unrecognized store_code` : ''}), ` +
    `${crossListedCount} cross-listed (same store, two classifications — ${subcategoryMapInserts.length} ` +
    `preserved as additional-subcategory mappings), counts ${countsMatch ? 'match' : 'MISMATCH'}`
  );

  if (!countsMatch) {
    throw new Error(
      `${project.project_code}: store-listing count (${totalStoreListings}) + orphaned (${orphanedDocs.length}) + ` +
      `cross-listing extras (${extrasConsumedCount}) does not match source document count (${docs.length}) — ` +
      `aborting this tenant, nothing written`
    );
  }

  if (apply) {
    await targetColl.deleteMany({});
    if (merged.length > 0) await targetColl.insertMany(merged, { ordered: false });
    console.log(`    -> wrote ${merged.length} documents into ${project.db_name}.productmasters_migrated`);

    if (subcategoryMapInserts.length > 0) {
      const subcatMapColl = connection.db.collection('subcategoryproductmaps');
      const ops = subcategoryMapInserts.map((entry) => ({
        updateOne: {
          filter: {
            idsub_category_master: entry.idsub_category_master,
            p_code: entry.p_code,
            store_code: entry.store_code
          },
          update: { $setOnInsert: entry },
          upsert: true
        }
      }));
      await subcatMapColl.bulkWrite(ops, { ordered: false });
      console.log(`    -> upserted ${ops.length} additional-subcategory mappings into ${project.db_name}.subcategoryproductmaps`);
    }
  }

  return {
    tenant: project.project_code,
    before: docs.length,
    after: merged.length,
    conflicts: conflictCount,
    flaggedForReview: flaggedCount + orphanedDocs.length,
    orphaned: orphanedDocs.length,
    crossListed: crossListedCount
  };
}

async function doCutover(project) {
  const connection = mongoose.connection.useDb(project.db_name, { useCache: true });
  const db = connection.db;
  const collectionNames = (await db.listCollections().toArray()).map((c) => c.name);

  if (!collectionNames.includes('productmasters_migrated')) {
    console.log(
      `  ${project.project_code}: no productmasters_migrated collection — ` +
      `run with --apply first, skipping cutover`
    );
    return;
  }
  if (collectionNames.includes('productmasters_pre_migration_backup')) {
    console.log(`  ${project.project_code}: already cut over (backup collection exists), skipping`);
    return;
  }

  await db.collection('productmasters').rename('productmasters_pre_migration_backup');
  await db.collection('productmasters_migrated').rename('productmasters');
  console.log(
    `  ${project.project_code}: cutover complete — productmasters is now the new shape. ` +
    `Rollback: rename productmasters_pre_migration_backup back to productmasters by hand.`
  );
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);

  const Project = getProjectModel();
  const query = onlyProject ? { project_code: onlyProject } : {};
  const projects = await Project.find(query).select('project_code client_name db_name').lean();

  if (projects.length === 0) {
    console.log(onlyProject ? `No project found for ${onlyProject}` : 'No projects found');
    await mongoose.disconnect();
    return;
  }

  console.log(
    cutover
      ? '🚚 Cutover — renaming collections (new backend code must deploy immediately after)\n'
      : apply
        ? '🚚 Applying migration — writing productmasters_migrated (source collection untouched)\n'
        : '🔍 Dry run — no writes (pass --apply to write productmasters_migrated, --cutover to rename after verifying)\n'
  );

  if (cutover) {
    for (const project of projects) {
      await doCutover(project);
    }
    await mongoose.disconnect();
    return;
  }

  const report = [];
  const summaries = [];
  for (const project of projects) {
    try {
      summaries.push(await migrateTenant(project, report));
    } catch (err) {
      console.error(`  ${project.project_code}: FAILED — ${err.message}`);
    }
  }

  if (report.length > 0) {
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `conflicts_${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nConflict report (${report.length} rows): ${reportPath}`);
  }

  console.log('\nSummary:');
  for (const s of summaries) {
    console.log(
      `  ${s.tenant}: ${s.before} -> ${s.after} products, ${s.conflicts} conflicts, ` +
      `${s.flaggedForReview} flagged for manual review, ${s.crossListed} cross-listed`
    );
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
