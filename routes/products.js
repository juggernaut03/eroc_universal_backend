const express = require('express');
const router = express.Router();
const ProductMaster = require('../models/ProductMaster');

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
    
    // Find the specific product
    const product = await ProductMaster.findOne({
      store_code: store_code.trim(),
      p_code: p_code.toString(),
      pcode_status: 'Y'
    });
    
    if (!product) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: `No product found for store_code: ${store_code.trim()} and p_code: ${p_code}`,
        store_code: store_code.trim(),
        p_code: p_code,
        data: null
      });
    }
    
    // Format response data
    const productData = {
      id: product._id,
      p_code: product.p_code,
      barcode: product.barcode,
      product_name: product.product_name,
      product_description: product.product_description,
      package_size: product.package_size,
      package_unit: product.package_unit,
      product_mrp: product.product_mrp ? parseFloat(product.product_mrp.toString()) : 0,
      our_price: product.our_price ? parseFloat(product.our_price.toString()) : 0,
      brand_name: product.brand_name,
      store_code: product.store_code,
      pcode_status: product.pcode_status,
      dept_id: product.dept_id,
      category_id: product.category_id,
      sub_category_id: product.sub_category_id,
      store_quantity: product.store_quantity,
      max_quantity_allowed: product.max_quantity_allowed,
      pcode_img: product.pcode_img
    };
    
    res.status(200).json({
      success: true,
      count: 1,
      message: `Found product for store_code: ${store_code.trim()} and p_code: ${p_code}`,
      store_code: store_code.trim(),
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
      store_code: store_code.trim(),
      pcode_status: 'Y',
      $or: [{ product_name: pattern }, { brand_name: pattern }]
    };
    
    // Add optional filters if provided
    if (dept_id) {
      searchQuery.dept_id = dept_id;
    }
    
    if (category_id) {
      searchQuery.category_id = category_id;
    }
    
    if (sub_category_id) {
      searchQuery.sub_category_id = sub_category_id;
    }
    
    // Find products matching the search criteria
    const products = await ProductMaster.find(searchQuery).sort({ product_name: 1 });
    
    if (!products || products.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: `No products found matching "${search_term.trim()}" for store_code: ${store_code.trim()}${dept_id ? `, dept_id: ${dept_id}` : ''}${category_id ? `, category_id: ${category_id}` : ''}${sub_category_id ? `, sub_category_id: ${sub_category_id}` : ''}`,
        search_term: search_term.trim(),
        store_code: store_code.trim(),
        dept_id: dept_id || null,
        category_id: category_id || null,
        sub_category_id: sub_category_id || null,
        data: []
      });
    }
    
    // Format response data
    const productsData = products.map(product => ({
      id: product._id,
      p_code: product.p_code,
      barcode: product.barcode,
      product_name: product.product_name,
      product_description: product.product_description,
      package_size: product.package_size,
      package_unit: product.package_unit,
      product_mrp: product.product_mrp ? parseFloat(product.product_mrp.toString()) : 0,
      our_price: product.our_price ? parseFloat(product.our_price.toString()) : 0,
      brand_name: product.brand_name,
      store_code: product.store_code,
      pcode_status: product.pcode_status,
      dept_id: product.dept_id,
      category_id: product.category_id,
      sub_category_id: product.sub_category_id,
      store_quantity: product.store_quantity,
      max_quantity_allowed: product.max_quantity_allowed,
      pcode_img: product.pcode_img
    }));
    
    res.status(200).json({
      success: true,
      count: productsData.length,
      message: `Found ${productsData.length} product(s) matching "${search_term.trim()}" for store_code: ${store_code.trim()}${dept_id ? `, dept_id: ${dept_id}` : ''}${category_id ? `, category_id: ${category_id}` : ''}${sub_category_id ? `, sub_category_id: ${sub_category_id}` : ''}`,
      search_term: search_term.trim(),
      store_code: store_code.trim(),
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
    
    // Find the specific product using all filters including pcode
    const product = await ProductMaster.findOne({
      store_code: store_code.trim(),
      dept_id: dept_id,
      category_id: category_id,
      sub_category_id: sub_category_id,
      p_code: pcode,
      pcode_status: 'Y'
    });
    
    if (!product) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: `No product found for store_code: ${store_code.trim()}, dept_id: ${dept_id}, category_id: ${category_id}, sub_category_id: ${sub_category_id}, and pcode: ${pcode}`,
        store_code: store_code.trim(),
        dept_id: dept_id,
        category_id: category_id,
        sub_category_id: sub_category_id,
        pcode: pcode,
        data: null
      });
    }
    
    // Format response data
    const productData = {
      id: product._id,
      p_code: product.p_code,
      barcode: product.barcode,
      product_name: product.product_name,
      product_description: product.product_description,
      package_size: product.package_size,
      package_unit: product.package_unit,
      product_mrp: product.product_mrp ? parseFloat(product.product_mrp.toString()) : 0,
      our_price: product.our_price ? parseFloat(product.our_price.toString()) : 0,
      brand_name: product.brand_name,
      store_code: product.store_code,
      pcode_status: product.pcode_status,
      dept_id: product.dept_id,
      category_id: product.category_id,
      sub_category_id: product.sub_category_id,
      store_quantity: product.store_quantity,
      max_quantity_allowed: product.max_quantity_allowed,
      pcode_img: product.pcode_img
    };
    
    res.status(200).json({
      success: true,
      count: 1,
      message: `Found product for store_code: ${store_code.trim()}, dept_id: ${dept_id}, category_id: ${category_id}, sub_category_id: ${sub_category_id}, and pcode: ${pcode}`,
      store_code: store_code.trim(),
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

    // Find products using the filters
    const products = await ProductMaster.findByFilters({
      store_code: store_code.trim(),
      dept_id: dept_id,
      category_id: category_id,
      // null here means findByFilters leaves subcategory out of the query.
      sub_category_id: subCategoryFilter
    });

    const scopeLabel = subCategoryFilter
      ? `sub_category_id: ${subCategoryFilter}`
      : 'all subcategories';

    if (!products || products.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: `No products found for store_code: ${store_code.trim()}, dept_id: ${dept_id}, category_id: ${category_id}, and ${scopeLabel}`,
        store_code: store_code.trim(),
        dept_id: dept_id,
        category_id: category_id,
        sub_category_id: subCategoryFilter,
        data: []
      });
    }
    
    // Format response data
    const productsData = products.map(product => ({
      id: product._id,
      p_code: product.p_code,
      barcode: product.barcode,
      product_name: product.product_name,
      product_description: product.product_description,
      package_size: product.package_size,
      package_unit: product.package_unit,
      product_mrp: product.product_mrp ? parseFloat(product.product_mrp.toString()) : 0,
      our_price: product.our_price ? parseFloat(product.our_price.toString()) : 0,
      brand_name: product.brand_name,
      store_code: product.store_code,
      pcode_status: product.pcode_status,
      dept_id: product.dept_id,
      category_id: product.category_id,
      sub_category_id: product.sub_category_id,
      store_quantity: product.store_quantity,
      max_quantity_allowed: product.max_quantity_allowed,
      pcode_img: product.pcode_img
    }));
    
    res.status(200).json({
      success: true,
      count: productsData.length,
      message: `Found ${productsData.length} product(s) for store_code: ${store_code.trim()}, dept_id: ${dept_id}, category_id: ${category_id}, and ${scopeLabel}`,
      store_code: store_code.trim(),
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
 * @desc    Get all products
 * @access  Public
 */
router.get('/', async (req, res, next) => {
  try {
    const products = await ProductMaster.findAllSorted();
    
    if (!products || products.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: 'No products found',
        data: []
      });
    }
    
    // Format response data
    const productsData = products.map(product => ({
      id: product._id,
      p_code: product.p_code,
      barcode: product.barcode,
      product_name: product.product_name,
      product_description: product.product_description,
      package_size: product.package_size,
      package_unit: product.package_unit,
      product_mrp: product.product_mrp ? parseFloat(product.product_mrp.toString()) : 0,
      our_price: product.our_price ? parseFloat(product.our_price.toString()) : 0,
      brand_name: product.brand_name,
      store_code: product.store_code,
      pcode_status: product.pcode_status,
      dept_id: product.dept_id,
      category_id: product.category_id,
      sub_category_id: product.sub_category_id,
      store_quantity: product.store_quantity,
      max_quantity_allowed: product.max_quantity_allowed,
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