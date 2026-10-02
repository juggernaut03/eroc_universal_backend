const express = require('express');
const router = express.Router();

const Advertisement = require('../models/Advertisement');
const ProductMaster = require('../models/ProductMaster');
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

const parseDate = (value, options = {}) => {
  const {
    startOfDay = false,
    endOfDay = false
  } = options;

  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  if (startOfDay) {
    date.setHours(0, 0, 0, 0);
  } else if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  }

  return date;
};

const normalizeBannerInput = ({ banner_urls, banner_url }) => {
  let normalizedBannerUrl = banner_url ? banner_url.toString().trim() : '';
  let normalizedBannerUrls;

  if (banner_urls && typeof banner_urls === 'object') {
    const desktop = banner_urls.desktop ? banner_urls.desktop.toString().trim() : '';
    const mobile = banner_urls.mobile ? banner_urls.mobile.toString().trim() : '';

    if (!desktop && !mobile) {
      throw new Error('At least one of banner_urls.desktop or banner_urls.mobile must be provided');
    }

    normalizedBannerUrls = {};
    if (desktop) {
      normalizedBannerUrls.desktop = desktop;
    }
    if (mobile) {
      normalizedBannerUrls.mobile = mobile;
    }

    if (!normalizedBannerUrl) {
      normalizedBannerUrl = desktop || mobile;
    }
  }

  if (!normalizedBannerUrl) {
    throw new Error('banner_url is required');
  }

  return {
    banner_url: normalizedBannerUrl,
    banner_urls: normalizedBannerUrls
  };
};

const normalizeProductsInput = (rawProducts) => {
  let productList = rawProducts;

  if (Array.isArray(productList)) {
    // ok
  } else if (productList && typeof productList === 'object') {
    productList = Object.values(productList);
  } else {
    productList = [];
  }

  return productList.map((product, index) => {
    if (typeof product === 'string' || typeof product === 'number') {
      return {
        p_code: product.toString().trim(),
        position: index,
        metadata: {}
      };
    }

    if (!product || typeof product !== 'object') {
      throw new Error(`Invalid product format at index ${index}`);
    }

    const {
      p_code,
      store_code,
      position,
      metadata,
      redirect_url,
      ...rest
    } = product;

    if (!p_code || p_code.toString().trim() === '') {
      throw new Error(`Product at index ${index} is missing p_code`);
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

    const normalizedProduct = {
      p_code: p_code.toString().trim(),
      position: normalizedPosition,
      metadata: normalizedMetadata
    };

    if (normalizedStoreCode) {
      normalizedProduct.store_code = normalizedStoreCode;
    }

    if (redirect_url !== undefined && redirect_url !== null) {
      const trimmedRedirect = redirect_url.toString().trim();
      if (trimmedRedirect !== '') {
        normalizedProduct.redirect_url = trimmedRedirect;
      }
    }

    return normalizedProduct;
  });
};

// listing is the one stores[] entry this call resolved for the product —
// the caller's own store_code when it has one, otherwise the first active
// listing found (same "arbitrary store wins" ambiguity this already had
// when every store's price/stock sat directly on the document; it's just
// explicit now instead of whichever document the DB happened to return
// first).
const mapProductMaster = (product, listing) => ({
  id: product._id,
  p_code: product.p_code,
  barcode: product.barcode,
  product_name: product.product_name,
  product_description: product.product_description,
  package_size: product.package_size,
  package_unit: product.package_unit,
  product_mrp: listing?.product_mrp ? parseFloat(listing.product_mrp.toString()) : 0,
  our_price: listing?.our_price ? parseFloat(listing.our_price.toString()) : 0,
  brand_name: product.brand_name,
  store_code: listing?.store_code,
  pcode_status: listing?.pcode_status,
  dept_id: product.dept_id,
  category_id: product.category_id,
  sub_category_id: product.sub_category_id,
  store_quantity: listing?.store_quantity,
  max_quantity_allowed: listing?.max_quantity_allowed,
  pcode_img: product.pcode_img
});

router.post('/', async (req, res, next) => {
  try {
    const {
      title,
      description,
      banner_url,
      banner_urls,
      redirect_url,
      category,
      store_code,
      store_codes,
      is_active,
      start_date,
      end_date,
      sequence,
      metadata,
      products
    } = req.body;

    if (!title || title.toString().trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'title is required'
      });
    }

    if (!category || category.toString().trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'category is required'
      });
    }

    let normalizedBannerData;
    try {
      normalizedBannerData = normalizeBannerInput({ banner_url, banner_urls });
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message || 'Invalid banner data provided'
      });
    }

    const parsedStartDate = parseDate(start_date, { startOfDay: true });
    if (!parsedStartDate) {
      return res.status(400).json({
        success: false,
        error: 'start_date is required and must be a valid date'
      });
    }

    const parsedEndDate = parseDate(end_date, { endOfDay: true });

    let normalizedProducts = [];
    try {
      normalizedProducts = normalizeProductsInput(products || []);
    } catch (error) {
      return res.status(400).json({
        success: false,
        error: error.message || 'Invalid products provided'
      });
    }

    if (!normalizedProducts.length) {
      return res.status(400).json({
        success: false,
        error: 'At least one product must be provided'
      });
    }

    const normalizedStoreCodes = normalizeStoreCodes(store_code, store_codes);

    const advertisementData = {
      title: title.toString().trim(),
      description: description && description.toString().trim() !== '' ? description.toString().trim() : undefined,
      banner_url: normalizedBannerData.banner_url,
      banner_urls: normalizedBannerData.banner_urls,
      redirect_url: redirect_url && redirect_url.toString().trim() !== '' ? redirect_url.toString().trim() : undefined,
      category: category.toString().trim(),
      is_active: parseBoolean(is_active, true),
      start_date: parsedStartDate,
      end_date: parsedEndDate || undefined,
      sequence: parseNumber(sequence, 0),
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      products: normalizedProducts
    };

    if (normalizedStoreCodes && normalizedStoreCodes.length > 0) {
      advertisementData.store_codes = normalizedStoreCodes;
      advertisementData.store_code = normalizedStoreCodes[0];
    } else {
      advertisementData.store_code = null;
      advertisementData.store_codes = undefined;
    }

    const advertisement = new Advertisement(advertisementData);

    const savedAdvertisement = await advertisement.save();

    res.status(201).json({
      success: true,
      message: 'Advertisement created successfully',
      data: savedAdvertisement
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
      category,
      is_active,
      active_only,
      active_on,
      include_expired,
      limit,
      enrich_products
    } = req.body;

    const shouldOnlyActive = parseBoolean(active_only, false);
    const activeDate = parseDate(active_on) || new Date();
    const includeExpired = parseBoolean(include_expired, true);

    const filters = {};

    if (category && category.toString().trim() !== '') {
      filters.category = category.toString().trim();
    }

    if (store_code && store_code.toString().trim() !== '') {
      const trimmedCode = store_code.toString().trim();
      filters.$or = [
        { store_codes: trimmedCode },
        { store_code: trimmedCode }
      ];
    }

    const parsedIsActive = parseBoolean(is_active, null);
    if (parsedIsActive !== null) {
      filters.is_active = parsedIsActive;
    }

    if (shouldOnlyActive) {
      filters.is_active = true;
      filters.start_date = { $lte: activeDate };

      if (!filters.$or) {
        filters.$or = [];
      } else {
        const storeConditions = filters.$or;
        delete filters.$or;
        filters.$and = [
          { $or: storeConditions },
          {
            $or: [
              { end_date: { $exists: false } },
              { end_date: null },
              { end_date: { $gte: activeDate } }
            ]
          }
        ];
      }

      if (!filters.$and) {
        filters.$or = [
          { end_date: { $exists: false } },
          { end_date: null },
          { end_date: { $gte: activeDate } }
        ];
      }
    } else if (!includeExpired) {
      const now = new Date();

      if (!filters.$or) {
        filters.$or = [];
      } else {
        const storeConditions = filters.$or;
        delete filters.$or;
        filters.$and = [
          { $or: storeConditions },
          {
            $or: [
              { end_date: { $exists: false } },
              { end_date: null },
              { end_date: { $gte: now } }
            ]
          }
        ];
      }

      if (!filters.$and) {
        filters.$or = [
          { end_date: { $exists: false } },
          { end_date: null },
          { end_date: { $gte: now } }
        ];
      }
    }

    const query = Advertisement.find(filters).sort({ sequence: 1, start_date: -1, createdAt: -1 });

    if (limit && Number.isFinite(Number(limit))) {
      query.limit(Number(limit));
    }

    const advertisements = await query.lean();

    const shouldEnrich = parseBoolean(enrich_products, false);

    let responseData = advertisements;

    if (shouldEnrich && advertisements.length) {
      const productCodes = Array.from(new Set(
        advertisements.flatMap(ad => (ad.products || []).map(product => product.p_code))
      ));

      const trimmedStoreCode = store_code && store_code.toString().trim();
      const productsFromDb = await ProductMaster.find({
        p_code: { $in: productCodes },
        stores: { $elemMatch: trimmedStoreCode ? { store_code: trimmedStoreCode, pcode_status: 'Y' } : { pcode_status: 'Y' } }
      });

      const productMap = new Map();
      productsFromDb.forEach((product) => {
        const listing = trimmedStoreCode
          ? product.stores.find((s) => s.store_code === trimmedStoreCode)
          : product.stores.find((s) => s.pcode_status === 'Y');
        productMap.set(product.p_code, mapProductMaster(product, listing));
      });

      responseData = advertisements.map((ad) => ({
        ...ad,
        products: (ad.products || []).map((product) => ({
          ...product,
          product_details: productMap.get(product.p_code) || null
        }))
      }));
    }

    res.status(200).json({
      success: true,
      count: responseData.length,
      message: `Found ${responseData.length} advertisement(s)`,
      data: responseData
    });
  } catch (error) {
    next(error);
  }
});

router.post('/active', async (req, res, next) => {
  try {
    const { store_code, category, active_on, limit, enrich_products } = req.body;

    const activeDate = parseDate(active_on, { endOfDay: true }) || new Date();

    const filters = {
      is_active: true,
      start_date: { $lte: activeDate }
    };

    if (category && category.toString().trim() !== '') {
      filters.category = category.toString().trim();
    }

    if (store_code && store_code.toString().trim() !== '') {
      const trimmedCode = store_code.toString().trim();
      filters.$and = [
        {
          $or: [
            { end_date: { $exists: false } },
            { end_date: null },
            { end_date: { $gte: activeDate } }
          ]
        },
        {
          $or: [
            { store_codes: trimmedCode },
            { store_code: trimmedCode }
          ]
        }
      ];
    } else {
      filters.$or = [
        { end_date: { $exists: false } },
        { end_date: null },
        { end_date: { $gte: activeDate } }
      ];
    }

    const query = Advertisement.find(filters).sort({ sequence: 1, start_date: -1 });

    if (limit && Number.isFinite(Number(limit))) {
      query.limit(Number(limit));
    }

    const advertisements = await query.lean();

    const shouldEnrich = parseBoolean(enrich_products, false);
    let responseData = advertisements;

    if (shouldEnrich && advertisements.length) {
      const productCodes = Array.from(new Set(
        advertisements.flatMap(ad => (ad.products || []).map(product => product.p_code))
      ));

      const trimmedStoreCode = store_code && store_code.toString().trim();
      const productsFromDb = await ProductMaster.find({
        p_code: { $in: productCodes },
        stores: { $elemMatch: trimmedStoreCode ? { store_code: trimmedStoreCode, pcode_status: 'Y' } : { pcode_status: 'Y' } }
      });

      const productMap = new Map();
      productsFromDb.forEach((product) => {
        const listing = trimmedStoreCode
          ? product.stores.find((s) => s.store_code === trimmedStoreCode)
          : product.stores.find((s) => s.pcode_status === 'Y');
        productMap.set(product.p_code, mapProductMaster(product, listing));
      });

      responseData = advertisements.map((ad) => ({
        ...ad,
        products: (ad.products || []).map((product) => ({
          ...product,
          product_details: productMap.get(product.p_code) || null
        }))
      }));
    }

    res.status(200).json({
      success: true,
      count: responseData.length,
      message: `Found ${responseData.length} active advertisement(s)`,
      data: responseData
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { enrich_products } = req.query;

    const advertisement = await Advertisement.findById(id).lean();

    if (!advertisement) {
      return res.status(404).json({
        success: false,
        error: 'Advertisement not found'
      });
    }

    let responseData = advertisement;

    if (parseBoolean(enrich_products, false) && advertisement.products && advertisement.products.length) {
      const productCodes = advertisement.products.map(product => product.p_code);

      const productsFromDb = await ProductMaster.find({
        p_code: { $in: productCodes },
        stores: { $elemMatch: { pcode_status: 'Y' } }
      });

      const productMap = new Map();
      productsFromDb.forEach((product) => {
        const listing = product.stores.find((s) => s.pcode_status === 'Y');
        productMap.set(product.p_code, mapProductMaster(product, listing));
      });

      responseData = {
        ...advertisement,
        products: advertisement.products.map((product) => ({
          ...product,
          product_details: productMap.get(product.p_code) || null
        }))
      };
    }

    res.status(200).json({
      success: true,
      message: 'Advertisement fetched successfully',
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
      title,
      description,
      banner_url,
      banner_urls,
      redirect_url,
      category,
      store_code,
      store_codes,
      is_active,
      start_date,
      end_date,
      sequence,
      metadata,
      products
    } = req.body;

    const updatePayload = {};

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

    if (banner_url !== undefined || banner_urls !== undefined) {
      let normalizedBannerData;
      try {
        normalizedBannerData = normalizeBannerInput({
          banner_url: banner_url !== undefined ? banner_url : updatePayload.banner_url,
          banner_urls
        });
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error.message || 'Invalid banner data provided'
        });
      }

      updatePayload.banner_url = normalizedBannerData.banner_url;
      updatePayload.banner_urls = normalizedBannerData.banner_urls;
    }

    if (redirect_url !== undefined) {
      updatePayload.redirect_url = redirect_url && redirect_url.toString().trim() !== ''
        ? redirect_url.toString().trim()
        : undefined;
    }

    if (category !== undefined) {
      if (category === null || category.toString().trim() === '') {
        return res.status(400).json({
          success: false,
          error: 'category cannot be empty'
        });
      }
      updatePayload.category = category.toString().trim();
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

    if (is_active !== undefined) {
      updatePayload.is_active = parseBoolean(is_active, true);
    }

    if (start_date !== undefined) {
      const parsedStartDate = parseDate(start_date, { startOfDay: true });
      if (!parsedStartDate) {
        return res.status(400).json({
          success: false,
          error: 'start_date must be a valid date'
        });
      }
      updatePayload.start_date = parsedStartDate;
    }

    if (end_date !== undefined) {
      const parsedEndDate = parseDate(end_date, { endOfDay: true });
      updatePayload.end_date = parsedEndDate || undefined;
    }

    if (sequence !== undefined) {
      updatePayload.sequence = parseNumber(sequence, 0);
    }

    if (metadata !== undefined) {
      updatePayload.metadata = metadata && typeof metadata === 'object' ? metadata : {};
    }

    if (products !== undefined) {
      let normalizedProducts;
      try {
        normalizedProducts = normalizeProductsInput(products);
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error.message || 'Invalid products provided'
        });
      }

      if (!normalizedProducts.length) {
        return res.status(400).json({
          success: false,
          error: 'At least one product must be provided'
        });
      }

      updatePayload.products = normalizedProducts;
    }

    const updatedAdvertisement = await Advertisement.findByIdAndUpdate(
      id,
      updatePayload,
      {
        new: true,
        runValidators: true
      }
    );

    if (!updatedAdvertisement) {
      return res.status(404).json({
        success: false,
        error: 'Advertisement not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Advertisement updated successfully',
      data: updatedAdvertisement
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

    const deletedAdvertisement = await Advertisement.findByIdAndDelete(id);

    if (!deletedAdvertisement) {
      return res.status(404).json({
        success: false,
        error: 'Advertisement not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Advertisement deleted successfully',
      data: {
        id: deletedAdvertisement._id
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

