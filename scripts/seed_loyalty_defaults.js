// Seeds the recommended initial loyalty configuration
// (loyalty_rewards_frd.md section 83) into every active tenant: earning
// rules, a reward catalog, and the four VIP tiers. Purely additive and
// idempotent - skips anything whose `code` already exists in that tenant,
// so it's safe to run again after an admin has since edited or added rules/
// rewards/tiers of their own.
//
//   node scripts/seed_loyalty_defaults.js                # dry run
//   node scripts/seed_loyalty_defaults.js --apply
//   node scripts/seed_loyalty_defaults.js --apply --project RET6978

require('dotenv').config();
const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { getProjectModel } = require('../models/Project');
require('../models/LoyaltyRule');
require('../models/LoyaltyReward');
require('../models/LoyaltyTier');

const apply = process.argv.includes('--apply');
const projectArgIndex = process.argv.indexOf('--project');
const onlyProject = projectArgIndex !== -1 ? process.argv[projectArgIndex + 1] : null;

const DEFAULT_RULES = [
  { code: 'REGISTRATION_POINTS', name: 'Registration Bonus', event: 'REGISTRATION', pointsType: 'FIXED', pointsValue: 100, pendingPeriodDays: 0 },
  { code: 'FIRST_ORDER_POINTS', name: 'First Order Bonus', event: 'FIRST_ORDER', pointsType: 'FIXED', pointsValue: 500, pendingPeriodDays: 7 },
  { code: 'PURCHASE_POINTS', name: 'Purchase Points', event: 'ORDER_DELIVERED', pointsType: 'FIXED_PER_AMOUNT', pointsValue: 10, amountValue: 100, pendingPeriodDays: 7 },
  { code: 'PRODUCT_REVIEW_POINTS', name: 'Product Review', event: 'PRODUCT_REVIEW', pointsType: 'FIXED', pointsValue: 100, pendingPeriodDays: 0 },
  { code: 'PHOTO_REVIEW_POINTS', name: 'Photo Review', event: 'PHOTO_REVIEW', pointsType: 'FIXED', pointsValue: 200, pendingPeriodDays: 0 },
  { code: 'REFERRAL_POINTS', name: 'Successful Referral', event: 'REFERRAL', pointsType: 'FIXED', pointsValue: 500, pendingPeriodDays: 0 },
  { code: 'BIRTHDAY_POINTS', name: 'Birthday Bonus', event: 'BIRTHDAY', pointsType: 'FIXED', pointsValue: 300, pendingPeriodDays: 0 },
  { code: 'FIRST_APP_ORDER_POINTS', name: 'First App Order', event: 'FIRST_APP_ORDER', pointsType: 'FIXED', pointsValue: 250, pendingPeriodDays: 7 }
];

const DEFAULT_REWARDS = [
  { name: '₹50 OFF', description: 'Get ₹50 off your next order', type: 'FIXED_DISCOUNT', pointsRequired: 500, discountValue: 50, minimumOrderValue: 499 },
  { name: '₹100 OFF', description: 'Get ₹100 off your next order', type: 'FIXED_DISCOUNT', pointsRequired: 1000, discountValue: 100, minimumOrderValue: 999 },
  { name: '₹250 OFF', description: 'Get ₹250 off your next order', type: 'FIXED_DISCOUNT', pointsRequired: 2500, discountValue: 250, minimumOrderValue: 1999 },
  { name: '₹500 OFF', description: 'Get ₹500 off your next order', type: 'FIXED_DISCOUNT', pointsRequired: 5000, discountValue: 500, minimumOrderValue: 3999 },
  { name: 'Free Shipping', description: 'Free delivery on your next order', type: 'FREE_SHIPPING', pointsRequired: 750, discountValue: 0, minimumOrderValue: 0 }
];

const DEFAULT_TIERS = [
  { code: 'BRONZE', name: 'Bronze', minimumSpend: 0, maximumSpend: 9999, pointMultiplier: 1.0, rank: 1, benefits: [{ type: 'POINT_MULTIPLIER', value: 1.0 }], cardPrimaryColor: '#3E2723', cardAccentColor: '#CD7F32' },
  { code: 'SILVER', name: 'Silver', minimumSpend: 10000, maximumSpend: 29999, pointMultiplier: 1.25, rank: 2, benefits: [{ type: 'POINT_MULTIPLIER', value: 1.25 }], cardPrimaryColor: '#2C2C2C', cardAccentColor: '#C0C0C0' },
  { code: 'GOLD', name: 'Gold', minimumSpend: 30000, maximumSpend: 74999, pointMultiplier: 1.5, rank: 3, benefits: [{ type: 'POINT_MULTIPLIER', value: 1.5 }, { type: 'FREE_SHIPPING', value: true }, { type: 'EARLY_ACCESS', value: true }], cardPrimaryColor: '#1A1A1A', cardAccentColor: '#D4AF37' },
  { code: 'PLATINUM', name: 'Platinum', minimumSpend: 75000, maximumSpend: null, pointMultiplier: 2.0, rank: 4, benefits: [{ type: 'POINT_MULTIPLIER', value: 2.0 }, { type: 'FREE_SHIPPING', value: true }, { type: 'EARLY_ACCESS', value: true }, { type: 'PRIORITY_SUPPORT', value: true }], cardPrimaryColor: '#0D1B2A', cardAccentColor: '#E5E4E2' }
];

async function seedProject(project) {
  const db = getTenantDb(project.db_name);
  const LoyaltyRule = db.models.LoyaltyRule;
  const LoyaltyReward = db.models.LoyaltyReward;
  const LoyaltyTier = db.models.LoyaltyTier;

  const existingRuleCodes = new Set((await LoyaltyRule.find({}).select('code').lean()).map((r) => r.code));
  const existingTierCodes = new Set((await LoyaltyTier.find({}).select('code').lean()).map((t) => t.code));
  const existingRewardNames = new Set((await LoyaltyReward.find({}).select('name').lean()).map((r) => r.name));

  const newRules = DEFAULT_RULES.filter((r) => !existingRuleCodes.has(r.code));
  const newTiers = DEFAULT_TIERS.filter((t) => !existingTierCodes.has(t.code));
  const newRewards = DEFAULT_REWARDS.filter((r) => !existingRewardNames.has(r.name));

  console.log(`  [${project.project_code}] +${newRules.length} rules, +${newTiers.length} tiers, +${newRewards.length} rewards`);

  if (!apply) return;
  if (newRules.length) await LoyaltyRule.insertMany(newRules.map((r) => ({ ...r, status: 'ACTIVE' })));
  if (newTiers.length) await LoyaltyTier.insertMany(newTiers.map((t) => ({ ...t, status: 'ACTIVE' })));
  if (newRewards.length) await LoyaltyReward.insertMany(newRewards.map((r) => ({ ...r, status: 'ACTIVE' })));
}

const run = async () => {
  console.log(apply ? '🚚 Seeding default loyalty configuration\n' : '🔍 Dry run — no writes (pass --apply)\n');
  await connectDB();

  const filter = { status: 'active' };
  if (onlyProject) filter.project_code = onlyProject.toUpperCase();
  const projects = await getProjectModel().find(filter).lean();

  for (const project of projects) {
    await seedProject(project);
  }

  await disconnectDB();
  console.log('\nDone.');
};

run().catch((err) => {
  console.error('Loyalty seed failed:', err);
  process.exit(1);
});
