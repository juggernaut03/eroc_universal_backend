// Two passes over every tenant's loyalty ledger, run together since they
// share the same "which CREDIT batches are near/at their expiresAt" scan:
//
//   1. Reminders - notifies customers whose points cross the 30/7/1-day
//      warning thresholds (loyalty_rewards_frd.md section 23), once per
//      threshold per batch (tracked in notifiedExpiryStages so a daily run
//      doesn't repeat the same reminder).
//   2. Expiry - for CREDIT batches whose expiresAt has passed with
//      remainingPoints still > 0, creates an EXPIRATION ledger row for
//      whatever's left in that batch and decrements the account balance.
//      Never touches the original CREDIT row beyond zeroing
//      remainingPoints - the ledger keeps the full history
//      (loyalty_rewards_frd.md section 22).
//
// This codebase has no in-process scheduler (no node-cron/agenda - see
// investigation notes); every background job here is a plain script meant
// to be invoked by an external OS cron/pm2 cron entry, same as every other
// scripts/*.js in this repo. Suggested cadence: daily.
//
//   node scripts/loyalty_expire_points.js                # dry run
//   node scripts/loyalty_expire_points.js --apply
//   node scripts/loyalty_expire_points.js --apply --project RET6978

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

const REMINDER_STAGES = [30, 7, 1]; // days before expiry

async function sendReminders(project, db) {
  const User = db.models.User;
  const LoyaltyTransaction = db.models.LoyaltyTransaction;
  const now = new Date();

  for (const stage of REMINDER_STAGES) {
    const windowEnd = new Date(now.getTime() + stage * 24 * 60 * 60 * 1000);
    const due = await LoyaltyTransaction.find({
      type: 'CREDIT',
      status: 'COMPLETED',
      remainingPoints: { $gt: 0 },
      expiresAt: { $gt: now, $lte: windowEnd },
      notifiedExpiryStages: { $ne: stage }
    });

    for (const tx of due) {
      console.log(`  [${project.project_code}] reminder(${stage}d): ${tx.mobile} — ${tx.remainingPoints} pts expiring ${tx.expiresAt.toDateString()}`);
      if (!apply) continue;

      const user = await User.findById(tx.userId);
      if (user) {
        await notifyLoyaltyEvent(user, {
          title: `${tx.remainingPoints} points expiring in ${stage} day${stage === 1 ? '' : 's'}`,
          body: 'Redeem them before they expire!',
          data: { loyaltyEventType: 'POINTS_EXPIRING', transactionId: String(tx._id) },
          projectCode: project.project_code
        });
      }
      tx.notifiedExpiryStages.push(stage);
      await tx.save();
    }
  }
}

async function expirePoints(project, db) {
  const User = db.models.User;
  const LoyaltyAccount = db.models.LoyaltyAccount;
  const LoyaltyTransaction = db.models.LoyaltyTransaction;
  const now = new Date();

  const expired = await LoyaltyTransaction.find({
    type: 'CREDIT',
    status: 'COMPLETED',
    remainingPoints: { $gt: 0 },
    expiresAt: { $lte: now }
  });

  if (!expired.length) {
    console.log(`  [${project.project_code}] nothing to expire`);
    return;
  }
  console.log(`  [${project.project_code}] ${expired.length} batch(es) expiring`);

  for (const original of expired) {
    const amount = original.remainingPoints;
    console.log(`    - ${original.mobile}: -${amount} (earned ${original.createdAt.toDateString()})`);
    if (!apply) continue;

    const account = await LoyaltyAccount.findById(original.loyaltyAccountId);
    if (!account) continue;
    const balanceBefore = account.availablePoints;

    original.remainingPoints = 0;
    await original.save();

    await LoyaltyTransaction.create({
      userId: original.userId,
      mobile: original.mobile,
      loyaltyAccountId: original.loyaltyAccountId,
      type: 'EXPIRATION',
      source: original.source,
      points: amount,
      balanceBefore,
      balanceAfter: balanceBefore - amount,
      referenceId: original.referenceId,
      idempotencyKey: `${original.idempotencyKey}_EXPIRED`,
      metadata: { originalTransactionId: String(original._id) },
      status: 'COMPLETED'
    });

    await LoyaltyAccount.updateOne(
      { _id: account._id },
      { $inc: { availablePoints: -amount, lifetimeExpiredPoints: amount } }
    );

    const user = await User.findById(original.userId);
    if (user) {
      await notifyLoyaltyEvent(user, {
        title: `${amount} points have expired`,
        body: 'Shop again soon to keep earning!',
        data: { loyaltyEventType: 'POINTS_EXPIRED', transactionId: String(original._id) },
        projectCode: project.project_code
      });
    }
  }
}

async function processProject(project) {
  const db = getTenantDb(project.db_name);
  // notifyLoyaltyEvent() -> Notification.create() goes through the
  // ALS-Proxy model (models/tenantModel.js), which resolves the DB from the
  // async-local tenant context, not from `db` directly - without this, it
  // would silently write to the fallback (default) tenant DB instead.
  return als.run({ connection: db, project }, async () => {
    await sendReminders(project, db);
    await expirePoints(project, db);
  });
}

const run = async () => {
  console.log(apply ? '🚚 Applying loyalty expiry pass\n' : '🔍 Dry run — no writes (pass --apply)\n');
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
  console.error('Loyalty expiry pass failed:', err);
  process.exit(1);
});
