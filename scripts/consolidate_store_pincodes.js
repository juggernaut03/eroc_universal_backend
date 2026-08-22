// Consolidates the old one-Store-row-per-pincode model into one Store row
// per store_code, with pincode coverage moved onto Pincode.store_code
// instead (models/Pincode.js, models/Store.js).
//
// Why: pincodestoremasters used to hold one full row — name, address,
// contact info, AND every delivery-fee field — per (store_code, pincode)
// pair. A store serving 30 pincodes meant 30 independently-editable copies
// of the same delivery config. They drift: My Need Mart's single physical
// store had 4 rows, one accidentally left at a 5km max delivery radius
// while the other three said 50km, and /api/delivery-charges/calculate
// picked whichever row Mongo returned first — silently applying the wrong
// one to every delivery regardless of the customer's actual pincode.
//
// For each store_code with more than one row, this picks the CONFIG the
// majority of its rows agree on as canonical (ties broken by whichever row
// sorts first) — deletes the rest, and upserts a Pincode document for every
// pincode any of those rows covered, pointing at that store_code. Where all
// rows already agree (every tenant except My Need Mart, as of writing —
// verified before this script was written), this is a no-op beyond the
// Pincode upserts.
//
// Idempotent: re-running finds one row per store_code already and nothing
// left to delete.
//
//   node scripts/consolidate_store_pincodes.js                # dry run
//   node scripts/consolidate_store_pincodes.js --apply
//   node scripts/consolidate_store_pincodes.js --apply --project RET6978

require('dotenv').config();
const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { getProjectModel } = require('../models/Project');
require('../models/Store');
require('../models/Pincode');
require('../models/Counter');

const apply = process.argv.includes('--apply');
const projectArgIndex = process.argv.indexOf('--project');
const onlyProject = projectArgIndex !== -1 ? process.argv[projectArgIndex + 1] : null;

// The fields that actually vary the price/availability a customer sees.
// mobile_outlet_name/store_address/contact fields etc. are store identity,
// not delivery config, and aren't compared here — they should already be
// identical copies since it's the same physical store.
const CONFIG_FIELDS = [
  'free_delivery_threshold',
  'free_delivery_radius_km',
  'max_delivery_radius_km',
  'delivery_base_charge',
  'delivery_base_distance_km',
  'delivery_per_km_charge',
  'handling_fee',
  'package_fee',
];

const configSignature = (row) =>
  JSON.stringify(CONFIG_FIELDS.map((f) => row[f] ?? null));

async function consolidateProject(project) {
  const db = getTenantDb(project.db_name);
  const Store = db.models.Store;
  const Pincode = db.models.Pincode;
  const Counter = db.models.Counter;

  // Seed the counter past whatever idpincode_master values already exist —
  // those were assigned by an older, separate process this migration knows
  // nothing about. $max only ever raises the stored value, so this is safe
  // to run every time.
  const highestExisting = await Pincode.find({}).sort({ idpincode_master: -1 }).limit(1).lean();
  if (highestExisting.length && apply) {
    await Counter.findOneAndUpdate(
      { name: 'pincode_master_id' },
      { $max: { sequence_value: highestExisting[0].idpincode_master } },
      { upsert: true }
    );
  }

  const allRows = await Store.find({}).lean();
  const byStoreCode = new Map();
  for (const row of allRows) {
    const code = row.store_code;
    if (!byStoreCode.has(code)) byStoreCode.set(code, []);
    byStoreCode.get(code).push(row);
  }

  console.log(`\n=== ${project.project_code} (${project.db_name}) — ${byStoreCode.size} store(s), ${allRows.length} row(s) ===`);

  for (const [storeCode, rows] of byStoreCode) {
    const pincodes = rows.map((r) => r.pincode).filter(Boolean);

    if (rows.length === 1) {
      console.log(`  ${storeCode}: already 1 row (${rows[0].pincode || 'no pincode'})`);
    } else {
      // Majority vote on config signature; ties keep whichever appears
      // first (stable, deterministic — same input always picks the same row).
      const counts = new Map();
      for (const row of rows) {
        const sig = configSignature(row);
        counts.set(sig, (counts.get(sig) || 0) + 1);
      }
      const winningSig = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const canonical = rows.find((row) => configSignature(row) === winningSig);
      const toDelete = rows.filter((row) => row._id.toString() !== canonical._id.toString());

      console.log(
        `  ${storeCode}: ${rows.length} rows -> keeping ${canonical._id} (pincode ${canonical.pincode}, ` +
        `max_radius=${canonical.max_delivery_radius_km}, base=${canonical.delivery_base_charge}), ` +
        `deleting ${toDelete.length}: [${toDelete.map((r) => `${r.pincode}(${r.max_delivery_radius_km}km)`).join(', ')}]`
      );

      if (apply) {
        await Store.deleteMany({ _id: { $in: toDelete.map((r) => r._id) } });
      }
    }

    // Every pincode any of this store's rows covered gets a Pincode
    // document pointing at store_code, whether or not that row survived.
    for (const pincode of pincodes) {
      const existing = await Pincode.findOne({ pincode }).lean();
      if (existing) {
        if (existing.store_code !== storeCode) {
          console.log(`    pincode ${pincode}: Pincode doc exists, store_code ${existing.store_code || '(none)'} -> ${storeCode}`);
          if (apply) {
            await Pincode.updateOne({ _id: existing._id }, { $set: { store_code: storeCode } });
          }
        }
      } else {
        console.log(`    pincode ${pincode}: creating Pincode doc -> store_code ${storeCode}`);
        if (apply) {
          const nextId = await Counter.getNextSequence('pincode_master_id');
          await Pincode.create({
            idpincode_master: nextId,
            pincode,
            is_enabled: 'Enabled',
            store_code: storeCode,
          });
        }
      }
    }
  }
}

const run = async () => {
  console.log(apply ? '🚚 Applying store/pincode consolidation\n' : '🔍 Dry run — no writes (pass --apply to migrate)\n');

  await connectDB();

  const filter = { status: 'active' };
  if (onlyProject) filter.project_code = onlyProject.toUpperCase();
  const projects = await getProjectModel().find(filter).lean();

  for (const project of projects) {
    await consolidateProject(project);
  }

  await disconnectDB();
  console.log('\nDone.');
};

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
