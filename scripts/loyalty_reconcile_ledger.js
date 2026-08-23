// One-off repair for a bug in debitPoints() (utils/loyaltyEngine.js,
// fixed alongside this script): the idempotency-guarding
// LoyaltyTransaction.create() used to run AFTER the loop that consumes and
// saves CREDIT batches' remainingPoints. On this deployment (no real
// MongoDB transactions - see runAtomically), a RETRIED debit call with the
// same idempotencyKey - a normal thing for a mobile client to do on a
// timeout, or what happened testing the redeem flow - re-ran that
// consumption loop and decremented remainingPoints a second time for points
// that were never actually re-debited from the account (the duplicate-key
// error stopped it from ever reaching the account balance update). Net
// effect: sum(remainingPoints across a mobile's COMPLETED CREDIT batches)
// silently drops below account.availablePoints, and every subsequent
// redemption for that account fails with "Loyalty ledger inconsistency ...
// points unaccounted for by CREDIT batches" - reported as "unable to redeem
// coupon".
//
// account.availablePoints is the trustworthy value here: it's only ever
// incremented/decremented by a genuinely new (non-duplicate)
// LoyaltyTransaction, since that update runs strictly after the row is
// successfully created. remainingPoints can only have been UNDER-counted by
// this bug, never over-counted, so wherever sum(remainingPoints) <
// availablePoints, this restores the shortfall onto the COMPLETED CREDIT
// batch with the latest expiresAt (preferring a batch that won't expire
// soonest, so the restored points don't vanish again almost immediately;
// falls back to the most recently created batch if none has an expiresAt
// set) for that mobile.
//
//   node scripts/loyalty_reconcile_ledger.js                # dry run
//   node scripts/loyalty_reconcile_ledger.js --apply
//   node scripts/loyalty_reconcile_ledger.js --apply --project RET6978

require('dotenv').config();
const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { getProjectModel } = require('../models/Project');
require('../models/LoyaltyAccount');
require('../models/LoyaltyTransaction');

const apply = process.argv.includes('--apply');
const projectArgIndex = process.argv.indexOf('--project');
const onlyProject = projectArgIndex !== -1 ? process.argv[projectArgIndex + 1] : null;

async function reconcileProject(project) {
  const db = getTenantDb(project.db_name);
  const LoyaltyAccount = db.models.LoyaltyAccount;
  const LoyaltyTransaction = db.models.LoyaltyTransaction;

  const accounts = await LoyaltyAccount.find({ availablePoints: { $gt: 0 } });
  let found = 0;

  for (const account of accounts) {
    const batches = await LoyaltyTransaction.find({
      mobile: account.mobile,
      type: 'CREDIT',
      status: 'COMPLETED'
    });
    const sumRemaining = batches.reduce((sum, b) => sum + b.remainingPoints, 0);
    const shortfall = account.availablePoints - sumRemaining;

    if (shortfall <= 0) continue;
    found += 1;

    console.log(
      `  [${project.project_code}] ${account.mobile}: availablePoints=${account.availablePoints}, ` +
      `sum(remainingPoints)=${sumRemaining}, shortfall=${shortfall}`
    );

    if (!apply) continue;

    const withExpiry = batches.filter((b) => b.expiresAt).sort((a, b) => b.expiresAt - a.expiresAt);
    const target = withExpiry[0] || batches.sort((a, b) => b.createdAt - a.createdAt)[0];

    if (!target) {
      console.error(`    ! no CREDIT batch to restore onto for ${account.mobile} - skipping`);
      continue;
    }

    target.remainingPoints += shortfall;
    await target.save();
    console.log(`    restored ${shortfall} points onto batch ${target._id} (idempotencyKey ${target.idempotencyKey})`);
  }

  if (!found) console.log(`  [${project.project_code}] no inconsistencies found`);
}

const run = async () => {
  console.log(apply ? '🚚 Applying loyalty ledger reconciliation\n' : '🔍 Dry run — no writes (pass --apply)\n');
  await connectDB();

  const filter = { status: 'active' };
  if (onlyProject) filter.project_code = onlyProject.toUpperCase();
  const projects = await getProjectModel().find(filter).lean();

  for (const project of projects) {
    await reconcileProject(project);
  }

  await disconnectDB();
  console.log('\nDone.');
};

run().catch((err) => {
  console.error('Reconciliation failed:', err);
  process.exit(1);
});
