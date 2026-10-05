// Backfills Pincode.store_codes[] from the existing Pincode.store_code
// scalar (models/Pincode.js) — the data-side half of letting a pincode be
// served by more than one store, with the customer choosing at checkout
// (the mobile app's outlet-selection screen already supports this; only the
// backend ever capped it at one store).
//
// Purely additive: never reads, writes, or removes store_code. Safe to run
// at any time, including against a tenant whose backend hasn't deployed the
// new routes yet (they keep reading store_code, untouched by this script).
// Idempotent: a Pincode doc that already has a non-empty store_codes is
// left alone, so re-running only picks up anything missed previously.
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

  const candidates = await Pincode.find({
    store_code: { $nin: [null, ''] },
    $or: [{ store_codes: { $exists: false } }, { store_codes: { $size: 0 } }],
  }).lean();

  console.log(`\n=== ${project.project_code} (${project.db_name}) — ${candidates.length} pincode(s) to backfill ===`);

  for (const doc of candidates) {
    console.log(`  ${doc.pincode}: store_code ${doc.store_code} -> store_codes [${doc.store_code}]`);
    if (apply) {
      await Pincode.updateOne({ _id: doc._id }, { $set: { store_codes: [doc.store_code] } });
    }
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
