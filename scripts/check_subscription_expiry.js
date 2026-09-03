// Daily subscription housekeeping, mirroring scripts/loyalty_expire_points.js:
//
//   1. Expiry flip - for each project's effective subscription (see
//      utils/subscription.js#getEffectiveSubscription), if its end_date has
//      passed and it is still marked 'active', flips status to 'expired'.
//      This is a display/notification convenience only - enforcement
//      (middleware/subscription.js) always computes expiry LIVE from
//      end_date and never trusts this field.
//   2. Expiry warnings - notifies each project's admin users once per
//      7/3/1-day threshold (tracked in notified_stages on the subscription
//      document itself, so a daily run never repeats a reminder).
//
// This codebase has no in-process scheduler; every background job here is a
// plain script meant to be invoked by an external OS cron/pm2 cron entry,
// same as every other scripts/*.js. Suggested cadence: daily.
//
//   node scripts/check_subscription_expiry.js                # dry run
//   node scripts/check_subscription_expiry.js --apply
//   node scripts/check_subscription_expiry.js --apply --project RET6978

require('dotenv').config();
const { connectDB, disconnectDB, getTenantDb, DEFAULT_DB_NAME } = require('../config/database');
const { getProjectModel } = require('../models/Project');
const { getEffectiveSubscription } = require('../utils/subscription');
const fcm = require('../utils/fcm');

const apply = process.argv.includes('--apply');
const projectArgIndex = process.argv.indexOf('--project');
const onlyProject = projectArgIndex !== -1 ? process.argv[projectArgIndex + 1] : null;

const WARNING_STAGES = [7, 3, 1]; // days before expiry

const summary = {
  projectsChecked: 0,
  expiredFlipped: 0,
  notificationsSent: 0,
};

// Admin accounts live in the admin home DB (config/database.js's
// DEFAULT_DB_NAME - see middleware/auth.js's findUserById fallback), not in
// each tenant's own DB, regardless of which project they administer.
const findAdminsToNotify = async (projectCode) => {
  const homeDb = getTenantDb(DEFAULT_DB_NAME);
  const HomeUser = homeDb.models.User;
  if (!HomeUser) return [];

  return HomeUser.find({
    role: 'admin',
    $or: [{ isSuperAdmin: true }, { allowed_project_codes: projectCode }],
    fcmToken: { $nin: [null, ''] },
  });
};

const notifyAdmins = async (project, stage) => {
  const admins = await findAdminsToNotify(project.project_code);
  const title = 'Subscription expiring soon';
  const body = `Your subscription for ${project.client_name} expires in ${stage} day${stage === 1 ? '' : 's'}.`;

  for (const admin of admins) {
    console.log(`    - notifying admin ${admin.mobile || admin._id}`);
    if (!apply) continue;

    try {
      await fcm.sendNotificationToUser(
        admin,
        title,
        body,
        { subscriptionEventType: 'SUBSCRIPTION_EXPIRING', projectCode: project.project_code },
        project.project_code
      );
      summary.notificationsSent += 1;
    } catch (error) {
      // A push failure must never fail the rest of the pass.
      console.error(`    Failed to notify admin ${admin.mobile || admin._id}:`, error.message);
    }
  }
};

const processProject = async (project) => {
  summary.projectsChecked += 1;

  const sub = await getEffectiveSubscription(project.project_code);
  if (!sub) {
    console.log(`  [${project.project_code}] no subscription configured — skipping`);
    return;
  }

  const now = new Date();

  if (sub.end_date < now && sub.status === 'active') {
    console.log(`  [${project.project_code}] expired ${sub.end_date.toDateString()} — flipping status to 'expired'`);
    if (apply) {
      sub.status = 'expired';
      await sub.save();
      summary.expiredFlipped += 1;
    }
  }

  for (const stage of WARNING_STAGES) {
    const msRemaining = new Date(sub.end_date).getTime() - now.getTime();
    const daysRemaining = Math.ceil(msRemaining / (24 * 60 * 60 * 1000));

    if (daysRemaining <= stage && daysRemaining > 0 && !sub.notified_stages.includes(stage)) {
      console.log(`  [${project.project_code}] ${daysRemaining}d remaining, crossed ${stage}d warning threshold`);
      await notifyAdmins(project, stage);

      if (apply) {
        sub.notified_stages.push(stage);
        await sub.save();
      }
    }
  }
};

const run = async () => {
  console.log(apply ? '🚚 Applying subscription expiry pass\n' : '🔍 Dry run — no writes (pass --apply)\n');
  await connectDB();

  const filter = { status: 'active' };
  if (onlyProject) filter.project_code = onlyProject.toUpperCase();
  const projects = await getProjectModel().find(filter).lean();

  for (const project of projects) {
    await processProject(project);
  }

  await disconnectDB();

  console.log('\nSummary:');
  console.log(`  Projects checked: ${summary.projectsChecked}`);
  console.log(`  Subscriptions flipped to expired: ${summary.expiredFlipped}`);
  console.log(`  Notifications sent: ${summary.notificationsSent}`);
  console.log('\nDone.');
};

run().catch((err) => {
  console.error('Subscription expiry pass failed:', err);
  process.exit(1);
});
