// Reports moved off the borrowed 'orders' permission section onto its own
// 'reports' section (routes/admin/reports.js, models/User.js). Without this,
// every existing admin who currently sees Reports because they have Orders
// access would lose it the moment the route switched to checking 'reports'
// instead — the new section defaults to false for everyone until granted.
//
// For every non-super-admin admin user, copies their current
// permissions.orders into permissions.reports, so access is unchanged the
// moment this runs; a super admin can then adjust the two independently from
// Admin Permissions in the panel going forward. Super admins are untouched —
// they bypass permission checks entirely (isSuperAdmin), so the field would
// never be read for them anyway.
//
// Admin accounts live in the admin-home DB only (routes/admin/permissions.js
// — HomeUser = getTenantDb(DEFAULT_DB_NAME).models.User), not per-tenant, so
// this touches exactly one database.
//
// Idempotent: re-running just re-copies the current orders value.
//
//   node scripts/add_reports_permission.js            # dry run
//   node scripts/add_reports_permission.js --apply

require('dotenv').config();
const { connectDB, disconnectDB, getTenantDb, DEFAULT_DB_NAME } = require('../config/database');
require('../models/User');

const apply = process.argv.includes('--apply');

const run = async () => {
  console.log(apply ? '🚚 Applying reports permission migration\n' : '🔍 Dry run — no writes (pass --apply to migrate)\n');

  await connectDB();

  const db = getTenantDb(DEFAULT_DB_NAME);
  const User = db.models.User;

  const admins = await User.find({ role: 'admin', isSuperAdmin: { $ne: true } });
  console.log(`Found ${admins.length} non-super-admin admin(s) in ${DEFAULT_DB_NAME}\n`);

  for (const admin of admins) {
    const ordersView = admin.permissions?.orders?.view || false;
    const current = admin.permissions?.reports?.view || false;

    console.log(
      `  ${admin.name || admin.mobile}: orders.view=${ordersView} -> reports.view=${ordersView}` +
      (current === ordersView ? ' (unchanged)' : ` (was ${current})`)
    );

    if (apply) {
      admin.permissions.reports = {
        view: ordersView,
        create: admin.permissions?.orders?.create || false,
        edit: admin.permissions?.orders?.edit || false,
        delete: admin.permissions?.orders?.delete || false,
      };
      admin.markModified('permissions');
      await admin.save();
    }
  }

  await disconnectDB();
  console.log('\nDone.');
};

run().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
