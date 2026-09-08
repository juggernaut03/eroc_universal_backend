const express = require('express');
const router = express.Router();

const SeasonalCategory = require('../models/SeasonalCategory');
const Subcategory = require('../models/Subcategory');
const Category = require('../models/Category');
const { normalizeStoreCodes } = require('../utils/routeHelpers');

const parseBoolean = (value, defaultValue) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') {
      return true;
    }
    if (lowered === 'false') {
      return false;
    }
  }

  return defaultValue;
};

const parseNumber = (value, defaultValue) => {
  if (value === null || value === undefined || value === '') {
    return defaultValue;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : defaultValue;
};

const normalizeSubcategoriesInput = (rawSubcategories) => {
  let subcategoryList = rawSubcategories;

  if (Array.isArray(subcategoryList)) {
    // ok
  } else if (subcategoryList && typeof subcategoryList === 'object') {
    subcategoryList = Object.values(subcategoryList);
  } else {
    subcategoryList = [];
  }

  return subcategoryList.map((item, index) => {
    if (typeof item === 'string' || typeof item === 'number') {
      return {
        sub_category_id: item.toString().trim(),
        position: index,
        metadata: {}
      };
    }

    if (!item || typeof item !== 'object') {
      throw new Error(`Invalid subcategory format at index ${index}`);
    }

    const {
      sub_category_id,
      subcategory_id,
      store_code,
      position,
      metadata,
      redirect_url,
      ...rest
    } = item;

    const resolvedSubCategoryId = (sub_category_id || subcategory_id);

    if (!resolvedSubCategoryId || resolvedSubCategoryId.toString().trim() === '') {
      throw new Error(`Subcategory at index ${index} is missing sub_category_id`);
    }

    const normalizedPosition = parseNumber(position, index);
    const normalizedStoreCode = store_code ? store_code.toString().trim() : undefined;

    let normalizedMetadata = metadata;
    if (!normalizedMetadata || typeof normalizedMetadata !== 'object') {
      normalizedMetadata = {};
    }

    Object.entries(rest).forEach(([key, value]) => {
      if (value !== undefined) {
        normalizedMetadata[key] = value;
      }
    });

    const normalizedItem = {
      sub_category_id: resolvedSubCategoryId.toString().trim(),
      position: normalizedPosition,
      metadata: normalizedMetadata
    };

    if (redirect_url !== undefined && redirect_url !== null) {
      const trimmedRedirect = redirect_url.toString().trim();
      if (trimmedRedirect !== '') {
        normalizedItem.redirect_url = trimmedRedirect;
      }
    }

    if (normalizedStoreCode) {
      normalizedItem.store_code = normalizedStoreCode;
    }

    return normalizedItem;
  });
};

const resolveBannerUrls = ({ banner_urls, banner_url_desktop, banner_url_mobile, banner_url }) => {
  if (banner_urls && typeof banner_urls === 'object') {
    const desktop = banner_urls.desktop ? banner_urls.desktop.toString().trim() : '';
    const mobile = banner_urls.mobile ? banner_urls.mobile.toString().trim() : '';

    if (!desktop || !mobile) {
      throw new Error('banner_urls.desktop and banner_urls.mobile are required');
    }

    return { desktop, mobile };
  }

  const desktop = banner_url_desktop ? banner_url_desktop.toString().trim() : banner_url ? banner_url.toString().trim() : '';
  const mobile = banner_url_mobile ? banner_url_mobile.toString().trim() : '';

  if (!desktop || !mobile) {
    throw new Error('banner_url_desktop and banner_url_mobile are required');
  }

  return { desktop, mobile };
};

const mapSubcategory = (subcategory) => ({
  id: subcategory._id,
  idsub_category_master: subcategory.idsub_category_master,
  sub_category_name: subcategory.sub_category_name,
  category_id: subcategory.category_id,
  main_category_name: subcategory.main_category_name,
  dept_id: subcategory.dept_id,
  store_code: subcategory.store_code,
  sequence_id: subcategory.sequence_id,
  image_link: subcategory.image_link,
  sub_category_bg_color: subcategory.sub_category_bg_color
});

const mapCategory = (category) => ({
  id: category._id,
  idcategory_master: category.idcategory_master,
  category_name: category.category_name,
  dept_id: category.dept_id,
  store_code: category.store_code,
  sequence_id: category.sequence_id,
  no_of_col: category.no_of_col,
  image_link: category.image_link,
  category_bg_color: category.category_bg_color
});

const toSafeString = (value) => {
  if (value === null || value === undefined) {
    return null;
  }

  const str = value.toString().trim();
  return str === '' ? null : str;
};

const addCandidateId = (set, value) => {
  const stringValue = toSafeString(value);
  if (stringValue) {
    set.add(stringValue);
  }
};

const buildEnrichmentMaps = async (sections) => {
  const subcategoryIds = new Set();
  const categoryIds = new Set();

  sections.forEach((section) => {
    const items = Array.isArray(section.subcategories) ? section.subcategories : [];
    items.forEach((item) => {
      // An explicit reference_type of 'category' means sub_category_id is a
      // Category id, not a Subcategory id — resolve it there directly rather
      // than through the ambiguous subcategory-first fallback below (see the
      // field's own schema comment for why this exists).
      if (item.reference_type === 'category') {
        addCandidateId(categoryIds, item.sub_category_id);
      } else {
        addCandidateId(subcategoryIds, item.sub_category_id);
      }

      if (item?.metadata && typeof item.metadata === 'object') {
        const { metadata } = item;
        addCandidateId(subcategoryIds, metadata.sub_category_id);
        addCandidateId(subcategoryIds, metadata.idsub_category_master);

        addCandidateId(categoryIds, metadata.category_id);
        addCandidateId(categoryIds, metadata.idcategory_master);
        addCandidateId(categoryIds, metadata.categoryId);
        addCandidateId(categoryIds, metadata.parent_category_id);
        addCandidateId(categoryIds, metadata.category_master_id);
      }
    });
  });

  const subcategoryIdList = Array.from(subcategoryIds);
  const subcategoriesFromDb = subcategoryIdList.length
    ? await Subcategory.find({
      idsub_category_master: { $in: subcategoryIdList },
      is_visible: { $ne: false }
    }).lean()
    : [];

  const subcategoryMap = new Map();
  subcategoriesFromDb.forEach((subcategory) => {
    subcategoryMap.set(subcategory.idsub_category_master, mapSubcategory(subcategory));
    addCandidateId(categoryIds, subcategory.category_id);
  });

  sections.forEach((section) => {
    const items = Array.isArray(section.subcategories) ? section.subcategories : [];
    items.forEach((item) => {
      if (!subcategoryMap.has(item.sub_category_id)) {
        addCandidateId(categoryIds, item.sub_category_id);
      }
    });
  });

  const categoryIdList = Array.from(categoryIds);
  const categoriesFromDb = categoryIdList.length
    ? await Category.find({
      idcategory_master: { $in: categoryIdList },
      is_visible: { $ne: false }
    }).lean()
    : [];

  const categoryMap = new Map();
  categoriesFromDb.forEach((category) => {
    categoryMap.set(category.idcategory_master, mapCategory(category));
  });

  return { subcategoryMap, categoryMap };
};

const resolveCategoryDetails = (item, subcategoryDetails, categoryMap) => {
  const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};

  // Explicit and first: sub_category_id names a Category directly, so it
  // must win over any metadata guesswork or a same-numbered subcategory's
  // own parent below.
  if (item.reference_type === 'category') {
    const direct = toSafeString(item.sub_category_id);
    if (direct && categoryMap.has(direct)) {
      return categoryMap.get(direct);
    }
  }

  const candidateCategoryIds = [
    metadata.category_id,
    metadata.idcategory_master,
    metadata.categoryId,
    metadata.parent_category_id,
    metadata.category_master_id,
    subcategoryDetails?.category_id
  ];

  if (!subcategoryDetails && item.reference_type !== 'category') {
    candidateCategoryIds.push(item.sub_category_id);
  }

  const matched = candidateCategoryIds
    .map(toSafeString)
    .find((candidate) => candidate && categoryMap.has(candidate));

  return matched ? categoryMap.get(matched) : null;
};

const resolveImageLink = (item, subcategoryDetails, categoryDetails) => {
  const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const candidateImages = [
    metadata.image_link,
    metadata.image_url,
    metadata.category_image,
    metadata.subcategory_image,
    subcategoryDetails?.image_link,
    categoryDetails?.image_link
  ];

  const matched = candidateImages
    .map((value) => {
      const stringValue = toSafeString(value);
      return stringValue || null;
    })
    .find((value) => value);

  return matched || null;
};

const resolveCategoryUrl = (item, subcategoryDetails, categoryDetails) => {
  const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};

  const categoryUrlCandidates = [
    metadata.category_url,
    categoryDetails ? `app://category/${categoryDetails.idcategory_master}` : null,
    !categoryDetails && subcategoryDetails?.category_id
      ? `app://category/${subcategoryDetails.category_id}`
      : null
  ];

  const matched = categoryUrlCandidates
    .map((value) => {
      const stringValue = toSafeString(value);
      return stringValue || null;
    })
    .find((value) => value);

  return matched || null;
};

const resolveSubcategoryUrl = (item, subcategoryDetails) => {
  const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};

  const subcategoryUrlCandidates = [
    metadata.subcategory_url,
    subcategoryDetails ? `app://subcategory/${subcategoryDetails.idsub_category_master}` : null
  ];

  const matched = subcategoryUrlCandidates
    .map((value) => {
      const stringValue = toSafeString(value);
      return stringValue || null;
    })
    .find((value) => value);

  return matched || null;
};

const enrichSubcategoryItem = (item, subcategoryMap, categoryMap) => {
  // A category-typed item's id was never added to subcategoryIds (see
  // buildEnrichmentMaps), but skip the subcategory map explicitly rather
  // than relying on that — a *different* tile in the same batch can put the
  // same number into subcategoryMap as a genuine subcategory, and this item
  // must not accidentally pick that up.
  if (item.reference_type === 'category') {
    const categoryDetails = resolveCategoryDetails(item, null, categoryMap);
    const imageLink = resolveImageLink(item, null, categoryDetails);
    const categoryUrl = resolveCategoryUrl(item, null, categoryDetails);

    return {
      ...item,
      redirect_url: toSafeString(item.redirect_url) || categoryUrl || null,
      subcategory_details: null,
      category_details: categoryDetails,
      image_link: imageLink,
      category_url: categoryUrl,
      subcategory_url: null
    };
  }

  const baseSubcategoryId = toSafeString(item.sub_category_id);
  const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const metadataSubcategoryId = toSafeString(metadata.sub_category_id || metadata.idsub_category_master);

  const subcategoryDetails = baseSubcategoryId && subcategoryMap.has(baseSubcategoryId)
    ? subcategoryMap.get(baseSubcategoryId)
    : metadataSubcategoryId && subcategoryMap.has(metadataSubcategoryId)
      ? subcategoryMap.get(metadataSubcategoryId)
      : null;

  const categoryDetails = resolveCategoryDetails(item, subcategoryDetails, categoryMap);
  const imageLink = resolveImageLink(item, subcategoryDetails, categoryDetails);
  const categoryUrl = resolveCategoryUrl(item, subcategoryDetails, categoryDetails);
  const subcategoryUrl = resolveSubcategoryUrl(item, subcategoryDetails);

  const resolvedRedirectUrl = toSafeString(item.redirect_url)
    || categoryUrl
    || subcategoryUrl
    || null;

  return {
    ...item,
    redirect_url: resolvedRedirectUrl,
    subcategory_details: subcategoryDetails,
    category_details: categoryDetails,
    image_link: imageLink,
    category_url: categoryUrl,
    subcategory_url: subcategoryUrl
  };
};

const enrichSeasonalCategorySections = async (sections) => {
  if (!Array.isArray(sections) || sections.length === 0) {
    return sections;
  }

  const { subcategoryMap, categoryMap } = await buildEnrichmentMaps(sections);

  return sections.map((section) => ({
    ...section,
    subcategories: (section.subcategories || [])
      .map((item) => enrichSubcategoryItem(item, subcategoryMap, categoryMap))
      // An item that names a subcategory but resolves to none was either a
      // dangling reference or — the common case now — points at a
      // subcategory an admin just hid from the storefront. Drop the tile
      // rather than showing it with its name/image missing. A category-typed
      // item is judged on category_details instead — subcategory_details is
      // always null for those, which the old subcategory-only check would
      // have wrongly treated as "unresolved" and dropped every one of them.
      .filter((item) => {
        if (!toSafeString(item.sub_category_id)) return true;
        return item.reference_type === 'category'
          ? Boolean(item.category_details)
          : Boolean(item.subcategory_details);
      })
  }));
};

router.post('/', async (req, res, next) => {
  try {
    const {
      banner_urls,
      banner_url,
      banner_url_desktop,
      banner_url_mobile,
      background_color,
      title,
      description,
      store_code,
      store_codes,
      sequence,
      is_active,
      subcategories,
      redirect_url
    } = req.body;

    let normalizedBannerUrls;
    try {
      normalizedBannerUrls = resolveBannerUrls({ banner_urls, banner_url, banner_url_desktop, banner_url_mobile });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message || 'Invalid banner URLs provided'
      });
    }

    if (!background_color || background_color.toString().trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'background_color is required'
      });
    }

    if (!title || title.toString().trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'title is required'
      });
    }

    const normalizedSubcategories = normalizeSubcategoriesInput(subcategories || []);

    if (!normalizedSubcategories.length) {
      return res.status(400).json({
        success: false,
        error: 'At least one subcategory must be provided'
      });
    }

    const normalizedStoreCodes = normalizeStoreCodes(store_code, store_codes);

    const { season, start_date, end_date } = req.body;

    const seasonalCategoryData = {
      banner_urls: normalizedBannerUrls,
      background_color: background_color.toString().trim(),
      title: title.toString().trim(),
      description: description && description.toString().trim() !== '' ? description.toString().trim() : undefined,
      subcategories: normalizedSubcategories,
      is_active: parseBoolean(is_active, true),
      sequence: parseNumber(sequence, 0)
    };

    if (normalizedStoreCodes && normalizedStoreCodes.length > 0) {
      seasonalCategoryData.store_codes = normalizedStoreCodes;
      seasonalCategoryData.store_code = normalizedStoreCodes[0];
    } else {
      seasonalCategoryData.store_code = null;
      seasonalCategoryData.store_codes = undefined;
    }

    if (redirect_url !== undefined) {
      if (redirect_url === null) {
        seasonalCategoryData.redirect_url = null;
      } else {
        const trimmedRedirect = redirect_url.toString().trim();
        seasonalCategoryData.redirect_url = trimmedRedirect !== '' ? trimmedRedirect : null;
      }
    }

    if (season !== undefined) {
      seasonalCategoryData.season = season;
    }

    if (start_date !== undefined) {
      seasonalCategoryData.start_date = start_date;
    }

    if (end_date !== undefined) {
      seasonalCategoryData.end_date = end_date;
    }

    const seasonalCategory = new SeasonalCategory(seasonalCategoryData);

    const savedSeasonalCategory = await seasonalCategory.save();

    res.status(201).json({
      success: true,
      message: 'Seasonal category section created successfully',
      data: savedSeasonalCategory
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    next(error);
  }
});

router.post('/list', async (req, res, next) => {
  try {
    const {
      store_code,
      include_inactive,
      enrich_subcategories,
      season
    } = req.body;

    const includeInactive = parseBoolean(include_inactive, false);
    const shouldEnrich = parseBoolean(enrich_subcategories, false);

    const query = {};

    if (!includeInactive) {
      query.is_active = true;
      const now = new Date();
      query.start_date = { $lte: now };
      query.$or = [
        { end_date: { $exists: false } },
        { end_date: null },
        { end_date: { $gte: now } }
      ];
    }

    if (store_code && store_code.toString().trim() !== '') {
      const trimmedCode = store_code.toString().trim();
      const storeQuery = {
        $or: [
          { store_codes: trimmedCode },
          { store_code: trimmedCode }
        ]
      };

      if (query.$or) {
        query.$and = [{ $or: query.$or }, storeQuery];
        delete query.$or;
      } else {
        query.$or = storeQuery.$or;
      }
    }

    if (season && season !== 'all') {
      query.season = season;
    }

    const seasonalCategories = await SeasonalCategory.find(query).sort({ sequence: 1, createdAt: -1 }).lean();

    if (!seasonalCategories.length) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: 'No seasonal category sections found',
        data: []
      });
    }

    const responseData = shouldEnrich
      ? await enrichSeasonalCategorySections(seasonalCategories)
      : seasonalCategories;

    res.status(200).json({
      success: true,
      count: responseData.length,
      message: `Found ${responseData.length} seasonal category section(s)`,
      data: responseData
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { enrich_subcategories } = req.query;
    const shouldEnrich = parseBoolean(enrich_subcategories, false);

    const seasonalCategory = await SeasonalCategory.findById(id).lean();

    if (!seasonalCategory) {
      return res.status(404).json({
        success: false,
        error: 'Seasonal category section not found'
      });
    }

    const responseData = shouldEnrich
      ? (await enrichSeasonalCategorySections([seasonalCategory]))[0]
      : seasonalCategory;

    res.status(200).json({
      success: true,
      message: 'Seasonal category section fetched successfully',
      data: responseData
    });
  } catch (error) {
    next(error);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      banner_urls,
      banner_url,
      banner_url_desktop,
      banner_url_mobile,
      background_color,
      title,
      description,
      store_code,
      store_codes,
      sequence,
      is_active,
      subcategories,
      redirect_url,
      season,
      start_date,
      end_date
    } = req.body;

    const updatePayload = {};

    const hasLegacyBannerUrl = banner_url !== undefined;
    const hasDesktopBannerUrl = banner_url_desktop !== undefined;
    const hasMobileBannerUrl = banner_url_mobile !== undefined;

    if (banner_urls !== undefined) {
      if (!banner_urls || typeof banner_urls !== 'object') {
        return res.status(400).json({
          success: false,
          error: 'banner_urls must be an object containing desktop and mobile URLs'
        });
      }

      const desktop = banner_urls.desktop ? banner_urls.desktop.toString().trim() : '';
      const mobile = banner_urls.mobile ? banner_urls.mobile.toString().trim() : '';

      if (!desktop || !mobile) {
        return res.status(400).json({
          success: false,
          error: 'banner_urls.desktop and banner_urls.mobile cannot be empty'
        });
      }

      updatePayload.banner_urls = { desktop, mobile };
    } else if (hasLegacyBannerUrl || hasDesktopBannerUrl || hasMobileBannerUrl) {
      if (hasLegacyBannerUrl) {
        return res.status(400).json({
          success: false,
          error: 'banner_url is no longer supported. Please provide banner_url_desktop and banner_url_mobile.'
        });
      }

      if (!hasDesktopBannerUrl || !hasMobileBannerUrl) {
        return res.status(400).json({
          success: false,
          error: 'Both banner_url_desktop and banner_url_mobile must be provided together'
        });
      }

      const desktop = banner_url_desktop ? banner_url_desktop.toString().trim() : '';
      const mobile = banner_url_mobile ? banner_url_mobile.toString().trim() : '';

      if (!desktop || !mobile) {
        return res.status(400).json({
          success: false,
          error: 'banner_url_desktop and banner_url_mobile cannot be empty'
        });
      }

      updatePayload.banner_urls = { desktop, mobile };
    }

    if (background_color !== undefined) {
      if (background_color === null || background_color.toString().trim() === '') {
        return res.status(400).json({
          success: false,
          error: 'background_color cannot be empty'
        });
      }
      updatePayload.background_color = background_color.toString().trim();
    }

    if (title !== undefined) {
      if (title === null || title.toString().trim() === '') {
        return res.status(400).json({
          success: false,
          error: 'title cannot be empty'
        });
      }
      updatePayload.title = title.toString().trim();
    }

    if (description !== undefined) {
      updatePayload.description = description && description.toString().trim() !== ''
        ? description.toString().trim()
        : undefined;
    }

    if (store_code !== undefined || store_codes !== undefined) {
      const normalizedStoreCodes = normalizeStoreCodes(store_code, store_codes);

      if (normalizedStoreCodes && normalizedStoreCodes.length > 0) {
        updatePayload.store_codes = normalizedStoreCodes;
        updatePayload.store_code = normalizedStoreCodes[0];
      } else {
        updatePayload.store_code = null;
        updatePayload.store_codes = undefined;
      }
    }

    if (subcategories !== undefined) {
      const normalizedSubcategories = normalizeSubcategoriesInput(subcategories);

      if (!normalizedSubcategories.length) {
        return res.status(400).json({
          success: false,
          error: 'At least one subcategory must be provided'
        });
      }

      updatePayload.subcategories = normalizedSubcategories;
    }

    if (is_active !== undefined) {
      updatePayload.is_active = parseBoolean(is_active, true);
    }

    if (sequence !== undefined) {
      updatePayload.sequence = parseNumber(sequence, 0);
    }

    if (redirect_url !== undefined) {
      if (redirect_url === null) {
        updatePayload.redirect_url = null;
      } else {
        const trimmedRedirect = redirect_url.toString().trim();
        updatePayload.redirect_url = trimmedRedirect !== '' ? trimmedRedirect : null;
      }
    }

    if (season !== undefined) {
      updatePayload.season = season;
    }

    if (start_date !== undefined) {
      updatePayload.start_date = start_date;
    }

    if (end_date !== undefined) {
      updatePayload.end_date = end_date;
    }

    const updatedSeasonalCategory = await SeasonalCategory.findByIdAndUpdate(
      id,
      updatePayload,
      {
        new: true,
        runValidators: true
      }
    );

    if (!updatedSeasonalCategory) {
      return res.status(404).json({
        success: false,
        error: 'Seasonal category section not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Seasonal category section updated successfully',
      data: updatedSeasonalCategory
    });
  } catch (error) {
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }

    next(error);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const deletedSeasonalCategory = await SeasonalCategory.findByIdAndDelete(id);

    if (!deletedSeasonalCategory) {
      return res.status(404).json({
        success: false,
        error: 'Seasonal category section not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Seasonal category section deleted successfully',
      data: {
        id: deletedSeasonalCategory._id
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

// See the note in routes/popular-categories.js — shared with the home feed
// builder so both produce identically enriched sections.
module.exports.enrichSeasonalCategorySections = enrichSeasonalCategorySections;
