// Promotes PENDING loyalty-point credits (orders still inside their return/
// eligibility window - loyalty_rewards_frd.md section 9) to COMPLETED once
// their availableAt has passed, moving the points from pendingPoints to
// availablePoints on the account and starting each batch's 12-month expiry
// clock from that moment.
//
// This codebase has no cron/scheduler process (see loyalty_expire_points.js
// header for the same note) - run this daily via OS cron/pm2 cron against
// every tenant:
//
//   node scripts/loyalty_process_pending_points.js                # dry run
//   node scripts/loyalty_process_pending_points.js --apply
//   node scripts/loyalty_process_pending_points.js --apply --project RET6978
//
// Idempotent: only touches rows still in PENDING status, so re-running (or
// running twice in one day) is a no-op for anything already promoted.

require('dotenv').config();
const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { als } = require('../config/tenantContext');
const { getProjectModel } = require('../models/Project');
require('../models/User');
require('../models/LoyaltyAccount');
require('../models/LoyaltyTransaction');
const { notifyLoyaltyEvent } = require('../utils/loyaltyNotify');

const apply = process.argv.includes('--apply');
const projectArgIndex = process.argv.indexOf('--project');
const onlyProject = projectArgIndex !== -1 ? process.argv[projectArgIndex + 1] : null;

const EXPIRY_MONTHS = 12;
const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
};

async function processProject(project) {
  const db = getTenantDb(project.db_name);
  // notifyLoyaltyEvent() -> Notification.create() goes through the
  // ALS-Proxy model (models/tenantModel.js), which resolves the DB from the
  // async-local tenant context, not from `db` directly - without this, it
  // would silently write to the fallback (default) tenant DB instead.
  return als.run({ connection: db, project }, () => processProjectInner(db, project));
}

async function processProjectInner(db, project) {
  const User = db.models.User;
  const LoyaltyAccount = db.models.LoyaltyAccount;
  const LoyaltyTransaction = db.models.LoyaltyTransaction;

  const due = await LoyaltyTransaction.find({
    type: 'CREDIT',
    status: 'PENDING',
    availableAt: { $lte: new Date() }
  });

  if (!due.length) {
    console.log(`  [${project.project_code}] nothing due`);
    return;
  }
  console.log(`  [${project.project_code}] ${due.length} batch(es) becoming available`);

  for (const tx of due) {
    console.log(`    - ${tx.mobile}: +${tx.points} (order ${tx.metadata?.orderNumber || tx.referenceId})`);
    if (!apply) continue;

    const expiresAt = addMonths(tx.availableAt, EXPIRY_MONTHS);
    tx.status = 'COMPLETED';
    tx.remainingPoints = tx.points;
    tx.expiresAt = expiresAt;
    await tx.save();

    await LoyaltyAccount.updateOne(
      { _id: tx.loyaltyAccountId },
      { $inc: { pendingPoints: -tx.points, availablePoints: tx.points } }
    );

    const user = await User.findById(tx.userId);
    if (user) {
      await notifyLoyaltyEvent(user, {
        title: `${tx.points} points unlocked! ✨`,
        body: 'Your points are now available to redeem.',
        data: { loyaltyEventType: 'POINTS_UNLOCKED', transactionId: String(tx._id) },
        projectCode: project.project_code
      });
    }
  }
}

const run = async () => {
  console.log(apply ? '🚚 Applying pending-points promotion\n' : '🔍 Dry run — no writes (pass --apply)\n');
  await connectDB();

  const filter = { status: 'active' };
  if (onlyProject) filter.project_code = onlyProject.toUpperCase();
  const projects = await getProjectModel().find(filter).lean();

  for (const project of projects) {
    await processProject(project);
  }

  await disconnectDB();
  console.log('\nDone.');
};

run().catch((err) => {
  console.error('Pending-points promotion failed:', err);
  process.exit(1);
});
