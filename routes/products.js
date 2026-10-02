const express = require('express');
const router = express.Router();
const ProductMaster = require('../models/ProductMaster');
const SubcategoryProductMap = require('../models/SubcategoryProductMap');
const {
  resolveSubcategoryIdsForCategories,
  buildProductScopeFilter
} = require('../utils/catalogueResolution');

// Values that mean "every subcategory in this category" rather than naming one.
//
// "0" is the sentinel the mobile app's ALL tab has always sent; "all" and the
// empty string are accepted so a caller does not have to know that history.
const ALL_SUBCATEGORIES = new Set(['', '0', 'all', 'ALL']);

/// Returns the subcategory to filter on, or null for "do not filter".
const normaliseSubCategoryId = (value) => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return ALL_SUBCATEGORIES.has(trimmed) || ALL_SUBCATEGORIES.has(trimmed.toLowerCase())
    ? null
    : trimmed;
};

// Every response in this file is the same flat shape it's always been —
// identity fields plus one store's price/stock/status — even though that's
// now assembled from the parent document's identity fields plus one entry
// of its stores[] array instead of being the document itself. This is the
// one place that assembly happens, reused by every route below so the
// wire format can never drift between them. Returns null if the product
// doesn't actually carry a listing for this store (shouldn't happen given
// every query below filters by store first, but a caller passing a mongo
// query result directly — not matched by $elemMatch — could still hit it).
function flattenProduct(product, storeCode) {
  const listing = product.storeListing ? product.storeListing(storeCode) : product.stores?.find((s) => s.store_code === storeCode);
  if (!listing) return null;
  return {
    id: product._id,
    p_code: product.p_code,
    barcode: product.barcode,
    product_name: product.product_name,
    product_description: product.product_description,
    package_size: product.package_size,
    package_unit: product.package_unit,
    product_mrp: listing.product_mrp ? parseFloat(listing.product_mrp.toString()) : 0,
    our_price: listing.our_price ? parseFloat(listing.our_price.toString()) : 0,
    brand_name: product.brand_name,
    store_code: listing.store_code,
    pcode_status: listing.pcode_status,
    dept_id: product.dept_id,
    category_id: product.category_id,
    sub_category_id: product.sub_category_id,
    store_quantity: listing.store_quantity,
    max_quantity_allowed: listing.max_quantity_allowed,
    pcode_img: product.pcode_img
  };
}

// The $elemMatch every store-scoped query below needs: both store_code and
// an active listing on the SAME stores[] entry (a plain
// {'stores.store_code': x, 'stores.pcode_status': 'Y'} without $elemMatch
// would match a doc where any element has that store_code and any element
// — possibly a different one — has status Y).
const activeAtStore = (storeCode) => ({
  stores: { $elemMatch: { store_code: storeCode, pcode_status: 'Y' } }
});

/**
 * @route   POST /api/products/productdetails
 * @desc    Get a specific product by store_code and p_code
 * @access  Public
 * @body    { "store_code": "AVB", "p_code": "2390" }
 */
router.post('/productdetails', async (req, res, next) => {
  try {
    const { store_code, p_code } = req.body;

    // Validate required fields
    if (!store_code || store_code.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'store_code is required'
      });
    }

    if (!p_code) {
      return res.status(400).json({
        success: false,
        error: 'p_code is required'
      });
    }

    const storeCode = store_code.trim();

    // Find the specific product
    const product = await ProductMaster.findOne({
      p_code: p_code.toString(),
      ...activeAtStore(storeCode)
    });

    if (!product) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: `No product found for store_code: ${storeCode} and p_code: ${p_code}`,
        store_code: storeCode,
        p_code: p_code,
        data: null
      });
    }

    const productData = flattenProduct(product, storeCode);

    res.status(200).json({
      success: true,
      count: 1,
      message: `Found product for store_code: ${storeCode} and p_code: ${p_code}`,
      store_code: storeCode,
      p_code: p_code,
      data: productData
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/products/search-products
 * @desc    Search products by name with partial matching
 * @access  Public
 * @body    { "search_term": "Amu", "store_code": "AVB" }
 */
router.post('/search-products', async (req, res, next) => {
  try {
    const { search_term, store_code, dept_id, category_id, sub_category_id } = req.body;

    // Validate required fields
    if (!search_term || search_term.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'search_term is required'
      });
    }

    if (!store_code || store_code.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'store_code is required'
      });
    }

    const storeCode = store_code.trim();

    // Create search query with partial matching (case insensitive).
    //
    // Matches the brand as well as the product name: shoppers search brands
    // ("Amul") at least as often as product names, and the home screen's brand
    // tiles search by brand name, which matched nothing while this looked at
    // product_name alone.
    //
    // Escaped because a search term is user input — an unescaped "(" is an
    // invalid regex and would 500 the whole search.
    const escaped = search_term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = { $regex: escaped, $options: 'i' };

    const searchQuery = {
      ...activeAtStore(storeCode),
      $and: [{ $or: [{ product_name: pattern }, { brand_name: pattern }] }]
    };

    // Narrow by subcategory/category scope (cross-mapping aware — see
    // catalogueResolution.js). dept_id alone still filters directly: M:N
    // mapping doesn't reach the department level, and a bare dept_id-only
    // search has no subcategory set to resolve.
    if (sub_category_id) {
      const scopeFilter = await buildProductScopeFilter([sub_category_id], storeCode);
      searchQuery.$and.push(scopeFilter);
    } else if (category_id) {
      const subcategoryIds = await resolveSubcategoryIdsForCategories([category_id], storeCode);
      const scopeFilter = await buildProductScopeFilter(subcategoryIds, storeCode);
      searchQuery.$and.push(scopeFilter);
    } else if (dept_id) {
      searchQuery.dept_id = dept_id;
    }

    // Find products matching the search criteria
    const products = await ProductMaster.find(searchQuery).sort({ product_name: 1 });

    if (!products || products.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: `No products found matching "${search_term.trim()}" for store_code: ${storeCode}${dept_id ? `, dept_id: ${dept_id}` : ''}${category_id ? `, category_id: ${category_id}` : ''}${sub_category_id ? `, sub_category_id: ${sub_category_id}` : ''}`,
        search_term: search_term.trim(),
        store_code: storeCode,
        dept_id: dept_id || null,
        category_id: category_id || null,
        sub_category_id: sub_category_id || null,
        data: []
      });
    }

    const productsData = products.map((product) => flattenProduct(product, storeCode)).filter(Boolean);

    res.status(200).json({
      success: true,
      count: productsData.length,
      message: `Found ${productsData.length} product(s) matching "${search_term.trim()}" for store_code: ${storeCode}${dept_id ? `, dept_id: ${dept_id}` : ''}${category_id ? `, category_id: ${category_id}` : ''}${sub_category_id ? `, sub_category_id: ${sub_category_id}` : ''}`,
      search_term: search_term.trim(),
      store_code: storeCode,
      dept_id: dept_id || null,
      category_id: category_id || null,
      sub_category_id: sub_category_id || null,
      data: productsData
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/products/get-product-by-pcode
 * @desc    Get a specific product by pcode with store_code, dept_id, category_id, and sub_category_id filters
 * @access  Public
 * @body    { "store_code": "AVB", "dept_id": "2", "category_id": "89", "sub_category_id": "349", "pcode": "2390" }
 */
router.post('/get-product-by-pcode', async (req, res, next) => {
  try {
    const { store_code, dept_id, category_id, sub_category_id, pcode } = req.body;

    // Validate required fields
    if (!store_code || store_code.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'store_code is required'
      });
    }

    if (!dept_id) {
      return res.status(400).json({
        success: false,
        error: 'dept_id is required'
      });
    }

    if (!category_id) {
      return res.status(400).json({
        success: false,
        error: 'category_id is required'
      });
    }

    if (!sub_category_id) {
      return res.status(400).json({
        success: false,
        error: 'sub_category_id is required'
      });
    }

    if (!pcode) {
      return res.status(400).json({
        success: false,
        error: 'pcode is required'
      });
    }

    const storeCode = store_code.trim();

    // dept_id/category_id stay required, validated inputs (unchanged API
    // contract) but are NOT used as match filters below: once a subcategory
    // can be cross-mapped into a category other than its primary one, there
    // is no single "correct" dept_id/category_id to require a match against
    // — a product reached via a cross-mapped subcategory legitimately carries
    // a different category_id than the one the client is browsing under.
    // sub_category_id is verified explicitly instead, against the product's
    // own primary subcategory OR its SubcategoryProductMap entries.
    const product = await ProductMaster.findOne({
      p_code: pcode,
      ...activeAtStore(storeCode)
    });

    const notFoundResponse = () => res.status(200).json({
      success: true,
      count: 0,
      message: `No product found for store_code: ${storeCode}, dept_id: ${dept_id}, category_id: ${category_id}, sub_category_id: ${sub_category_id}, and pcode: ${pcode}`,
      store_code: storeCode,
      dept_id: dept_id,
      category_id: category_id,
      sub_category_id: sub_category_id,
      pcode: pcode,
      data: null
    });

    if (!product) {
      return notFoundResponse();
    }

    if (product.sub_category_id !== sub_category_id) {
      const mapped = await SubcategoryProductMap.exists({
        p_code: pcode,
        idsub_category_master: sub_category_id,
        store_code: storeCode
      });
      if (!mapped) {
        return notFoundResponse();
      }
    }

    const productData = flattenProduct(product, storeCode);

    res.status(200).json({
      success: true,
      count: 1,
      message: `Found product for store_code: ${storeCode}, dept_id: ${dept_id}, category_id: ${category_id}, sub_category_id: ${sub_category_id}, and pcode: ${pcode}`,
      store_code: storeCode,
      dept_id: dept_id,
      category_id: category_id,
      sub_category_id: sub_category_id,
      pcode: pcode,
      data: productData
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/products/get-products
 * @desc    Get products by store_code, dept_id, category_id, and sub_category_id
 * @access  Public
 * @body    { "store_code": "AME", "dept_id": "1", "category_id": "1", "sub_category_id": "272" }
 */
router.post('/get-products', async (req, res, next) => {
  try {
    const { store_code, dept_id, category_id, sub_category_id } = req.body;

    // Validate required fields
    if (!store_code || store_code.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'store_code is required'
      });
    }

    if (!dept_id) {
      return res.status(400).json({
        success: false,
        error: 'dept_id is required'
      });
    }

    if (!category_id) {
      return res.status(400).json({
        success: false,
        error: 'category_id is required'
      });
    }

    const storeCode = store_code.trim();

    // sub_category_id is OPTIONAL: leaving it out — or sending the "all"
    // sentinel — returns every product in the category.
    //
    // It used to be mandatory, and the app's "ALL" tab sends the string "0" to
    // mean "no subcategory filter". "0" is truthy, so it passed this check and
    // was then used as a literal subcategory id, matching nothing: the ALL tab
    // showed "0 Products — Try selecting a different subcategory" on categories
    // that were full of stock.
    //
    // Normalising here rather than only in the app means every build already
    // installed gets a working ALL tab as soon as this deploys.
    const subCategoryFilter = normaliseSubCategoryId(sub_category_id);

    // Resolve which subcategories are in scope: either the one explicitly
    // requested, or — for the "ALL" sentinel — every subcategory (primary +
    // cross-mapped) under this category. Either way, dept_id/category_id are
    // NOT used as ProductMaster match filters from here on: a subcategory
    // cross-mapped into this category can hold products whose own primary
    // category_id points elsewhere, and those products are exactly the ones
    // this endpoint must still return (see catalogueResolution.js).
    const targetSubcategoryIds = subCategoryFilter
      ? [subCategoryFilter]
      : await resolveSubcategoryIdsForCategories([category_id], storeCode);

    const scopeFilter = await buildProductScopeFilter(targetSubcategoryIds, storeCode);
    const products = await ProductMaster.find({
      ...activeAtStore(storeCode),
      ...scopeFilter
    }).sort({ product_name: 1 });

    const scopeLabel = subCategoryFilter
      ? `sub_category_id: ${subCategoryFilter}`
      : 'all subcategories';

    if (!products || products.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: `No products found for store_code: ${storeCode}, dept_id: ${dept_id}, category_id: ${category_id}, and ${scopeLabel}`,
        store_code: storeCode,
        dept_id: dept_id,
        category_id: category_id,
        sub_category_id: subCategoryFilter,
        data: []
      });
    }

    const productsData = products.map((product) => flattenProduct(product, storeCode)).filter(Boolean);

    res.status(200).json({
      success: true,
      count: productsData.length,
      message: `Found ${productsData.length} product(s) for store_code: ${storeCode}, dept_id: ${dept_id}, category_id: ${category_id}, and ${scopeLabel}`,
      store_code: storeCode,
      dept_id: dept_id,
      category_id: category_id,
      // What was actually filtered on: null when every subcategory is included.
      sub_category_id: subCategoryFilter,
      data: productsData
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/products
 * @desc    Get all products, every store mixed together (pre-existing —
 *          this route has never taken a store_code, so there is no single
 *          store to flatten each product's price/stock/status against; it
 *          returns one row per active store-listing, same as it always
 *          returned one row per (then-independent) store document).
 * @access  Public
 */
router.get('/', async (req, res, next) => {
  try {
    const rows = await ProductMaster.aggregate([
      { $unwind: '$stores' },
      { $match: { 'stores.pcode_status': 'Y' } },
      { $sort: { product_name: 1 } }
    ]);

    if (!rows || rows.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: 'No products found',
        data: []
      });
    }

    const productsData = rows.map((product) => ({
      id: product._id,
      p_code: product.p_code,
      barcode: product.barcode,
      product_name: product.product_name,
      product_description: product.product_description,
      package_size: product.package_size,
      package_unit: product.package_unit,
      product_mrp: product.stores.product_mrp ? parseFloat(product.stores.product_mrp.toString()) : 0,
      our_price: product.stores.our_price ? parseFloat(product.stores.our_price.toString()) : 0,
      brand_name: product.brand_name,
      store_code: product.stores.store_code,
      pcode_status: product.stores.pcode_status,
      dept_id: product.dept_id,
      category_id: product.category_id,
      sub_category_id: product.sub_category_id,
      store_quantity: product.stores.store_quantity,
      max_quantity_allowed: product.stores.max_quantity_allowed,
      pcode_img: product.pcode_img
    }));

    res.status(200).json({
      success: true,
      count: productsData.length,
      message: `Found ${productsData.length} product(s)`,
      data: productsData
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
