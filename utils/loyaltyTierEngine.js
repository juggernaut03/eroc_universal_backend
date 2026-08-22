/**
 * VIP tier calculation. Tier is derived from eligibleLifetimeSpend, never
 * from current point balance (loyalty_rewards_frd.md section 16) - spending
 * points on a reward must never demote a customer.
 */

const LoyaltyTier = require('../models/LoyaltyTier');
const LoyaltyAccount = require('../models/LoyaltyAccount');

/** All ACTIVE tiers, ascending by rank. Cheap enough to not bother caching. */
const getActiveTiers = () => LoyaltyTier.find({ status: 'ACTIVE' }).sort({ rank: 1 });

const getTierMultiplier = async (tierCode) => {
  if (!tierCode) return 1;
  const tier = await LoyaltyTier.findOne({ code: tierCode, status: 'ACTIVE' });
  return tier ? tier.pointMultiplier : 1;
};

/**
 * Recalculates and persists currentTierCode + tierProgress on an account
 * from its current eligibleLifetimeSpend. Returns {upgraded, downgraded,
 * previousTierCode, newTierCode} so callers can decide whether to notify.
 */
const recalculateTier = async (account, session = null) => {
  const tiers = await getActiveTiers().session(session);
  if (!tiers.length) {
    return { upgraded: false, downgraded: false, previousTierCode: account.currentTierCode, newTierCode: account.currentTierCode };
  }

  const spend = account.eligibleLifetimeSpend || 0;

  // Highest tier whose minimumSpend the account has reached.
  let matched = tiers[0];
  for (const tier of tiers) {
    if (spend >= tier.minimumSpend) matched = tier;
  }

  const currentIndex = tiers.findIndex((t) => t.code === matched.code);
  const next = tiers[currentIndex + 1] || null;

  const previousTierCode = account.currentTierCode;
  const previousRank = previousTierCode
    ? (tiers.find((t) => t.code === previousTierCode)?.rank ?? -Infinity)
    : -Infinity;

  account.currentTierCode = matched.code;
  account.tierProgress = {
    currentSpend: spend,
    nextTierCode: next ? next.code : null,
    nextTierSpend: next ? next.minimumSpend : null,
    percentage: next
      ? Math.min(100, Math.round(((spend - matched.minimumSpend) / (next.minimumSpend - matched.minimumSpend)) * 100))
      : 100
  };
  await account.save({ session });

  return {
    upgraded: matched.rank > previousRank,
    downgraded: matched.rank < previousRank && previousTierCode != null,
    previousTierCode,
    newTierCode: matched.code
  };
};

/** Convenience wrapper for callers that only have a mobile number. */
const recalculateTierForMobile = async (mobile, session = null) => {
  const account = await LoyaltyAccount.findOne({ mobile }).session(session);
  if (!account) return null;
  return recalculateTier(account, session);
};

module.exports = { getActiveTiers, getTierMultiplier, recalculateTier, recalculateTierForMobile };
