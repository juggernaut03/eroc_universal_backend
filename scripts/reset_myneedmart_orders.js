/**
 * Deletes every My Need Mart (RET6978) order, plus the customer and admin
 * notifications about them (type: 'order'), and resets its order_number
 * counter so the next order placed is 0001. Loyalty data is left alone.
 *
 * Only RET6978's tenant DB is touched — every tenant has its own DB and its
 * own 'order_number' counter (see Order.generateOrderNumber / Counter.js),
 * so no other tenant's orders or numbering are affected.
 *
 * Before deleting, everything removed is exported as JSON to backups/ so it
 * can be restored if needed.
 *
 *   node scripts/reset_myneedmart_orders.js            # dry run (counts only)
 *   node scripts/reset_myneedmart_orders.js --apply
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { getProjectModel } = require('../models/Project');

const PROJECT_CODE = 'RET6978';
const apply = process.argv.includes('--apply');

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
  const orders = db.collection('orders');
  const counters = db.collection('counters');
  // Customer (models/Notification.js) and admin (models/AdminNotification.js)
  // notifications that point at these orders by number.
  const notificationCollections = ['notifications', 'adminnotifications'];
  const ORDER_NOTIFICATION = { type: 'order' };

  const orderCount = await orders.countDocuments();
  const counter = await counters.findOne({ name: 'order_number' });
  const sample = await orders
    .find({}, { projection: { order_number: 1, order_status: 1, mobile_no: 1, order_placed_at: 1 } })
    .sort({ order_placed_at: -1 })
    .limit(10)
    .toArray();

  console.log(`  orders:               ${orderCount}`);
  for (const name of notificationCollections) {
    const n = await db.collection(name).countDocuments(ORDER_NOTIFICATION);
    console.log(`  ${name} (order):`.padEnd(24) + n);
  }
  console.log(`  order_number counter: ${counter ? counter.sequence_value : '(none)'}`);
  console.log('  latest orders:');
  sample.forEach((o) =>
    console.log(`    #${o.order_number}  ${o.order_status}  ${o.mobile_no}  ${o.order_placed_at?.toISOString?.() || ''}`)
  );

  if (!apply) {
    console.log('\nDry run — nothing changed. Re-run with --apply to delete and reset.');
    await disconnectDB();
    return;
  }

  const backup = { orders: await orders.find({}).toArray(), counter };
  for (const name of notificationCollections) {
    backup[name] = await db.collection(name).find(ORDER_NOTIFICATION).toArray();
  }
  const backupDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(
    backupDir,
    `${PROJECT_CODE}_orders_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  console.log(`\n✔ Backed up ${backup.orders.length} orders + order notifications → ${backupFile}`);

  const { deletedCount } = await orders.deleteMany({});
  console.log(`✔ Deleted ${deletedCount} orders`);
  for (const name of notificationCollections) {
    const res = await db.collection(name).deleteMany(ORDER_NOTIFICATION);
    console.log(`✔ Deleted ${res.deletedCount} ${name} (order)`);
  }

  await counters.updateOne(
    { name: 'order_number' },
    { $set: { sequence_value: 0, updatedAt: new Date() } },
    { upsert: true }
  );
  console.log('✔ order_number counter reset to 0 — next order will be 0001');

  await disconnectDB();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDB();
  process.exit(1);
});
