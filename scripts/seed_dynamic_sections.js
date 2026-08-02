// Seeds every dynamic home-screen section with working test data.
//
// Idempotent: each section is matched by its title and upserted, so re-running
// updates in place rather than piling up duplicates. Nothing is deleted —
// anything already in these collections (the two existing banners, for
// instance) is left alone.
//
// Every product and subcategory referenced is read live from the tenant DB and
// filtered to what will actually render: active, in stock, priced, with an
// image. Seeding invented ids produces sections that look populated in the
// admin panel and render as blank tiles in the app, which is a worse failure
// than an empty section because it looks like a client bug.
//
//   node scripts/seed_dynamic_sections.js [--store PAG001] [--project RET5677]

require('dotenv').config();

const { connectDB, disconnectDB, getTenantDb } = require('../config/database');
const { als } = require('../config/tenantContext');

// Required for their side effects as much as their value: each module
// registers its schema and returns a proxy that resolves to the model on
// whichever tenant connection is active in AsyncLocalStorage.
const ProductMaster = require('../models/ProductMaster');
const Subcategory = require('../models/Subcategory');
const BestSeller = require('../models/BestSeller');
const TopSeller = require('../models/TopSeller');
const PopularCategory = require('../models/PopularCategory');
const SeasonalCategory = require('../models/SeasonalCategory');
const Advertisement = require('../models/Advertisement');
const Banner = require('../models/Banner');
const OnboardingSlide = require('../models/OnboardingSlide');
const Offer = require('../models/Offer');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const STORE = arg('store', 'PAG001');
const PROJECT = arg('project', 'RET5677');

// Placeholder art. Deliberately a real, reachable host: a broken image URL
// makes a correctly-seeded section look broken.
const img = (w, h, text, bg) =>
  `https://placehold.co/${w}x${h}/${bg}/ffffff/png?text=${encodeURIComponent(text)}`;

const BADGES = ['Bestseller', 'Popular', 'Trending', 'Top Rated', 'New', 'Editors Pick'];
const TAGLINES = ['Customer Favourite', 'Flying off the shelf', 'Great value',
  'Stock up now', 'Highly rated', 'Back in stock'];

const seed = async () => {
  await connectDB();

  // Resolve the tenant DB the same way a request would, so the models write
  // where the API reads.
  const { getProjectModel } = require('../models/Project');
  const Project = getProjectModel();
  const project = await Project.findOne({ project_code: PROJECT }).lean();
  if (!project) {
    throw new Error(`Project ${PROJECT} is not in the control registry — run seed-projects first.`);
  }
  const db = getTenantDb(project.db_name);
  console.log(`Tenant ${PROJECT} → ${project.db_name}, store ${STORE}\n`);
  // Models proxy through AsyncLocalStorage, exactly as they do in a request.
  return als.run({ connection: db, project }, () => seedSections());
};

const seedSections = async () => {

  // ---- live source data -------------------------------------------------
  const products = await ProductMaster.find({
    store_code: STORE,
    pcode_status: 'Y',
    store_quantity: { $gt: 2 },
    our_price: { $gt: 0 },
    pcode_img: { $exists: true, $ne: '' },
  }).limit(40).lean();

  if (products.length < 20) {
    throw new Error(`Only ${products.length} renderable products for ${STORE}; need 20+.`);
  }

  // Subcategories that actually hold stock, most-populated first.
  const counts = new Map();
  const stocked = await ProductMaster.find(
    { store_code: STORE, pcode_status: 'Y', store_quantity: { $gt: 0 } },
    { sub_category_id: 1 }
  ).lean();
  for (const p of stocked) {
    counts.set(String(p.sub_category_id), (counts.get(String(p.sub_category_id)) || 0) + 1);
  }
  const subs = (await Subcategory.find({}).lean())
    .map((s) => ({ id: String(s.idsub_category_master), name: s.sub_category_name, n: counts.get(String(s.idsub_category_master)) || 0 }))
    .filter((s) => s.n > 0)
    .sort((a, b) => b.n - a.n);

  if (subs.length < 14) {
    throw new Error(`Only ${subs.length} populated subcategories; need 14+.`);
  }

  const slice = (arr, n, off = 0) => arr.slice(off, off + n);
  const productItems = (list) => list.map((p, i) => ({
    p_code: p.p_code,
    store_code: STORE,
    position: i + 1,
    redirect_url: `/products/${p.p_code}`,
    metadata: {
      badge: BADGES[i % BADGES.length],
      tagline: TAGLINES[i % TAGLINES.length],
      highlight: i < 3,
    },
  }));
  const subItems = (list) => list.map((s, i) => ({
    sub_category_id: s.id,
    store_code: STORE,
    position: i + 1,
    redirect_url: `/categories/${s.id}`,
    metadata: { badge: BADGES[i % BADGES.length], highlight: i < 3 },
  }));

  const results = [];
  const upsert = async (Model, match, doc, label) => {
    const saved = await Model.findOneAndUpdate(match, { $set: doc }, {
      upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true,
    });
    results.push([label, saved._id.toString()]);
    console.log(`✔ ${label}`);
    return saved;
  };

  // ---- sections ---------------------------------------------------------
  await upsert(BestSeller, { title: 'Best Sellers' }, {
    title: 'Best Sellers',
    description: 'What everyone is buying this week',
    store_codes: [STORE],
    banner_urls: { desktop: img(1200, 300, 'Best Sellers', '863283'), mobile: img(600, 300, 'Best Sellers', '863283') },
    background_color: '#863283',
    redirect_url: '/best-sellers',
    products: productItems(slice(products, 8, 0)),
    is_active: true,
    sequence: 1,
  }, 'BestSeller "Best Sellers" — 8 products');

  await upsert(TopSeller, { title: 'Top Picks For You' }, {
    title: 'Top Picks For You',
    store_codes: [STORE],
    bg_color: '#24c278',
    products: productItems(slice(products, 8, 8)),
    is_active: true,
    sequence: 2,
  }, 'TopSeller "Top Picks For You" — 8 products');

  await upsert(PopularCategory, { title: 'Shop by Popular Category' }, {
    title: 'Shop by Popular Category',
    description: 'Our most browsed aisles',
    store_codes: [STORE],
    banner_urls: { desktop: img(1200, 300, 'Popular Categories', '9d41c8'), mobile: img(600, 300, 'Popular', '9d41c8') },
    background_color: '#9d41c8',
    redirect_url: '/categories',
    subcategories: subItems(slice(subs, 8, 0)),
    is_active: true,
    sequence: 3,
  }, 'PopularCategory "Shop by Popular Category" — 8 subcategories');

  await upsert(SeasonalCategory, { title: 'Monsoon Essentials' }, {
    title: 'Monsoon Essentials',
    description: 'Picked for the season',
    store_codes: [STORE],
    banner_urls: { desktop: img(1200, 300, 'Monsoon Essentials', '2e7d32'), mobile: img(600, 300, 'Monsoon', '2e7d32') },
    background_color: '#2e7d32',
    redirect_url: '/categories',
    // `season` is an enum; 'monsoon' is not one of its values.
    season: 'all',
    subcategories: subItems(slice(subs, 6, 8)),
    is_active: true,
    sequence: 4,
  }, 'SeasonalCategory "Monsoon Essentials" — 6 subcategories');

  await upsert(Advertisement, { title: 'Deal of the Day' }, {
    title: 'Deal of the Day',
    description: 'Limited-time picks',
    store_codes: [STORE],
    banner_url: img(1200, 400, 'Deal of the Day', 'e53935'),
    banner_urls: { desktop: img(1200, 400, 'Deal of the Day', 'e53935'), mobile: img(600, 400, 'Deal', 'e53935') },
    redirect_url: '/offers',
    category: 'promotion',
    products: slice(products, 6, 16).map((p, i) => ({
      p_code: p.p_code, store_code: STORE, position: i + 1,
      redirect_url: `/products/${p.p_code}`, metadata: {},
    })),
    is_active: true,
    sequence: 5,
    start_date: new Date('2026-01-01T00:00:00Z'),
    end_date: new Date('2027-01-01T00:00:00Z'),
  }, 'Advertisement "Deal of the Day" — 6 products');

  // Banner. Additive — the two existing rows are untouched.
  await upsert(Banner, { title: 'Fresh Picks Carousel' }, {
    title: 'Fresh Picks Carousel',
    section_name: 'home_top',
    image_url: img(1200, 400, 'Fresh Picks', '863283'),
    banner_assets: [
      { key: 'slide_1', desktop: img(1200, 400, 'Fresh Picks', '863283'), mobile: img(600, 400, 'Fresh Picks', '863283') },
      { key: 'slide_2', desktop: img(1200, 400, 'Save More', '24c278'), mobile: img(600, 400, 'Save More', '24c278') },
    ],
    action: { type: 'url', value: '/offers' },
    store_codes: [STORE],
    is_active: true,
    sequence: 1,
    start_date: new Date('2026-01-01T00:00:00Z'),
    end_date: new Date('2027-01-01T00:00:00Z'),
  }, 'Banner "Fresh Picks Carousel" — 2 slides');

  // Onboarding is tenant-wide: it runs before a store is chosen.
  const slides = [
    ['Everything you need, daily', 'Thousands of products from your neighbourhood store.', '1'],
    ['Delivered when it suits you', 'Pick a slot that fits your day, not ours.', '2'],
    ['Prices you can trust', 'No surprises at checkout — the price you see is what you pay.', '3'],
  ];
  for (const [i, [title, description, n]] of slides.entries()) {
    await upsert(OnboardingSlide, { title }, {
      title, description,
      image_url: img(800, 1200, `Onboarding ${n}`, '863283'),
      sequence: i + 1,
      is_active: true,
    }, `OnboardingSlide ${i + 1}/3 "${title}"`);
  }

  // Offers. A cart discount and a product deal — the two offer_type branches,
  // each of which has its own conditional validation.
  const dealProduct = products[0];
  await upsert(Offer, { title: 'Save ₹50 on ₹500' }, {
    title: 'Save ₹50 on ₹500',
    description: 'Flat ₹50 off when your cart crosses ₹500.',
    offer_type: 'cart_discount',
    discount_type: 'flat',
    discount_amount: 50,
    min_cart_value: 500,
    max_discount: 50,
    store_codes: [STORE],
    is_active: true,
    priority: 1,
    valid_from: new Date('2026-01-01T00:00:00Z'),
    valid_until: new Date('2027-01-01T00:00:00Z'),
  }, 'Offer "Save ₹50 on ₹500" (cart_discount)');

  await upsert(Offer, { title: '10% off your basket' }, {
    title: '10% off your basket',
    description: '10% off over ₹1000, up to ₹200.',
    offer_type: 'cart_discount',
    discount_type: 'percentage',
    discount_amount: 10,
    min_cart_value: 1000,
    max_discount: 200,
    store_codes: [STORE],
    is_active: true,
    priority: 2,
    valid_from: new Date('2026-01-01T00:00:00Z'),
    valid_until: new Date('2027-01-01T00:00:00Z'),
  }, 'Offer "10% off your basket" (percentage)');

  await upsert(Offer, { title: 'Deal of the Week' }, {
    title: 'Deal of the Week',
    description: `${dealProduct.product_name} at a special price.`,
    offer_type: 'product_deal',
    min_cart_value: 0,
    store_codes: [STORE],
    deal_products: [{
      p_code: dealProduct.p_code,
      product_name: dealProduct.product_name,
      deal_price: Math.max(1, Math.round(Number(dealProduct.our_price) * 0.8 * 100) / 100),
      original_price: Number(dealProduct.our_price),
      pcode_img: dealProduct.pcode_img,
      max_quantity: 2,
    }],
    is_active: true,
    priority: 3,
    valid_from: new Date('2026-01-01T00:00:00Z'),
    valid_until: new Date('2027-01-01T00:00:00Z'),
  }, 'Offer "Deal of the Week" (product_deal)');

  console.log(`\n${results.length} sections seeded for ${PROJECT}/${STORE}.`);
  await disconnectDB();
};

seed().catch((err) => {
  console.error('\nSeed failed:', err.message);
  if (err.errors) {
    for (const [field, e] of Object.entries(err.errors)) console.error(`  ${field}: ${e.message}`);
  }
  process.exit(1);
});
