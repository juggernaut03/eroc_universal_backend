/**
 * Deletes every My Need Mart (RET6978) app customer and all data tied to
 * them: logins, profiles, addresses, carts, wishlists, push tokens,
 * notifications and all loyalty data. Store setup (products, banners,
 * loyalty rules/tiers/rewards, settings) and anonymous home_section_events
 * stats are left alone.
 *
 * Only RET6978's tenant DB is touched. Admin logins don't live in the
 * tenant 'users' collection (every user there is role: 'user'); the script
 * refuses to run if that ever stops being true.
 *
 * Before deleting, everything removed is exported as JSON to backups/.
 *
 *   node scripts/reset_myneedmart_users.js            # dry run (counts only)
 *   node scripts/reset_myneedmart_users.js --apply
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { getProjectModel } = require('../models/Project');

const PROJECT_CODE = 'RET6978';
const apply = process.argv.includes('--apply');

// Every collection here is per-customer data; each is emptied entirely.
const CUSTOMER_COLLECTIONS = [
  'users',
  'customerprofiles',
  'addressbooks',
  'addresses',
  'carts',
  'shoppingcarts',
  'favoritemasters',
  'userdevicetokens',
  'notifications',
  'loyalty_accounts',
  'loyalty_transactions',
  'loyalty_redemptions',
  'loyalty_referrals',
  'loyalty_challenge_progress',
  'loyalty_audit_logs',
];

async function main() {
  await connectDB();

  const project = await getProjectModel().findOne({ project_code: PROJECT_CODE }).lean();
  if (!project) {
    console.error(`✘ Project ${PROJECT_CODE} not found`);
    await disconnectDB();
    process.exit(1);
  }
  console.log(`✔ Project ${PROJECT_CODE} → ${project.db_name} (${project.client_name})`);

  const db = getTenantDb(project.db_name).db;

  const nonCustomers = await db.collection('users').countDocuments({
    $or: [{ role: { $ne: 'user' } }, { isSuperAdmin: true }],
  });
  if (nonCustomers > 0) {
    console.error(`✘ ${nonCustomers} non-customer user(s) found in users — refusing to run`);
    await disconnectDB();
    process.exit(1);
  }

  for (const name of CUSTOMER_COLLECTIONS) {
    console.log(`  ${name}:`.padEnd(32) + (await db.collection(name).countDocuments()));
  }

  if (!apply) {
    console.log('\nDry run — nothing changed. Re-run with --apply to delete.');
    await disconnectDB();
    return;
  }

  const backup = {};
  for (const name of CUSTOMER_COLLECTIONS) {
    backup[name] = await db.collection(name).find({}).toArray();
  }
  const backupDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(
    backupDir,
    `${PROJECT_CODE}_users_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  console.log(`\n✔ Backed up customer data → ${backupFile}`);

  for (const name of CUSTOMER_COLLECTIONS) {
    const { deletedCount } = await db.collection(name).deleteMany({});
    console.log(`✔ Deleted ${deletedCount} ${name}`);
  }

  await disconnectDB();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDB();
  process.exit(1);
});
