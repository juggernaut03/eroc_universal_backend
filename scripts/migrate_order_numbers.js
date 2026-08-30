/**
 * Migration script: renumber existing orders into the new sequential format.
 *
 *   ORD2608300005  ->  0001, 0002, 0003, ...
 *
 * Runs once per registered tenant project (models/Project.js — the control-DB
 * registry, NOT a scan of every database on the shared Mongo cluster: the
 * cluster also hosts unrelated systems with their own "orders" collection,
 * e.g. a separate picker/delivery app in `picker_db`, which a blanket scan
 * would incorrectly try to renumber too). Numbering is a single sequence per
 * tenant DB, global across every store — matches models/Order.js's
 * generateOrderNumber(), which reserves new numbers from the same per-tenant
 * `counters` collection (name: 'order_number') via Counter.getNextSequence.
 *
 * Orders are renumbered in chronological order (order_placed_at ascending,
 * _id ascending as a tiebreaker) so order #1 is the tenant's actual first
 * order. After renumbering, the `order_number` counter is reset to the
 * final count so the next live order continues the sequence with no gap or
 * collision — this also correctly re-numbers any order already placed after
 * the code switch to the new scheme (which would otherwise sit at "0001"
 * out of chronological place).
 *
 * Runs as two passes per tenant to avoid ever colliding with the
 * `order_number` unique index mid-migration: first every order's number is
 * moved to a temporary value guaranteed not to collide with any final
 * target value, then every order is set to its real new number. A
 * single-pass update could otherwise briefly assign one order the number
 * another order currently holds.
 *
 * Idempotent to run twice in a row (recomputes the same chronological
 * order and the same final numbers), but NOT safe to run again after new
 * orders have been placed in between two runs — that would renumber
 * everything again from #1, invalidating numbers already told to
 * customers. Run this once, right after deploying the new
 * generateOrderNumber(), before normal traffic resumes.
 *
 * Reads are the default. Nothing is written without --apply:
 *   node scripts/migrate_order_numbers.js                    # dry run, all tenants
 *   node scripts/migrate_order_numbers.js --apply             # performs the renumber
 *   node scripts/migrate_order_numbers.js --apply --project RET6978
 */

require('dotenv').config();
const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { als } = require('../config/tenantContext');
const { getProjectModel } = require('../models/Project');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const projectFlagIndex = args.indexOf('--project');
const onlyProject = projectFlagIndex !== -1 ? args[projectFlagIndex + 1] : null;

const WIDTH = 4;

async function processProject(project) {
  const db = getTenantDb(project.db_name);

  return als.run({ connection: db, project }, async () => {
    const collections = await db.db.listCollections({ name: 'orders' }).toArray();
    if (collections.length === 0) {
      console.log(`[${project.project_code}] no orders collection, skipping`);
      return 0;
    }

    const orders = db.db.collection('orders');

    const chronological = await orders
      .find({}, { projection: { _id: 1, order_number: 1 } })
      .sort({ order_placed_at: 1, _id: 1 })
      .toArray();

    if (chronological.length === 0) {
      console.log(`[${project.project_code}] nothing to migrate`);
      return 0;
    }

    const plan = chronological.map((order, index) => ({
      _id: order._id,
      from: order.order_number,
      to: String(index + 1).padStart(WIDTH, '0'),
    }));

    const changed = plan.filter((p) => p.from !== p.to);

    console.log(`[${project.project_code}] ${apply ? 'renumbering' : 'would renumber'} ${changed.length} of ${plan.length} order(s)`);
    changed.slice(0, 5).forEach((p) => console.log(`  ${p.from} -> ${p.to}`));
    if (changed.length > 5) console.log(`  ... and ${changed.length - 5} more`);

    if (apply && changed.length > 0) {
      // Phase 1: move every order to a collision-proof temporary number.
      const tempOps = plan.map((p) => ({
        updateOne: {
          filter: { _id: p._id },
          update: { $set: { order_number: `TMP-${p._id}` } },
        },
      }));
      await orders.bulkWrite(tempOps, { ordered: false });

      // Phase 2: assign the real, final sequential numbers.
      const finalOps = plan.map((p) => ({
        updateOne: {
          filter: { _id: p._id },
          update: { $set: { order_number: p.to, last_updated_at: new Date() } },
        },
      }));
      await orders.bulkWrite(finalOps, { ordered: false });

      // Keep the live counter in sync so the next placed order continues
      // the sequence with no gap or collision.
      const counters = db.db.collection('counters');
      await counters.updateOne(
        { name: 'order_number' },
        { $set: { sequence_value: plan.length } },
        { upsert: true }
      );
    }

    return changed.length;
  });
}

async function migrate() {
  console.log(apply ? '🚚 Applying order number migration\n' : '🔍 Dry run — no writes (pass --apply to migrate)\n');
  await connectDB();

  let totalRenumbered = 0;

  try {
    const filter = {};
    if (onlyProject) filter.project_code = onlyProject.toUpperCase();
    const projects = await getProjectModel().find(filter).lean();

    for (const project of projects) {
      // eslint-disable-next-line no-await-in-loop
      totalRenumbered += await processProject(project);
    }

    console.log(`\n${apply ? '✅ Renumbered' : 'Would renumber'} ${totalRenumbered} order(s) in total.`);
    if (!apply && totalRenumbered > 0) {
      console.log('Re-run with --apply to write the changes.');
    }
  } finally {
    await disconnectDB();
  }
}

migrate()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  });
