/**
 * Active-campaign lookup for the points calculation pipeline
 * (loyalty_rewards_frd.md section 20-21).
 *
 * Targeting support: tier and product (order_items[].p_code) matching are
 * fully wired. Category targeting is accepted and stored by the admin panel
 * for forward-compatibility but not yet enforced here - Order line items
 * only carry p_code/product_name, not a category reference, so evaluating
 * it would mean a ProductMaster lookup per item on every delivered order.
 * A campaign with only applicableCategories set will currently match every
 * order (equivalent to no restriction) until that lookup is added.
 */

const LoyaltyCampaign = require('../models/LoyaltyCampaign');

/**
 * @param {object} params
 * @param {string} params.tierCode - customer's current tier, or null
 * @param {string[]} params.pCodes - product codes in the order
 * @param {number} params.orderAmount
 * @returns {Promise<{multiplier: number, campaign: object|null}>}
 */
const getActiveCampaignMultiplier = async ({ tierCode, pCodes = [], orderAmount }) => {
  const now = new Date();
  const campaigns = await LoyaltyCampaign.find({
    status: 'ACTIVE',
    validFrom: { $lte: now },
    validUntil: { $gte: now },
    minimumOrderValue: { $lte: orderAmount }
  });

  const eligible = campaigns.filter((c) => {
    const tierOk = !c.applicableTiers.length || (tierCode && c.applicableTiers.includes(tierCode));
    const productOk = !c.applicableProducts.length || c.applicableProducts.some((p) => pCodes.includes(p));
    return tierOk && productOk;
  });

  if (!eligible.length) return { multiplier: 1, campaign: null };

  // Best-for-customer: the highest multiplier among everything they qualify for.
  const best = eligible.reduce((a, b) => (b.multiplier > a.multiplier ? b : a));
  return { multiplier: best.multiplier, campaign: best };
};

module.exports = { getActiveCampaignMultiplier };
