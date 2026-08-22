/**
 * Order-lifecycle integration. Call sites (all three needed - there is no
 * single Mongoose hook that sees every order_status transition in this
 * codebase, see investigation notes in the loyalty PR description):
 *   - models/Order.js's updateStatus() - covers the admin PATCH/PUT routes
 *   - routes/orders.js's customer self-cancel route
 *   - routes/admin/orders.js's bulk-update-status route
 *
 * Every credit/reversal here is idempotency-keyed off the order id and rule
 * code, so calling onOrderDelivered/onOrderCancelled more than once for the
 * same order (a retried request, a re-run script) is always safe - later
 * calls no-op via LoyaltyTransaction's unique idempotencyKey index.
 *
 * Failures here are logged and swallowed, never thrown back to the order
 * route - loyalty processing must not be able to break checkout or order
 * management (loyalty_rewards_frd.md section 75: "Loyalty should not
 * prevent normal checkout if the loyalty service is temporarily
 * unavailable").
 */

const User = require('../models/User');
const Order = require('../models/Order');
const LoyaltyRule = require('../models/LoyaltyRule');
const LoyaltyTransaction = require('../models/LoyaltyTransaction');
const { creditPoints, reverseTransaction, calculatePoints, getOrCreateAccount } = require('./loyaltyEngine');
const { getTierMultiplier, recalculateTier } = require('./loyaltyTierEngine');
const { getActiveCampaignMultiplier } = require('./loyaltyCampaignEngine');
const { evaluateChallenges } = require('./loyaltyChallengeEngine');
const { completeReferralIfQualifying } = require('./loyaltyReferral');
const { notifyLoyaltyEvent } = require('./loyaltyNotify');

const POINTS_EXPIRY_MONTHS = 12;

const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
};
const addDays = (date, days) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

/** FRD section 8.3 default: merchandise value after discounts, no tax/delivery. */
const getEligibleOrderValue = (order) => {
  const s = order.order_summary || {};
  const value = (s.subtotal || 0) - (s.discount_amount || 0) - (s.deal_savings || 0);
  return Math.max(0, Math.round(value * 100) / 100);
};

/**
 * Run the full points/tier/challenge/referral pipeline for a delivered
 * order. Safe to call multiple times for the same order.
 */
const onOrderDelivered = async (order) => {
  try {
    const user = await User.findOne({ mobile: order.mobile_no });
    if (!user) return; // guest/legacy order with no matching account - nothing to credit

    const account = await getOrCreateAccount(user);
    const orderAmount = getEligibleOrderValue(order);
    const deliveredOrderCount = await Order.countDocuments({ mobile_no: order.mobile_no, order_status: 'delivered' });
    const isFirstOrder = deliveredOrderCount === 1;

    const rules = await LoyaltyRule.find({
      status: 'ACTIVE',
      event: { $in: isFirstOrder ? ['ORDER_DELIVERED', 'FIRST_ORDER'] : ['ORDER_DELIVERED'] }
    });

    if (rules.length) {
      const tierMultiplier = await getTierMultiplier(account.currentTierCode);
      const pCodes = (order.order_items || []).map((i) => i.p_code);
      const { multiplier: campaignMultiplier } = await getActiveCampaignMultiplier({
        tierCode: account.currentTierCode, pCodes, orderAmount
      });

      for (const rule of rules) {
        const points = calculatePoints({ rule, orderAmount, tierMultiplier, campaignMultiplier });
        if (points <= 0) continue;

        const availableAt = addDays(order.order_completed_at || new Date(), rule.pendingPeriodDays || 0);
        const expiresAt = addMonths(availableAt, POINTS_EXPIRY_MONTHS);
        const immediate = (rule.pendingPeriodDays || 0) === 0;

        const result = await creditPoints({
          user,
          points,
          source: 'ORDER',
          referenceId: String(order._id),
          idempotencyKey: `ORDER_${order._id}_${rule.code}`,
          metadata: { orderNumber: order.order_number, orderAmount, ruleCode: rule.code, tierMultiplier, campaignMultiplier },
          status: immediate ? 'COMPLETED' : 'PENDING',
          availableAt: immediate ? null : availableAt,
          expiresAt: immediate ? expiresAt : null // set again when promoted PENDING->COMPLETED; see promotePendingPoints
        });

        if (!result.duplicate && immediate) {
          await notifyLoyaltyEvent(user, {
            title: `You earned ${points} points! ⭐`,
            body: `From order #${order.order_number}.`,
            data: { loyaltyEventType: 'POINTS_EARNED', orderId: String(order._id) },
            projectCode: order.project_code
          });
        }
      }
    }

    // Tier is based on lifetime spend, independent of whether any rule paid
    // out points for this order.
    account.eligibleLifetimeSpend = (account.eligibleLifetimeSpend || 0) + orderAmount;
    await account.save();
    const tierResult = await recalculateTier(account);
    if (tierResult.upgraded && tierResult.previousTierCode) {
      await notifyLoyaltyEvent(user, {
        title: `Welcome to ${tierResult.newTierCode}! 🏆`,
        body: 'You just unlocked a new loyalty tier and its benefits.',
        data: { loyaltyEventType: 'TIER_UPGRADE', tier: tierResult.newTierCode },
        projectCode: order.project_code
      });
    }

    await evaluateChallenges({
      user, event: 'ORDER_DELIVERED', orderAmount, orderId: order._id, isFirstOrder, projectCode: order.project_code
    });
    await evaluateChallenges({
      user, event: 'ORDER_AMOUNT', orderAmount, orderId: order._id, isFirstOrder, projectCode: order.project_code
    });

    await completeReferralIfQualifying({ referredUser: user, order, isFirstOrder, projectCode: order.project_code });
  } catch (error) {
    console.error(`[loyalty] onOrderDelivered failed for order ${order._id}:`, error);
  }
};

/**
 * Claw back any points this order generated. Called for CANCELLED and
 * REFUNDED orders. Also unwinds this order's contribution to tier-eligible
 * spend and recalculates tier (a refund can legitimately demote).
 */
const onOrderCancelledOrRefunded = async (order) => {
  try {
    const credits = await LoyaltyTransaction.find({ referenceId: String(order._id), type: 'CREDIT' });
    if (!credits.length) return;

    const user = await User.findOne({ mobile: order.mobile_no });
    if (!user) return;

    for (const credit of credits) {
      await reverseTransaction({
        originalTransactionId: credit._id,
        reason: `Order ${order.order_status}`,
        idempotencyKey: `${credit.idempotencyKey}_REVERSAL`
      });
    }

    const account = await getOrCreateAccount(user);
    const orderAmount = getEligibleOrderValue(order);
    account.eligibleLifetimeSpend = Math.max(0, (account.eligibleLifetimeSpend || 0) - orderAmount);
    await account.save();
    await recalculateTier(account);
  } catch (error) {
    console.error(`[loyalty] onOrderCancelledOrRefunded failed for order ${order._id}:`, error);
  }
};

module.exports = { onOrderDelivered, onOrderCancelledOrRefunded, getEligibleOrderValue };
