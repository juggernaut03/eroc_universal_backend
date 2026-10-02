const express = require('express');
const router = express.Router();

const TopSeller = require('../models/TopSeller');
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

// @route   POST /api/top-sellers
// @desc    Create a top seller section
// @access  Admin (via admin routes)
router.post('/', async (req, res, next) => {
  try {
    const {
      bg_color,
      title,
      products,
      store_code,
      store_codes,
      is_active,
      sequence
    } = req.body;

    if (!bg_color || bg_color.toString().trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'bg_color is required'
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

    const topSellerData = {
      bg_color: bg_color.toString().trim(),
      title: title.toString().trim(),
      products: normalizedProducts,
      is_active: parseBoolean(is_active, true),
      sequence: parseNumber(sequence, 0)
    };

    if (normalizedStoreCodes && normalizedStoreCodes.length > 0) {
      topSellerData.store_codes = normalizedStoreCodes;
      topSellerData.store_code = normalizedStoreCodes[0];
    } else {
      topSellerData.store_code = null;
      topSellerData.store_codes = undefined;
    }

    const topSeller = new TopSeller(topSellerData);

    const savedTopSeller = await topSeller.save();

    res.status(201).json({
      success: true,
      message: 'Top seller section created successfully',
      data: savedTopSeller
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

// @route   POST /api/top-sellers/list
// @desc    Get all top seller sections (public route)
// @access  Public
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

    const topSellers = await TopSeller.find(query).sort({ sequence: 1, createdAt: -1 }).lean();

    if (!topSellers.length) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: 'No top seller sections found',
        data: []
      });
    }

    let responseData = topSellers;

    if (shouldEnrichProducts) {
      const productCodes = Array.from(new Set(
        topSellers.flatMap(section => section.products.map(product => product.p_code))
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

      responseData = topSellers.map((section) => ({
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
      message: `Found ${responseData.length} top seller section(s)`,
      data: responseData
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/top-sellers/:id
// @desc    Get a single top seller section by ID (public route)
// @access  Public
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { enrich_products } = req.query;
    const shouldEnrichProducts = parseBoolean(enrich_products, false);

    const topSeller = await TopSeller.findById(id).lean();

    if (!topSeller) {
      return res.status(404).json({
        success: false,
        error: 'Top seller section not found'
      });
    }

    let responseData = topSeller;

    if (shouldEnrichProducts) {
      const productCodes = topSeller.products.map(product => product.p_code);

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
        ...topSeller,
        products: topSeller.products.map((product) => ({
          ...product,
          product_details: productMap.get(product.p_code) || null
        }))
      };
    }

    res.status(200).json({
      success: true,
      message: 'Top seller section fetched successfully',
      data: responseData
    });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/top-sellers/:id
// @desc    Update a top seller section
// @access  Admin (via admin routes)
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      bg_color,
      title,
      products,
      store_code,
      store_codes,
      is_active,
      sequence
    } = req.body;

    const updatePayload = {};

    if (bg_color !== undefined) {
      if (bg_color === null || bg_color.toString().trim() === '') {
        return res.status(400).json({
          success: false,
          error: 'bg_color cannot be empty'
        });
      }
      updatePayload.bg_color = bg_color.toString().trim();
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

    const updatedTopSeller = await TopSeller.findByIdAndUpdate(
      id,
      updatePayload,
      {
        new: true,
        runValidators: true
      }
    );

    if (!updatedTopSeller) {
      return res.status(404).json({
        success: false,
        error: 'Top seller section not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Top seller section updated successfully',
      data: updatedTopSeller
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

// @route   DELETE /api/top-sellers/:id
// @desc    Delete a top seller section
// @access  Admin (via admin routes)
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const deletedTopSeller = await TopSeller.findByIdAndDelete(id);

    if (!deletedTopSeller) {
      return res.status(404).json({
        success: false,
        error: 'Top seller section not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Top seller section deleted successfully',
      data: {
        id: deletedTopSeller._id
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

