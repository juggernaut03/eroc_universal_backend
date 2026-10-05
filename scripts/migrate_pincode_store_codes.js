// Backfills Pincode.store_codes[] from the existing Pincode.store_code
// scalar (models/Pincode.js) — the data-side half of letting a pincode be
// served by more than one store, with the customer choosing at checkout
// (the mobile app's outlet-selection screen already supports this; only the
// backend ever capped it at one store).
//
// Handles two shapes found in production data:
//   1. One Pincode document per pincode value (the overwhelming majority):
//      store_code -> store_codes: [store_code]. Purely additive.
//   2. Multiple Pincode documents sharing the same pincode value, each
//      pointing at a different store_code (found on RET2690's 493221 —
//      BHANPURI and BIRGAON both cover it, represented as two duplicate
//      rows because the old schema had no way to express "one pincode,
//      several stores"). These are merged into the one with the lowest
//      idpincode_master, with store_codes set to the union of every
//      store_code among them (deduped) and is_enabled set to Enabled if
//      any of them was — then the other row(s) are deleted.
//
// Never reads/writes the legacy store_code field, so running this against a
// tenant whose backend hasn't deployed the new routes yet is harmless (they
// keep reading store_code). Idempotent: a pincode value whose merged
// store_codes already covers every store_code among its row(s) is skipped.
//
//   node scripts/migrate_pincode_store_codes.js                # dry run
//   node scripts/migrate_pincode_store_codes.js --apply
//   node scripts/migrate_pincode_store_codes.js --apply --project RET2690

require('dotenv').config();
const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { getProjectModel } = require('../models/Project');
require('../models/Pincode');

const apply = process.argv.includes('--apply');
const projectArgIndex = process.argv.indexOf('--project');
const onlyProject = projectArgIndex !== -1 ? process.argv[projectArgIndex + 1] : null;

async function migrateProject(project) {
  const db = getTenantDb(project.db_name);
  const Pincode = db.models.Pincode;

  const allDocs = await Pincode.find({}).lean();
  const byPincode = new Map();
  for (const doc of allDocs) {
    if (!byPincode.has(doc.pincode)) byPincode.set(doc.pincode, []);
    byPincode.get(doc.pincode).push(doc);
  }

  let plannedChanges = 0;
  console.log(`\n=== ${project.project_code} (${project.db_name}) — ${byPincode.size} distinct pincode(s), ${allDocs.length} row(s) ===`);

  for (const [pincodeValue, docs] of byPincode) {
    const mergedCodes = [...new Set(
      docs.flatMap((d) => [...(d.store_codes || []), d.store_code].filter(Boolean))
    )];

    if (docs.length === 1) {
      const [doc] = docs;
      const already = [...(doc.store_codes || [])].sort().join(',') === [...mergedCodes].sort().join(',');
      if (mergedCodes.length === 0 || already) continue;
      plannedChanges++;
      console.log(`  ${pincodeValue}: store_code ${doc.store_code} -> store_codes [${mergedCodes.join(', ')}]`);
      if (apply) {
        await Pincode.updateOne({ _id: doc._id }, { $set: { store_codes: mergedCodes } });
      }
      continue;
    }

    // Multiple rows for the same pincode value — merge into the oldest
    // (lowest idpincode_master), delete the rest.
    const sorted = [...docs].sort((a, b) => a.idpincode_master - b.idpincode_master);
    const canonical = sorted[0];
    const extras = sorted.slice(1);
    const anyEnabled = docs.some((d) => d.is_enabled === 'Enabled');
    const alreadyMerged =
      [...(canonical.store_codes || [])].sort().join(',') === [...mergedCodes].sort().join(',') &&
      extras.length === 0;

    if (alreadyMerged) continue;
    plannedChanges++;
    console.log(
      `  ${pincodeValue}: ${docs.length} rows [${docs.map((d) => `${d.store_code}#${d.idpincode_master}`).join(', ')}] ` +
      `-> keeping #${canonical.idpincode_master} with store_codes [${mergedCodes.join(', ')}], ` +
      `deleting #${extras.map((d) => d.idpincode_master).join(', #')}`
    );
    if (apply) {
      await Pincode.updateOne(
        { _id: canonical._id },
        { $set: { store_codes: mergedCodes, is_enabled: anyEnabled ? 'Enabled' : canonical.is_enabled } }
      );
      if (extras.length > 0) {
        await Pincode.deleteMany({ _id: { $in: extras.map((d) => d._id) } });
      }
    }
  }

  if (plannedChanges === 0) {
    console.log('  (nothing to do)');
  }
}

const run = async () => {
  console.log(apply ? '🚚 Applying pincode store_codes backfill\n' : '🔍 Dry run — no writes (pass --apply to migrate)\n');

  await connectDB();

  const filter = { status: 'active' };
  if (onlyProject) filter.project_code = onlyProject.toUpperCase();
  const projects = await getProjectModel().find(filter).lean();

  for (const project of projects) {
    await migrateProject(project);
  }

  await disconnectDB();
  console.log('\nDone.');
};

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
