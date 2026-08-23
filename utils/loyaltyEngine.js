/**
 * Loyalty points ledger engine.
 *
 * Every function here that changes a balance writes a LoyaltyTransaction row
 * first and derives LoyaltyAccount's cached totals from it - the ledger is
 * the source of truth, the account document is a read-optimized cache of it
 * (loyalty_rewards_frd.md section 25/84 principle #1: "ledger-first").
 *
 * Idempotency: every credit/debit/reversal takes an `idempotencyKey` unique
 * across the tenant. Re-processing the same event (a retried order-status
 * webhook, a re-run script) throws a duplicate-key error on the second
 * attempt instead of double-crediting - callers should treat that specific
 * error as "already processed", not as a failure. See isDuplicateKeyError().
 */

const mongoose = require('mongoose');
const { getTenantConnection } = require('../config/tenantContext');
const LoyaltyAccount = require('../models/LoyaltyAccount');
const LoyaltyTransaction = require('../models/LoyaltyTransaction');

const isDuplicateKeyError = (error) => error && error.code === 11000;

const isTransactionUnsupported = (error) =>
  /Transaction numbers are only allowed|transactions are not supported|replica set/i.test(
    error?.message || ''
  );

/**
 * Run `work` inside a MongoDB transaction where the deployment supports one,
 * otherwise run it without one. Mirrors utils/orderService.js's
 * runAtomically - duplicated rather than imported to avoid a circular
 * require (orderService will call into this module for the order-delivered
 * hook).
 */
const runAtomically = async (work) => {
  let session;
  try {
    session = await getTenantConnection().startSession();
  } catch (error) {
    console.warn(`[loyalty] Could not start a session (${error.message}) — writing without a transaction.`);
    return work(null);
  }

  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    if (isTransactionUnsupported(error)) {
      console.warn('[loyalty] Transactions unavailable on this deployment — writing without one.');
      return work(null);
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

const genReferralCode = (mobile) => {
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${mobile.slice(-4)}${suffix}`;
};

/**
 * Find this customer's loyalty account, creating one on first touch. Safe to
 * call from any hook that only knows a User document.
 */
const getOrCreateAccount = async (user, session = null) => {
  let account = await LoyaltyAccount.findOne({ mobile: user.mobile }).session(session);
  if (account) {
    // Self-healing: an account that somehow never got a tier (e.g. created
    // before any LoyaltyTier existed) picks one up on next read rather than
    // showing `tier: null` forever.
    if (!account.currentTierCode) {
      // Required lazily to avoid a hard top-level dependency for the common
      // (already-tiered) path - no circular require risk, loyaltyTierEngine
      // never imports this module.
      const { recalculateTier } = require('./loyaltyTierEngine');
      await recalculateTier(account, session);
    }
    return account;
  }

  // Two concurrent first-touches (e.g. a registration event and an order
  // event racing) both attempt to create - upsert makes the loser of the
  // race just re-read what the winner created instead of erroring.
  let referralCode = genReferralCode(user.mobile);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const created = await LoyaltyAccount.findOneAndUpdate(
        { mobile: user.mobile },
        {
          $setOnInsert: {
            userId: user._id,
            mobile: user.mobile,
            availablePoints: 0,
            pendingPoints: 0,
            referralCode
          }
        },
        { new: true, upsert: true, session }
      );
      const { recalculateTier } = require('./loyaltyTierEngine');
      await recalculateTier(created, session);
      return created;
    } catch (error) {
      if (isDuplicateKeyError(error) && /referralCode/.test(error.message)) {
        // Referral code collision (astronomically unlikely) - regenerate and
        // retry rather than fail account creation over a display string.
        referralCode = genReferralCode(user.mobile);
        continue;
      }
      if (isDuplicateKeyError(error)) {
        account = await LoyaltyAccount.findOne({ mobile: user.mobile }).session(session);
        if (account) return account;
      }
      throw error;
    }
  }
  throw new Error('Could not allocate a unique referral code');
};

/**
 * Credit points to a customer's account.
 *
 * @param {object} params
 * @param {object} params.user - User document (needs _id, mobile)
 * @param {number} params.points - magnitude, must be > 0
 * @param {'ORDER'|'REVIEW'|'REFERRAL'|'BIRTHDAY'|'REGISTRATION'|'CAMPAIGN'|'CHALLENGE'|'ADMIN'} params.source
 * @param {string} params.idempotencyKey - unique per event, see module doc
 * @param {string} [params.referenceId]
 * @param {object} [params.metadata]
 * @param {'PENDING'|'COMPLETED'} [params.status='COMPLETED']
 * @param {Date} [params.availableAt] - required if status is PENDING
 * @param {Date} [params.expiresAt] - when this batch stops being spendable
 * @returns {Promise<{account: object, transaction: object}|{duplicate: true}>}
 */
const creditPoints = async ({
  user, points, source, idempotencyKey, referenceId = null, metadata = {},
  status = 'COMPLETED', availableAt = null, expiresAt = null
}) => {
  if (!(points > 0)) throw new Error('creditPoints: points must be a positive number');
  if (!idempotencyKey) throw new Error('creditPoints: idempotencyKey is required');
  if (status === 'PENDING' && !availableAt) {
    throw new Error('creditPoints: availableAt is required for PENDING credits');
  }

  try {
    return await runAtomically(async (session) => {
      const account = await getOrCreateAccount(user, session);

      const balanceBefore = account.availablePoints;
      // A PENDING credit doesn't touch availablePoints yet - only pendingPoints.
      const balanceAfter = status === 'COMPLETED' ? balanceBefore + points : balanceBefore;

      const [transaction] = await LoyaltyTransaction.create([{
        userId: user._id,
        mobile: user.mobile,
        loyaltyAccountId: account._id,
        type: 'CREDIT',
        source,
        points,
        remainingPoints: status === 'COMPLETED' ? points : 0,
        balanceBefore,
        balanceAfter,
        referenceId,
        idempotencyKey,
        metadata,
        status,
        availableAt,
        expiresAt
      }], { session });

      const update = { $inc: { lifetimeEarnedPoints: points } };
      if (status === 'COMPLETED') {
        update.$inc.availablePoints = points;
      } else {
        update.$inc.pendingPoints = points;
      }
      await LoyaltyAccount.updateOne({ _id: account._id }, update, { session });

      const refreshed = await LoyaltyAccount.findById(account._id).session(session);
      return { account: refreshed, transaction };
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Same event already processed - not an error for the caller.
      return { duplicate: true };
    }
    throw error;
  }
};

/**
 * Debit points from a customer's account (redemption or manual deduction).
 * Consumes from CREDIT batches oldest-expiry-first so expiry accounting
 * stays correct (see remainingPoints doc on the LoyaltyTransaction model).
 *
 * Throws Error('INSUFFICIENT_POINTS') if the account doesn't have enough
 * available balance - callers should map that to a 4xx, not a 500.
 */
const debitPoints = async ({
  user, points, source, idempotencyKey, referenceId = null, metadata = {}
}) => {
  if (!(points > 0)) throw new Error('debitPoints: points must be a positive number');
  if (!idempotencyKey) throw new Error('debitPoints: idempotencyKey is required');

  try {
    return await runAtomically(async (session) => {
      const account = await getOrCreateAccount(user, session);

      if (account.availablePoints < points) {
        const err = new Error('INSUFFICIENT_POINTS');
        err.code = 'INSUFFICIENT_POINTS';
        throw err;
      }

      const balanceBefore = account.availablePoints;
      const balanceAfter = balanceBefore - points;

      // Idempotency gate FIRST, before touching anything else. This used to
      // run after the batch-consumption loop below, which mutates and saves
      // each CREDIT batch's remainingPoints immediately (no real transaction
      // on this deployment, so nothing here rolls back on a later failure).
      // A retried call with the same idempotencyKey - a normal thing for a
      // mobile client to do on a timeout, and exactly what happened testing
      // this - re-ran that loop and decremented remainingPoints a second
      // time for points that were never actually re-debited from the
      // account (this insert's duplicate-key error stopped it from ever
      // reaching the account update below), silently pulling the ledger out
      // of sync with the account's cached balance. Creating this row first
      // means a duplicate is rejected before it can touch a single batch.
      const [transaction] = await LoyaltyTransaction.create([{
        userId: user._id,
        mobile: user.mobile,
        loyaltyAccountId: account._id,
        type: 'DEBIT',
        source,
        points,
        balanceBefore,
        balanceAfter,
        referenceId,
        idempotencyKey,
        metadata,
        status: 'COMPLETED'
      }], { session });

      // Consume oldest-expiring batches first.
      const batches = await LoyaltyTransaction.find({
        mobile: user.mobile,
        type: 'CREDIT',
        status: 'COMPLETED',
        remainingPoints: { $gt: 0 }
      }).sort({ expiresAt: 1 }).session(session);

      let remaining = points;
      for (const batch of batches) {
        if (remaining <= 0) break;
        const take = Math.min(batch.remainingPoints, remaining);
        batch.remainingPoints -= take;
        await batch.save({ session });
        remaining -= take;
      }
      // remaining > 0 here would mean the batches don't cover
      // account.availablePoints - a bookkeeping bug elsewhere, not a normal
      // insufficient-funds case (already checked above). Surface it loudly
      // rather than silently letting the ledger drift from the cache. The
      // DEBIT row above and the account update below have already run by
      // this point, so this no longer prevents the debit itself - it's a
      // signal for scripts/loyalty_reconcile_ledger.js to find and fix, not
      // a transaction abort (this deployment can't abort one anyway).
      if (remaining > 0) {
        console.error(
          `[loyalty] ledger inconsistency for ${user.mobile}: ${remaining} points unaccounted for by CREDIT batches (debit tx ${transaction._id})`
        );
      }

      await LoyaltyAccount.updateOne(
        { _id: account._id },
        { $inc: { availablePoints: -points, lifetimeRedeemedPoints: points } },
        { session }
      );

      const refreshed = await LoyaltyAccount.findById(account._id).session(session);
      return { account: refreshed, transaction };
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { duplicate: true };
    }
    throw error;
  }
};

/**
 * Reverse a previously-credited transaction (order cancelled/refunded,
 * fraudulent review, invalid referral, admin correction). Never mutates or
 * deletes the original row - creates a new REVERSAL row and adjusts the
 * account (loyalty_rewards_frd.md section 24: "Never delete the original
 * transaction").
 *
 * Handles both cases:
 *  - original was still PENDING (never became spendable): pull from
 *    pendingPoints, nothing was ever available to have been spent.
 *  - original was COMPLETED: pull from availablePoints, but only up to
 *    whatever of that batch is still unspent (remainingPoints) - if the
 *    customer already redeemed points that happened to come from this
 *    batch, we can't claw back points they no longer hold, so the reversal
 *    is capped at what's left, and the shortfall is recorded in metadata for
 *    admin visibility rather than silently ignored.
 */
const reverseTransaction = async ({ originalTransactionId, reason, idempotencyKey }) => {
  if (!idempotencyKey) throw new Error('reverseTransaction: idempotencyKey is required');

  try {
    return await runAtomically(async (session) => {
      const original = await LoyaltyTransaction.findById(originalTransactionId).session(session);
      if (!original) throw new Error('Original transaction not found');
      if (original.type !== 'CREDIT') {
        throw new Error('Only CREDIT transactions can be reversed');
      }

      const account = await LoyaltyAccount.findById(original.loyaltyAccountId).session(session);
      if (!account) throw new Error('Loyalty account not found for reversal');

      const balanceBefore = account.availablePoints;
      let reversedPoints;
      let alreadySpent = 0;
      const accountInc = {};

      if (original.status === 'PENDING') {
        // Never became spendable, so all of it is reclaimable.
        reversedPoints = original.points;
        accountInc.pendingPoints = -reversedPoints;
      } else {
        // Whatever the customer already spent from this batch (via a debit
        // or a prior expiry run) is gone - only claw back what's left in it.
        alreadySpent = original.points - original.remainingPoints;
        reversedPoints = original.remainingPoints;
        accountInc.availablePoints = -reversedPoints;
        original.remainingPoints = 0;
        await original.save({ session });
      }

      const [transaction] = await LoyaltyTransaction.create([{
        userId: original.userId,
        mobile: original.mobile,
        loyaltyAccountId: account._id,
        type: 'REVERSAL',
        source: original.source,
        points: reversedPoints,
        balanceBefore,
        balanceAfter: original.status === 'PENDING' ? balanceBefore : balanceBefore - reversedPoints,
        referenceId: original.referenceId,
        idempotencyKey,
        metadata: {
          reason,
          originalTransactionId: String(original._id),
          originalPoints: original.points,
          alreadySpent
        },
        status: 'COMPLETED'
      }], { session });

      accountInc.lifetimeReversedPoints = reversedPoints;
      await LoyaltyAccount.updateOne({ _id: account._id }, { $inc: accountInc }, { session });

      const refreshed = await LoyaltyAccount.findById(account._id).session(session);
      return { account: refreshed, transaction, fullyReversed: alreadySpent === 0 };
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { duplicate: true };
    }
    throw error;
  }
};

/**
 * Base -> tier multiplier -> campaign multiplier -> cap, per
 * loyalty_rewards_frd.md section 21. Multipliers apply on top of the rule's
 * own `multiplier` (kept separate so "1.5x base rate this rule always pays"
 * and "1.5x because this customer is Gold" are independently configurable
 * and both show up distinctly in a redemption's metadata for support).
 */
const calculatePoints = ({ rule, orderAmount, tierMultiplier = 1, campaignMultiplier = 1 }) => {
  if (orderAmount < (rule.minimumOrderValue || 0)) return 0;

  let base;
  if (rule.pointsType === 'FIXED_PER_AMOUNT') {
    base = Math.floor((orderAmount / rule.amountValue) * rule.pointsValue);
  } else {
    base = rule.pointsValue;
  }

  let points = Math.floor(base * (rule.multiplier || 1) * tierMultiplier * campaignMultiplier);

  if (rule.maximumPoints != null) {
    points = Math.min(points, rule.maximumPoints);
  }
  return Math.max(0, points);
};

module.exports = {
  runAtomically,
  getOrCreateAccount,
  creditPoints,
  debitPoints,
  reverseTransaction,
  calculatePoints,
  isDuplicateKeyError
};
