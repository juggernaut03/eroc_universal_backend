/**
 * Migration script: rename order statuses to the admin-panel vocabulary.
 *
 *   placed     -> pending
 *   confirmed  -> accepted
 *   processing -> accepted_by_store
 *   packed     -> in_packaging
 *   shipped    -> out_for_delivery
 *   refunded   -> cancelled
 *
 * Runs across every tenant database on the cluster, since orders live in
 * per-tenant DBs (see config/tenantContext.js), not in the connection's
 * default database.
 *
 * Idempotent: re-running finds nothing left to rename.
 *
 * Reads are the default. Nothing is written without --apply:
 *   node scripts/migrate_order_statuses.js            # dry run, prints the plan
 *   node scripts/migrate_order_statuses.js --apply    # performs the rename
 *   node scripts/migrate_order_statuses.js --apply --db tenant_grahakpeth
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { LEGACY_STATUS_MAP } = require('../constants/orderStatus');

const SYSTEM_DBS = ['admin', 'local', 'config'];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbFlagIndex = args.indexOf('--db');
const onlyDb = dbFlagIndex !== -1 ? args[dbFlagIndex + 1] : null;

async function listTargetDatabases(connection) {
  if (onlyDb) return [onlyDb];

  const { databases } = await connection.db.admin().listDatabases();
  return databases.map((d) => d.name).filter((name) => !SYSTEM_DBS.includes(name));
}

async function migrate() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not set');
  }

  const connection = await mongoose.createConnection(process.env.MONGODB_URI).asPromise();

  console.log(apply ? '🚚 Applying order status migration\n' : '🔍 Dry run — no writes (pass --apply to migrate)\n');

  let totalRenamed = 0;

  try {
    const databases = await listTargetDatabases(connection);

    for (const dbName of databases) {
      const db = connection.useDb(dbName, { useCache: true }).db;

      const collections = await db.listCollections({ name: 'orders' }).toArray();
      if (collections.length === 0) continue;

      const orders = db.collection('orders');
      const lines = [];
      let dbRenamed = 0;

      for (const [legacy, current] of Object.entries(LEGACY_STATUS_MAP)) {
        const count = await orders.countDocuments({ order_status: legacy });
        if (count === 0) continue;

        lines.push(`  ${legacy} -> ${current}: ${count}`);
        dbRenamed += count;

        if (apply) {
          await orders.updateMany(
            { order_status: legacy },
            { $set: { order_status: current, last_updated_at: new Date() } }
          );
        }
      }

      if (dbRenamed === 0) {
        console.log(`[${dbName}] nothing to migrate`);
        continue;
      }

      console.log(`[${dbName}] ${apply ? 'migrated' : 'would migrate'} ${dbRenamed} order(s)`);
      lines.forEach((line) => console.log(line));
      totalRenamed += dbRenamed;
    }

    console.log(`\n${apply ? '✅ Migrated' : 'Would migrate'} ${totalRenamed} order(s) in total.`);
    if (!apply && totalRenamed > 0) {
      console.log('Re-run with --apply to write the changes.');
    }
  } finally {
    await connection.close();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  });
