// utils/homeFeedService.js
//
// Builds the mobile app's home screen as an ordered list of typed sections.
//
// Phase 1 composes the feed from the collections that already back the home
// screen — no data migration, and the existing admin pages keep editing the
// same documents. The layout (which sections, in what order) is seeded from
// the order the Flutter app currently hardcodes, so switching the app onto the
// feed is a no-op visually. Phase 2 replaces the seeded layout with a
// HomeSection collection the panel writes to.
//
// Contract notes:
//   - Sections the app does not recognise must be skipped, not fatal, so new
//     section types can ship before an app release.
//   - `personalized: true` sections carry no items. They are placeholders the
//     client fills (cart-dependent offers today, per-user rails later). This
//     keeps the feed itself public and cacheable — retrofitting that split
//     after per-user data leaks into the payload would be a breaking change.

const PopularCategory = require('../models/PopularCategory');
const SeasonalCategory = require('../models/SeasonalCategory');
const BestSeller = require('../models/BestSeller');
const TopSeller = require('../models/TopSeller');
const Banner = require('../models/Banner');
const Advertisement = require('../models/Advertisement');
const Offer = require('../models/Offer');
const HomeSection = require('../models/HomeSection');
const ProductMaster = require('../models/ProductMaster');

const { enrichPopularCategorySections } = require('../routes/popular-categories');
const { enrichSeasonalCategorySections } = require('../routes/seasonal-categories');
const { mapProductMaster } = require('../routes/best-sellers');
const { PERSONALIZED_TYPES } = require('./homeSectionTypes');

const SCHEMA_VERSION = 1;

// Section types the app knows in Phase 1. Adding one here plus a renderer in
// the app is the whole cost of a new section type.
const SECTION_TYPES = {
  HERO_CAROUSEL: 'hero_carousel',
  BANNER_STRIP: 'banner_strip',
  COUPON_STRIP: 'coupon_strip',
  BRAND_STRIP: 'brand_strip',
  CATEGORY_STRIP: 'category_strip',
  CATEGORY_GRID: 'category_grid',
  PRODUCT_RAIL: 'product_rail',
  OFFER_STRIP: 'offer_strip',
  SEASONAL_PICKS: 'seasonal_picks',
  RECENTLY_VIEWED: 'recently_viewed',
};

// Banner placements the home screen draws. `home_top` is the hero carousel the
// app has always shown; `home_middle` is the second placement the admin panel
// has always offered in its filter but nothing ever rendered.
const BANNER_SECTIONS = {
  HERO: 'home_top',
  MID: 'home_middle',
};

// How many best-seller rails and offer slots the current app interleaves.
// Mirrors `bestSellerCount` in the Flutter home screen.
const BEST_SELLER_SLOTS = 4;
const OFFER_SLOTS = 4;

// Top-seller rails in the default layout. Kept below the best-seller count on
// purpose: top sellers land after the interleaved block, and a long tail of
// rails past the fold earns nothing.
const TOP_SELLER_SLOTS = 2;

const storeQuery = (storeCode) => {
  const query = { is_active: true };
  const trimmed = (storeCode || '').toString().trim();
  if (trimmed) {
    query.$or = [{ store_codes: trimmed }, { store_code: trimmed }];
  }
  return query;
};

const bySequence = { sequence: 1, createdAt: -1 };

/** Sections keyed by their `sequence`, which is how the app addresses them. */
const bySequenceMap = (docs) => {
  const map = new Map();
  docs.forEach((doc) => {
    const key = Number(doc.sequence);
    if (Number.isFinite(key) && !map.has(key)) map.set(key, doc);
  });
  return map;
};

/** Attaches product_details to a best-seller/top-seller section's products. */
async function enrichProducts(sections) {
  const codes = Array.from(
    new Set(sections.flatMap((s) => (s.products || []).map((p) => p.p_code)))
  ).filter(Boolean);

  if (codes.length === 0) return sections;

  const products = await ProductMaster.find({
    p_code: { $in: codes },
    pcode_status: 'Y',
  });

  const productMap = new Map();
  products.forEach((product) => {
    productMap.set(product.p_code, mapProductMaster(product));
  });

  return sections.map((section) => ({
    ...section,
    products: (section.products || []).map((product) => ({
      ...product,
      product_details: productMap.get(product.p_code) || null,
    })),
  }));
}

// `bg_color` is what the top_sellers collection calls it; every other
// collection uses `background_color`. Reading only one silently dropped the
// colour for whichever collection did not match.
const styleOf = (doc) => ({
  background_color: doc?.background_color || doc?.bg_color || '',
  banner_urls: doc?.banner_urls || null,
});

/** A section carrying content. */
const section = ({ id, type, sourceSequence, sourceCollection, title, description, style, items }) => ({
  id: id ? String(id) : `${type}-${sourceSequence ?? 0}`,
  type,
  // Which document this came from. The app's Phase 1 renderers still address
  // sections by sequence, so this is what lets them line up.
  //
  // `collection_name` matters where one type can be backed by more than one
  // collection: a product_rail fed by top_sellers and one fed by best_sellers
  // are indistinguishable by sequence alone, and a client that guessed would
  // render the wrong collection's rail.
  source: { sequence: sourceSequence ?? null, collection_name: sourceCollection || null },
  title: title || '',
  description: description || '',
  style: style || {},
  personalized: false,
  ends_at: null,
  audience: 'all',
  config: {},
  items: items || [],
});

/**
 * Campaign metadata the client needs to render a section correctly:
 * `ends_at` drives countdowns, `audience` is matched on the device (the feed
 * stays cacheable, so it cannot be filtered server-side), and `config` carries
 * per-type settings.
 */
const campaignMeta = (entry) => ({
  ends_at: entry.ends_at ? new Date(entry.ends_at).toISOString() : null,
  audience: entry.audience || 'all',
  config: entry.config || {},
});

/** A slot the client fills from data the server deliberately does not hold. */
const personalizedSection = ({ type, index }) => ({
  id: `${type}-${index}`,
  type,
  source: { index },
  title: '',
  description: '',
  style: {},
  personalized: true,
  ends_at: null,
  audience: 'all',
  config: {},
  items: [],
});

/**
 * One banner placement, as a renderable section.
 *
 * `sectionName` is the admin panel's `section_name`. Previously only
 * `home_top` was ever asked for, so banners saved under any other placement —
 * `home_middle` among them, which the panel's own filter offers — were
 * unreachable from the app.
 */
async function bannerSection({ storeCode, sectionName, type, title = '' }) {
  const trimmed = (storeCode || '').toString().trim();
  const banners = trimmed
    ? await Banner.findByStoreCodes({
        storeCodes: [trimmed],
        sectionName,
        activeOnly: true,
      })
    : await Banner.findActive({ sectionName });

  if (!banners || banners.length === 0) return null;

  const grouped = await Banner.groupBySections(banners);
  const items = grouped.flatMap((group) => group.banners || []);
  if (items.length === 0) return null;

  return section({
    id: sectionName,
    type,
    sourceSequence: 0,
    sourceCollection: 'banners',
    title,
    items,
  });
}

const heroCarousel = (storeCode) =>
  bannerSection({
    storeCode,
    sectionName: BANNER_SECTIONS.HERO,
    type: SECTION_TYPES.HERO_CAROUSEL,
  });

const midBanners = (storeCode) =>
  bannerSection({
    storeCode,
    sectionName: BANNER_SECTIONS.MID,
    type: SECTION_TYPES.BANNER_STRIP,
  });

/**
 * Advertisements as a renderable section.
 *
 * `advertisements` was already offered as a layout source but nothing resolved
 * it, so a section pointing at one was dropped without a trace. The `popup`
 * category is excluded: those are modal creatives the app shows over the home
 * screen, and drawing them inline as well would double them up.
 */
async function advertisementSection({ storeCode, category, title = '', now = new Date() }) {
  const trimmed = (storeCode || '').toString().trim();
  const query = { is_active: true };

  if (trimmed) {
    query.$or = [{ store_codes: trimmed }, { store_code: trimmed }];
  }

  const wanted = (category || '').toString().trim();
  if (wanted) {
    query.category = wanted;
  } else {
    query.category = { $ne: 'popup' };
  }

  const ads = await Advertisement.find(query).sort(bySequence).lean();

  // Scheduling is optional on an advertisement; an absent bound means "no
  // bound", not "expired".
  const live = ads.filter(
    (ad) =>
      (!ad.start_date || new Date(ad.start_date) <= now) &&
      (!ad.end_date || new Date(ad.end_date) >= now)
  );

  if (live.length === 0) return null;

  return section({
    id: `advertisements-${wanted || 'all'}`,
    type: SECTION_TYPES.BANNER_STRIP,
    sourceSequence: 0,
    sourceCollection: 'advertisements',
    title,
    items: live,
  });
}

/**
 * Cart-level coupons as a renderable section.
 *
 * Public on purpose: a coupon reads the same for every shopper, so it travels
 * in the cacheable feed. Only `cart_discount` offers qualify — `product_deal`
 * offers are individual products and already have their own rails.
 */
async function couponSection({ storeCode, now = new Date(), limit = 10 } = {}) {
  const trimmed = (storeCode || '').toString().trim();
  const query = {
    is_active: true,
    offer_type: 'cart_discount',
    valid_from: { $lte: now },
    $and: [
      {
        $or: [
          { valid_until: { $exists: false } },
          { valid_until: null },
          { valid_until: { $gte: now } },
        ],
      },
    ],
  };

  // An offer with no store codes is tenant-wide; one with codes is scoped.
  if (trimmed) {
    query.$and.push({
      $or: [{ store_codes: trimmed }, { store_codes: { $size: 0 } }, { store_codes: null }],
    });
  }

  const offers = await Offer.find(query)
    .sort({ priority: -1, min_cart_value: 1 })
    .limit(limit)
    .lean();

  if (offers.length === 0) return null;

  return section({
    id: 'coupons',
    type: SECTION_TYPES.COUPON_STRIP,
    sourceSequence: 0,
    sourceCollection: 'offers',
    items: offers.map((offer) => ({
      id: String(offer._id),
      title: offer.title || '',
      description: offer.description || '',
      discount_amount: offer.discount_amount || 0,
      discount_type: offer.discount_type || 'flat',
      min_cart_value: offer.min_cart_value || 0,
      max_discount: offer.max_discount ?? null,
      valid_until: offer.valid_until ? new Date(offer.valid_until).toISOString() : null,
    })),
  });
}

/**
 * Brands stocked by this store, with a representative product image.
 *
 * Derived from the catalogue rather than a collection of its own: there is no
 * brand registry, and inventing one would need every tenant to re-enter data
 * that already exists on their products.
 */
async function brandSection({ storeCode, limit = 12 } = {}) {
  const trimmed = (storeCode || '').toString().trim();
  const match = {
    pcode_status: 'Y',
    brand_name: { $nin: [null, ''] },
  };
  if (trimmed) match.store_code = trimmed;

  const brands = await ProductMaster.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$brand_name',
        // The catalogue holds no brand logos, so the first product image
        // stands in for one.
        image_url: { $first: '$pcode_img' },
        product_count: { $sum: 1 },
      },
    },
    // Most-stocked first: a brand with three products is not a brand tile.
    { $sort: { product_count: -1, _id: 1 } },
    { $limit: limit },
  ]);

  const items = brands
    .filter((brand) => brand._id && String(brand._id).trim())
    .map((brand) => ({
      id: String(brand._id),
      brand_name: String(brand._id).trim(),
      image_url: brand.image_url || '',
      product_count: brand.product_count,
    }));

  if (items.length === 0) return null;

  return section({
    id: 'brands',
    type: SECTION_TYPES.BRAND_STRIP,
    sourceSequence: 0,
    sourceCollection: 'products',
    items,
  });
}

/**
 * Arranges already-fetched, already-enriched documents into the ordered feed.
 *
 * Split from the fetching so the layout — the part with all the sequencing
 * rules — can be tested without a database.
 */
function assembleFeed({
  popular = [],
  seasonal = [],
  bestSellers = [],
  topSellers = [],
  hero = null,
  mid = null,
  ads = null,
  coupons = null,
  brands = null,
} = {}) {
  const popularBySeq = bySequenceMap(popular);
  const bestSellerBySeq = bySequenceMap(bestSellers);

  const sections = [];

  // 1. Category strip — popular-category section 1.
  const strip = popularBySeq.get(1);
  if (strip) {
    sections.push(
      section({
        id: strip._id,
        type: SECTION_TYPES.CATEGORY_STRIP,
        sourceSequence: 1,
        sourceCollection: 'popular_categories',
        title: strip.title,
        description: strip.description,
        style: styleOf(strip),
        items: strip.subcategories || [],
      })
    );
  }

  // 2. Hero banners, then any coupons. A saving stated up front is a reason
  //    to keep scrolling; stated at the bottom it is a reason to feel cheated.
  if (hero) sections.push(hero);
  if (coupons) sections.push(coupons);

  // 3. Popular category grids, best-seller rails and offer slots interleaved,
  //    exactly as the app lays them out today.
  const pairs = Math.max(BEST_SELLER_SLOTS, OFFER_SLOTS);
  for (let i = 0; i < pairs; i += 1) {
    const popularSeq = i + 2; // sections 2..5
    const popularDoc = popularBySeq.get(popularSeq);
    if (popularDoc) {
      sections.push(
        section({
          id: popularDoc._id,
          type: SECTION_TYPES.CATEGORY_GRID,
          sourceSequence: popularSeq,
          sourceCollection: 'popular_categories',
          title: popularDoc.title,
          description: popularDoc.description,
          style: styleOf(popularDoc),
          items: popularDoc.subcategories || [],
        })
      );
    }

    const bestSellerSeq = i + 1;
    const bestSellerDoc = bestSellerBySeq.get(bestSellerSeq);
    if (bestSellerDoc && i < BEST_SELLER_SLOTS) {
      sections.push(
        section({
          id: bestSellerDoc._id,
          type: SECTION_TYPES.PRODUCT_RAIL,
          sourceSequence: bestSellerSeq,
          sourceCollection: 'best_sellers',
          title: bestSellerDoc.title,
          description: bestSellerDoc.description,
          style: styleOf(bestSellerDoc),
          items: bestSellerDoc.products || [],
        })
      );
    }

    // Cart-dependent, so the server cannot fill it without making the feed
    // per-user. The client renders it from its own offers call.
    if (i < OFFER_SLOTS) {
      sections.push(personalizedSection({ type: SECTION_TYPES.OFFER_STRIP, index: i }));
    }

    // Mid-page banners, once, after the first block. A banner break belongs
    // between merchandising blocks rather than at the very bottom, where the
    // click-through would not repay the space.
    if (i === 0 && mid) sections.push(mid);
  }

  // 4. Top-seller rails, after the interleaved block.
  const topSellerRails = topSellers.slice(0, TOP_SELLER_SLOTS);
  topSellerRails.forEach((doc) => {
    const items = doc.products || [];
    if (items.length === 0) return;

    sections.push(
      section({
        id: doc._id,
        type: SECTION_TYPES.PRODUCT_RAIL,
        sourceSequence: Number(doc.sequence) || 0,
        sourceCollection: 'top_sellers',
        title: doc.title,
        description: doc.description,
        style: styleOf(doc),
        items,
      })
    );
  });

  // 5. Brands, then advertisements.
  if (brands) sections.push(brands);
  if (ads) sections.push(ads);

  // 5b. Recently viewed — personalized, so the server sends only a
  // placeholder for the client to fill from on-device history (see
  // PERSONALIZED_TYPES). This default layout previously omitted it entirely,
  // so any tenant that had never opened the Home Builder could never show
  // this rail at all, no matter how many products a shopper viewed.
  sections.push(personalizedSection({ type: SECTION_TYPES.RECENTLY_VIEWED, index: 0 }));

  // 6. Seasonal picks.
  const seasonalFirst = seasonal[0];
  if (seasonalFirst) {
    sections.push(
      section({
        id: seasonalFirst._id,
        type: SECTION_TYPES.SEASONAL_PICKS,
        sourceSequence: Number(seasonalFirst.sequence) || 1,
        sourceCollection: 'seasonal_categories',
        title: seasonalFirst.title,
        description: seasonalFirst.description,
        style: styleOf(seasonalFirst),
        items: seasonalFirst.subcategories || [],
      })
    );
  }

  // Assign render order last so slots stay contiguous however the layout was
  // assembled.
  return sections.map((s, index) => ({ ...s, slot: index }));
}

/**
 * The whole home feed for a store, in render order.
 *
 * Returns public, cacheable content only.
 */
async function buildHomeFeed({ storeCode, now = new Date() } = {}) {
  const query = storeQuery(storeCode);

  const [
    popularDocs,
    seasonalDocs,
    bestSellerDocs,
    topSellerDocs,
    hero,
    mid,
    ads,
    coupons,
    brands,
    layout,
  ] = await Promise.all([
    PopularCategory.find(query).sort(bySequence).lean(),
    SeasonalCategory.find(query).sort(bySequence).lean(),
    BestSeller.find(query).sort(bySequence).lean(),
    TopSeller.find(query).sort(bySequence).lean(),
    heroCarousel(storeCode),
    midBanners(storeCode),
    advertisementSection({ storeCode, now }),
    couponSection({ storeCode, now }),
    brandSection({ storeCode }),
    HomeSection.findRenderable({ storeCode, now }),
  ]);

  const [popular, seasonal, bestSellers, topSellers] = await Promise.all([
    enrichPopularCategorySections(popularDocs),
    enrichSeasonalCategorySections(seasonalDocs),
    enrichProducts(bestSellerDocs),
    enrichProducts(topSellerDocs),
  ]);

  // A tenant that has never opened the Home Builder has no layout documents,
  // and gets the default arrangement — so adopting the builder is opt-in and
  // reversible by deleting the documents.
  if (Array.isArray(layout) && layout.length > 0) {
    return assembleFromLayout({
      layout,
      popular,
      seasonal,
      bestSellers,
      topSellers,
      hero,
      mid,
      ads,
      coupons,
      brands,
    });
  }

  return assembleFeed({
    popular,
    seasonal,
    bestSellers,
    topSellers,
    hero,
    mid,
    ads,
    coupons,
    brands,
  });
}

/**
 * Builds the feed from an admin-defined layout (the HomeSection collection).
 *
 * Content still comes from the collections it always did; a HomeSection only
 * says which one, in what position. A section pointing at a document that has
 * since been deleted is dropped rather than rendered empty.
 */
function assembleFromLayout({ layout = [], popular = [], seasonal = [], bestSellers = [], topSellers = [], hero = null, mid = null, ads = null, coupons = null, brands = null } = {}) {
  const popularBySeq = bySequenceMap(popular);
  const seasonalBySeq = bySequenceMap(seasonal);
  const bestSellerBySeq = bySequenceMap(bestSellers);
  const topSellerBySeq = bySequenceMap(topSellers);

  // Banner placements a layout row can point at, by the panel's section_name.
  const bannersByPlacement = new Map([
    [BANNER_SECTIONS.HERO, hero],
    [BANNER_SECTIONS.MID, mid],
  ]);

  const sections = [];

  layout.forEach((entry, index) => {
    const type = entry.type;
    const sequence = entry.source && entry.source.sequence != null
      ? Number(entry.source.sequence)
      : null;

    // Placeholders the client fills; nothing to resolve server-side.
    if (PERSONALIZED_TYPES.includes(type)) {
      sections.push({
        ...personalizedSection({ type, index }),
        ...campaignMeta(entry),
        id: String(entry._id || `${type}-${index}`),
        title: entry.title || '',
        style: { background_color: (entry.style && entry.style.background_color) || '' },
      });
      return;
    }

    const collection = (entry.source && entry.source.collection_name) || 'none';
    const config = entry.config || {};

    // Banner-backed sections. The row picks its placement with
    // `config.section_name`; hero rows default to the top placement and
    // banner strips to the middle one, so an existing row keeps its meaning.
    if (type === SECTION_TYPES.HERO_CAROUSEL || collection === 'banners') {
      const placement =
        (config.section_name || '').toString().trim() ||
        (type === SECTION_TYPES.BANNER_STRIP ? BANNER_SECTIONS.MID : BANNER_SECTIONS.HERO);
      const banners = bannersByPlacement.get(placement);

      if (banners) {
        sections.push({
          ...banners,
          ...campaignMeta(entry),
          type,
          id: String(entry._id || banners.id),
          title: entry.title || banners.title,
          style: { background_color: (entry.style && entry.style.background_color) || '' },
        });
      }
      return;
    }

    // Sections whose content is derived rather than configured: there is no
    // document to point at, so the type alone resolves them.
    if (type === SECTION_TYPES.COUPON_STRIP) {
      if (coupons) {
        sections.push({
          ...coupons,
          ...campaignMeta(entry),
          id: String(entry._id || coupons.id),
          title: entry.title || coupons.title,
          style: { background_color: (entry.style && entry.style.background_color) || '' },
        });
      }
      return;
    }

    if (type === SECTION_TYPES.BRAND_STRIP) {
      if (brands) {
        sections.push({
          ...brands,
          ...campaignMeta(entry),
          id: String(entry._id || brands.id),
          title: entry.title || brands.title,
          style: { background_color: (entry.style && entry.style.background_color) || '' },
        });
      }
      return;
    }

    // Advertisement-backed sections. `ads` is prefetched for the default
    // category set; a row asking for a different category gets nothing rather
    // than the wrong creatives, since the fetch already happened.
    if (collection === 'advertisements') {
      const wanted = (config.category || '').toString().trim();
      const matches = !wanted || (ads && ads.id === `advertisements-${wanted}`);

      if (ads && matches) {
        sections.push({
          ...ads,
          ...campaignMeta(entry),
          type,
          id: String(entry._id || ads.id),
          title: entry.title || ads.title,
          style: { background_color: (entry.style && entry.style.background_color) || '' },
        });
      }
      return;
    }

    let doc = null;
    let items = [];
    // What the row actually resolved to, which is not always what it asked
    // for: an untyped product_rail falls back to best_sellers. The client is
    // told the resolved collection, not the requested one.
    let resolvedCollection = collection;

    if (collection === 'best_sellers' || (type === SECTION_TYPES.PRODUCT_RAIL && collection === 'none')) {
      doc = bestSellerBySeq.get(sequence);
      items = doc ? doc.products || [] : [];
      resolvedCollection = 'best_sellers';
    } else if (collection === 'top_sellers') {
      doc = topSellerBySeq.get(sequence);
      items = doc ? doc.products || [] : [];
    } else if (collection === 'seasonal_categories') {
      doc = seasonalBySeq.get(sequence);
      items = doc ? doc.subcategories || [] : [];
    } else {
      doc = popularBySeq.get(sequence);
      items = doc ? doc.subcategories || [] : [];
      resolvedCollection = 'popular_categories';
    }

    // The source document was deleted or deactivated; a heading with nothing
    // under it is worse than no section.
    if (!doc) return;

    sections.push({
      ...section({
        id: entry._id,
        type,
        sourceSequence: sequence,
        sourceCollection: resolvedCollection,
        title: entry.title || doc.title,
        description: doc.description,
        style: {
          background_color:
            (entry.style && entry.style.background_color) || styleOf(doc).background_color,
        },
        items,
      }),
      ...campaignMeta(entry),
    });
  });

  return sections.map((s, i) => ({ ...s, slot: i }));
}

module.exports = {
  buildHomeFeed,
  assembleFeed,
  assembleFromLayout,
  enrichProducts,
  SCHEMA_VERSION,
  SECTION_TYPES,
  BANNER_SECTIONS,
  BEST_SELLER_SLOTS,
  OFFER_SLOTS,
  TOP_SELLER_SLOTS,
};
