const express = require('express');
const router = express.Router();

const BestSeller = require('../models/BestSeller');
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

const normalizeProductsInput = (rawProducts) => {
  let productList = rawProducts;

  if (Array.isArray(productList)) {
    // already an array
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

    if (redirect_url !== undefined && redirect_url !== null) {
      const trimmedRedirect = redirect_url.toString().trim();
      if (trimmedRedirect !== '') {
        normalizedProduct.redirect_url = trimmedRedirect;
      }
    }

    if (normalizedStoreCode) {
      normalizedProduct.store_code = normalizedStoreCode;
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
      banner_url,
      banner_url_desktop,
      banner_url_mobile,
      banner_urls,
      background_color,
      title,
      products,
      store_code,
      store_codes,
      description,
      is_active,
      sequence,
      redirect_url
    } = req.body;

    const resolveBannerUrls = () => {
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

    let normalizedBannerUrls;
    try {
      normalizedBannerUrls = resolveBannerUrls();
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

    const normalizedProducts = normalizeProductsInput(products || []);

    if (!normalizedProducts.length) {
      return res.status(400).json({
        success: false,
        error: 'At least one product must be provided'
      });
    }

    const normalizedStoreCodes = normalizeStoreCodes(store_code, store_codes);

    const bestSellerData = {
      banner_urls: normalizedBannerUrls,
      background_color: background_color.toString().trim(),
      title: title.toString().trim(),
      description: description && description.toString().trim() !== '' ? description.toString().trim() : undefined,
      products: normalizedProducts,
      is_active: parseBoolean(is_active, true),
      sequence: parseNumber(sequence, 0)
    };

    if (normalizedStoreCodes && normalizedStoreCodes.length > 0) {
      bestSellerData.store_codes = normalizedStoreCodes;
      bestSellerData.store_code = normalizedStoreCodes[0];
    } else {
      bestSellerData.store_code = null;
      bestSellerData.store_codes = undefined;
    }

    if (redirect_url !== undefined) {
      if (redirect_url === null) {
        bestSellerData.redirect_url = null;
      } else {
        const trimmedRedirect = redirect_url.toString().trim();
        bestSellerData.redirect_url = trimmedRedirect !== '' ? trimmedRedirect : null;
      }
    }

    const bestSeller = new BestSeller(bestSellerData);

    const savedBestSeller = await bestSeller.save();

    res.status(201).json({
      success: true,
      message: 'Best seller section created successfully',
      data: savedBestSeller
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
      enrich_products
    } = req.body;

    const includeInactive = parseBoolean(include_inactive, false);
    const shouldEnrichProducts = parseBoolean(enrich_products, false);

    const query = {};

    if (!includeInactive) {
      query.is_active = true;
    }

    if (store_code && store_code.toString().trim() !== '') {
      const trimmedCode = store_code.toString().trim();
      query.$or = [
        { store_codes: trimmedCode },
        { store_code: trimmedCode }
      ];
    }

    const bestSellers = await BestSeller.find(query).sort({ sequence: 1, createdAt: -1 }).lean();

    if (!bestSellers.length) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: 'No best seller sections found',
        data: []
      });
    }

    let responseData = bestSellers;

    if (shouldEnrichProducts) {
      const productCodes = Array.from(new Set(
        bestSellers.flatMap(section => section.products.map(product => product.p_code))
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

      responseData = bestSellers.map((section) => ({
        ...section,
        products: section.products.map((product) => ({
          ...product,
          product_details: productMap.get(product.p_code) || null
        }))
      }));
    }

    res.status(200).json({
      success: true,
      count: responseData.length,
      message: `Found ${responseData.length} best seller section(s)`,
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
    const shouldEnrichProducts = parseBoolean(enrich_products, false);

    const bestSeller = await BestSeller.findById(id).lean();

    if (!bestSeller) {
      return res.status(404).json({
        success: false,
        error: 'Best seller section not found'
      });
    }

    let responseData = bestSeller;

    if (shouldEnrichProducts) {
      const productCodes = bestSeller.products.map(product => product.p_code);

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
        ...bestSeller,
        products: bestSeller.products.map((product) => ({
          ...product,
          product_details: productMap.get(product.p_code) || null
        }))
      };
    }

    res.status(200).json({
      success: true,
      message: 'Best seller section fetched successfully',
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
      banner_url,
      banner_url_desktop,
      banner_url_mobile,
      banner_urls,
      background_color,
      title,
      products,
      store_code,
      store_codes,
      description,
      is_active,
      sequence,
      redirect_url
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

    if (products !== undefined) {
      const normalizedProducts = normalizeProductsInput(products);

      if (!normalizedProducts.length) {
        return res.status(400).json({
          success: false,
          error: 'At least one product must be provided'
        });
      }

      updatePayload.products = normalizedProducts;
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

    const updatedBestSeller = await BestSeller.findByIdAndUpdate(
      id,
      updatePayload,
      {
        new: true,
        runValidators: true
      }
    );

    if (!updatedBestSeller) {
      return res.status(404).json({
        success: false,
        error: 'Best seller section not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Best seller section updated successfully',
      data: updatedBestSeller
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

    const deletedBestSeller = await BestSeller.findByIdAndDelete(id);

    if (!deletedBestSeller) {
      return res.status(404).json({
        success: false,
        error: 'Best seller section not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Best seller section deleted successfully',
      data: {
        id: deletedBestSeller._id
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

// See the note in routes/popular-categories.js.
module.exports.mapProductMaster = mapProductMaster;
