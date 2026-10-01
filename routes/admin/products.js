const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const router = express.Router();
const Product = require('../../models/Product');
const ProductMaster = require('../../models/ProductMaster');
const Department = require('../../models/Department');
const Category = require('../../models/Category');
const Subcategory = require('../../models/Subcategory');
const SubcategoryProductMap = require('../../models/SubcategoryProductMap');
const { getTenantDb } = require('../../config/database');
const { checkPermission, requireStoreAccess } = require('../../middleware/checkPermission');
const { enforceProductLimit } = require('../../middleware/subscription');

// A single CSV, small enough to hold in memory (a few thousand rows is at
// most a few MB) — no need for the disk-storage pattern the image-CDN's
// bulk uploads use for potentially dozens of large image files at once.
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv'))
});

const viewPerm = checkPermission('ecommerce', 'view');
const createPerm = checkPermission('ecommerce', 'create');
const editPerm = checkPermission('ecommerce', 'edit');
const deletePerm = checkPermission('ecommerce', 'delete');

// A user-typed search string used as a $regex literal has to have its
// regex metacharacters escaped, or a term like "5.5" matches "5X5" too (and
// an unbalanced "(" throws instead of matching anything).
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Batched reverse lookup for the by-store product list: which additional
// subcategories (beyond the primary) is each product cross-mapped to.
const buildAdditionalSubCategoryIdsMap = async (pCodes = []) => {
  const uniqueCodes = [...new Set(pCodes.filter(Boolean))];
  if (uniqueCodes.length === 0) return {};

  const mappings = await SubcategoryProductMap.find({ p_code: { $in: uniqueCodes } });

  return mappings.reduce((acc, mapping) => {
    const list = acc[mapping.p_code] || (acc[mapping.p_code] = []);
    list.push(mapping.idsub_category_master);
    return acc;
  }, {});
};

// Validates `additionalSubCategoryIds` (every id must resolve to a real
// Subcategory) and syncs SubcategoryProductMap to exactly that set. Only
// called when the caller's request body explicitly names the field (see the
// `in req.body` guards below) — a request that doesn't mention mappings must
// never touch them, e.g. a `{ pcode_status }`-only partial update.
const syncAdditionalSubCategoryMappings = async (product, additionalSubCategoryIds) => {
  const uniqueIds = [...new Set((additionalSubCategoryIds || []).filter(Boolean))]
    .filter((id) => id !== product.sub_category_id); // mapping to your own primary is a no-op, not an error

  if (uniqueIds.length > 0) {
    const validCount = await Subcategory.countDocuments({
      idsub_category_master: { $in: uniqueIds }
    });
    if (validCount !== uniqueIds.length) {
      throw Object.assign(
        new Error('One or more additional subcategory IDs do not exist.'),
        { statusCode: 400 }
      );
    }
  }

  await SubcategoryProductMap.replaceForProduct(product.p_code, product.store_code, uniqueIds);
};

// @route   GET /api/admin/products
// @desc    Get all products with advanced filtering and pagination
// @access  Admin
router.get('/', viewPerm, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      category = '',
      subcategory = '',
      status = '',
      stockStatus = '',
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build query
    const query = {};

    // Search by name, productCode, or brand
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { productCode: { $regex: search, $options: 'i' } },
        { brand: { $regex: search, $options: 'i' } }
      ];
    }

    // Filter by category
    if (category) {
      query.category = category;
    }

    // Filter by subcategory
    if (subcategory) {
      query.subcategory = subcategory;
    }

    // Filter by status
    if (status) {
      query.status = status;
    }

    // Filter by stock status
    if (stockStatus === 'in_stock') {
      query['stock.quantity'] = { $gt: 0 };
    } else if (stockStatus === 'out_of_stock') {
      query['stock.quantity'] = 0;
    } else if (stockStatus === 'low_stock') {
      query.$expr = {
        $and: [
          { $gt: ['$stock.quantity', 0] },
          { $lte: ['$stock.quantity', '$stock.minStockLevel'] }
        ]
      };
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const products = await Product.find(query)
      .populate('category', 'name')
      .populate('subcategory', 'name')
      .populate('department', 'name')
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    // Get total count for pagination
    const total = await Product.countDocuments(query);

    res.status(200).json({
      success: true,
      data: products,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching products',
      error: error.message
    });
  }
});

// @route   POST /api/admin/products/by-store
// @desc    Get products by store_code with search and filters (using ProductMaster)
// @access  Admin
router.post('/by-store', viewPerm, requireStoreAccess, async (req, res) => {
  try {
    const {
      store_code,
      search = '',
      page = 1,
      limit = 20,
      dept_id = '',
      category_id = '',
      sub_category_id = '',
      // "Show only products missing a valid department/category/subcategory"
      // — mutually exclusive with the three filters above (a product with
      // no valid classification can't sensibly be narrowed to one).
      unclassified_only = false,
      // 'active' | 'inactive' | 'all'. Used to hardcode pcode_status: 'Y'
      // here unconditionally — meaning an inactive product could never be
      // found at all through this list, search included, with no way to
      // ask for it. Defaults to 'all' now so search finds what's actually
      // in the catalog; the admin panel's Status filter narrows it back
      // down when that's what's wanted.
      status = 'all',
      sortBy = 'product_name',
      sortOrder = 'asc'
    } = req.body;

    // Validate required fields
    if (!store_code || store_code.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'store_code is required'
      });
    }

    // Build query
    const query = { store_code: store_code.trim() };

    if (status === 'active') {
      query.pcode_status = 'Y';
    } else if (status === 'inactive') {
      query.pcode_status = 'N';
    }
    // status === 'all' (or anything else unrecognized): no pcode_status
    // filter at all.

    // Add search filter — across product name, p_code, barcode, and brand.
    // This previously matched product_name only, despite the panel's own
    // search placeholder already claiming "product name, code, or
    // barcode" — p_code/barcode search never actually worked, and brand
    // wasn't attempted at all.
    const searchTerm = search && search.trim();
    if (searchTerm) {
      const re = { $regex: escapeRegex(searchTerm), $options: 'i' };
      query.$or = [
        { product_name: re },
        { p_code: re },
        { barcode: re },
        { brand_name: re }
      ];
    }

    // Add optional filters
    // Hoisted so the stats block below can reuse it for
    // unclassified_active_count without recomputing the three distinct()
    // calls a second time.
    let unclassifiedOr = null;
    if (unclassified_only) {
      // A product's dept_id/category_id/sub_category_id is a free-typed
      // string reference, not a real Mongo reference — nothing stops it
      // from pointing at a department/category/subcategory that has since
      // been renamed to a new id or deleted outright. Tenant-wide (not
      // store-scoped) validity check: flag a product the moment any one of
      // its three references doesn't match a real document, anywhere in
      // this tenant's catalog tree.
      const [validDeptIds, validCategoryIds, validSubCategoryIds] = await Promise.all([
        Department.distinct('department_id'),
        Category.distinct('idcategory_master'),
        Subcategory.distinct('idsub_category_master')
      ]);
      unclassifiedOr = [
        { dept_id: { $nin: validDeptIds } },
        { category_id: { $nin: validCategoryIds } },
        { sub_category_id: { $nin: validSubCategoryIds } }
      ];
      if (query.$or) {
        query.$and = [{ $or: query.$or }, { $or: unclassifiedOr }];
        delete query.$or;
      } else {
        query.$or = unclassifiedOr;
      }
    } else {
      if (dept_id) {
        query.dept_id = dept_id;
      }

      if (category_id) {
        query.category_id = category_id;
      }

      if (sub_category_id) {
        query.sub_category_id = sub_category_id;
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    let products;
    let total;

    if (searchTerm) {
      // A plain product_name sort buries an exact p_code/barcode hit
      // alphabetically among dozens of unrelated substring matches (e.g.
      // searching "427" also matches any barcode that merely contains
      // "427" — real matches, just not what someone typing an exact code
      // is looking for). Rank instead: exact code/barcode match first,
      // then a code/name that starts with the term, then everything else,
      // with product_name as the tiebreaker within each rank.
      const escaped = escapeRegex(searchTerm);
      const prefixRe = new RegExp(`^${escaped}`, 'i');
      const pipeline = [
        { $match: query },
        {
          $addFields: {
            _searchRank: {
              $switch: {
                branches: [
                  { case: { $eq: [{ $toLower: { $ifNull: ['$p_code', ''] } }, searchTerm.toLowerCase()] }, then: 0 },
                  { case: { $eq: [{ $toLower: { $ifNull: ['$barcode', ''] } }, searchTerm.toLowerCase()] }, then: 1 },
                  { case: { $regexMatch: { input: { $ifNull: ['$p_code', ''] }, regex: prefixRe } }, then: 2 },
                  { case: { $regexMatch: { input: { $ifNull: ['$product_name', ''] }, regex: prefixRe } }, then: 3 }
                ],
                default: 4
              }
            }
          }
        },
        { $sort: { _searchRank: 1, product_name: 1 } },
        { $skip: skip },
        { $limit: parseInt(limit) }
      ];
      products = await ProductMaster.aggregate(pipeline);
      total = await ProductMaster.countDocuments(query);
    } else {
      const sort = {};
      sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

      products = await ProductMaster.find(query)
        .sort(sort)
        .limit(parseInt(limit))
        .skip(skip);

      total = await ProductMaster.countDocuments(query);
    }

    const additionalSubCategoryIdsMap = await buildAdditionalSubCategoryIdsMap(
      products.map(product => product.p_code)
    );

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
      additional_sub_category_ids: additionalSubCategoryIdsMap[product.p_code] || [],
      store_quantity: product.store_quantity,
      max_quantity_allowed: product.max_quantity_allowed,
      pcode_img: product.pcode_img
    }));

    // Store-wide counters for the header — deliberately ignore every filter
    // above (department/category/search/status) so they read as a stable
    // "how's this store doing overall" figure, not one that jumps around as
    // someone types into search. total_products/active_count are always
    // computed; inactive_count/unclassified_active_count are mutually
    // exclusive with each other, matching whichever side of the
    // Unclassified-only toggle the request is on.
    const totalProducts = await ProductMaster.countDocuments({ store_code: store_code.trim() });
    const activeCount = await ProductMaster.countDocuments({
      store_code: store_code.trim(),
      pcode_status: 'Y'
    });
    let inactiveCount = null;
    let unclassifiedActiveCount = null;
    if (unclassified_only && unclassifiedOr) {
      unclassifiedActiveCount = await ProductMaster.countDocuments({
        store_code: store_code.trim(),
        pcode_status: 'Y',
        $or: unclassifiedOr
      });
    } else {
      inactiveCount = await ProductMaster.countDocuments({
        store_code: store_code.trim(),
        pcode_status: 'N'
      });
    }

    res.status(200).json({
      success: true,
      data: productsData,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      stats: {
        total_products: totalProducts,
        active_count: activeCount,
        inactive_count: inactiveCount,
        unclassified_active_count: unclassifiedActiveCount
      }
    });
  } catch (error) {
    console.error('Get products by store error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching products',
      error: error.message
    });
  }
});

// @route   GET /api/admin/products/:id
// @desc    Get single product by ID
// @access  Admin
router.get('/:id', viewPerm, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate('category', 'name')
      .populate('subcategory', 'name')
      .populate('department', 'name')
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email')
      .populate('relatedProducts', 'name price images')
      .populate('reviews.user', 'name');

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.status(200).json({
      success: true,
      data: product
    });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching product',
      error: error.message
    });
  }
});

// @route   POST /api/admin/products
// @desc    Create new product
// @access  Admin
router.post('/', createPerm, enforceProductLimit(), async (req, res) => {
  try {
    const productData = {
      ...req.body,
      createdBy: req.user._id,
      updatedBy: req.user._id
    };

    const product = await Product.create(productData);

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: product
    });
  } catch (error) {
    console.error('Create product error:', error);

    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Product with this code already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Error creating product',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/products/:id
// @desc    Update product
// @access  Admin
router.put('/:id', editPerm, async (req, res) => {
  try {
    const updateData = {
      ...req.body,
      updatedBy: req.user._id
    };

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    ).populate('category', 'name')
     .populate('subcategory', 'name')
     .populate('department', 'name');

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Product updated successfully',
      data: product
    });
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating product',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/products/:id
// @desc    Delete product
// @access  Admin
router.delete('/:id', deletePerm, async (req, res) => {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting product',
      error: error.message
    });
  }
});

// @route   PATCH /api/admin/products/:id/stock
// @desc    Update product stock
// @access  Admin
router.patch('/:id/stock', editPerm, async (req, res) => {
  try {
    const { quantity, operation = 'set' } = req.body;

    if (quantity === undefined || quantity === null) {
      return res.status(400).json({
        success: false,
        message: 'Quantity is required'
      });
    }

    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Update stock based on operation
    if (operation === 'add') {
      product.stock.quantity += parseInt(quantity);
    } else if (operation === 'subtract') {
      product.stock.quantity = Math.max(0, product.stock.quantity - parseInt(quantity));
    } else {
      product.stock.quantity = parseInt(quantity);
    }

    // Update status based on stock
    if (product.stock.quantity === 0) {
      product.status = 'out_of_stock';
    } else if (product.status === 'out_of_stock') {
      product.status = 'active';
    }

    product.updatedBy = req.user._id;
    await product.save();

    res.status(200).json({
      success: true,
      message: 'Stock updated successfully',
      data: {
        productCode: product.productCode,
        name: product.name,
        stock: product.stock,
        status: product.status
      }
    });
  } catch (error) {
    console.error('Update stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating stock',
      error: error.message
    });
  }
});

// @route   PATCH /api/admin/products/:id/status
// @desc    Update product status
// @access  Admin
router.patch('/:id/status', editPerm, async (req, res) => {
  try {
    const { status } = req.body;

    const validStatuses = ['active', 'inactive', 'out_of_stock', 'discontinued'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { status, updatedBy: req.user._id },
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.status(200).json({
      success: true,
      message: `Product status changed to ${status} successfully`,
      data: product
    });
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating product status',
      error: error.message
    });
  }
});

// @route   PATCH /api/admin/products/:id/price
// @desc    Update product pricing
// @access  Admin
router.patch('/:id/price', editPerm, async (req, res) => {
  try {
    const { mrp, sellingPrice, discount } = req.body;

    const updateData = { updatedBy: req.user._id };

    if (mrp !== undefined) {
      updateData['price.mrp'] = mrp;
    }

    if (sellingPrice !== undefined) {
      updateData['price.sellingPrice'] = sellingPrice;
    }

    if (discount !== undefined) {
      updateData['price.discount'] = discount;
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Product price updated successfully',
      data: {
        productCode: product.productCode,
        name: product.name,
        price: product.price
      }
    });
  } catch (error) {
    console.error('Update price error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating product price',
      error: error.message
    });
  }
});

// @route   GET /api/admin/products/stats/overview
// @desc    Get product statistics overview
// @access  Admin
router.get('/stats/overview', viewPerm, async (req, res) => {
  try {
    const totalProducts = await Product.countDocuments();
    const activeProducts = await Product.countDocuments({ status: 'active' });
    const outOfStock = await Product.countDocuments({ 'stock.quantity': 0 });
    const lowStock = await Product.countDocuments({
      $expr: {
        $and: [
          { $gt: ['$stock.quantity', 0] },
          { $lte: ['$stock.quantity', '$stock.minStockLevel'] }
        ]
      }
    });

    // Get featured products count
    const featuredProducts = await Product.countDocuments({ isFeatured: true });

    // Get total stock value
    const stockValueAgg = await Product.aggregate([
      {
        $group: {
          _id: null,
          totalValue: { $sum: { $multiply: ['$stock.quantity', '$price.sellingPrice'] } }
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalProducts,
        activeProducts,
        outOfStock,
        lowStock,
        featuredProducts,
        totalStockValue: stockValueAgg[0]?.totalValue || 0
      }
    });
  } catch (error) {
    console.error('Get product stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching product statistics',
      error: error.message
    });
  }
});

// @route   POST /api/admin/products/bulk-update-status
// @desc    Bulk update product status
// @access  Admin
router.post('/bulk-update-status', editPerm, async (req, res) => {
  try {
    const { productIds, status } = req.body;

    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Product IDs array is required'
      });
    }

    const validStatuses = ['active', 'inactive', 'out_of_stock', 'discontinued'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    const result = await Product.updateMany(
      { _id: { $in: productIds } },
      { status, updatedBy: req.user._id }
    );

    res.status(200).json({
      success: true,
      message: `Updated ${result.modifiedCount} products to ${status}`,
      data: {
        matched: result.matchedCount,
        modified: result.modifiedCount
      }
    });
  } catch (error) {
    console.error('Bulk update error:', error);
    res.status(500).json({
      success: false,
      message: 'Error in bulk update',
      error: error.message
    });
  }
});

// ==================== PRODUCT MASTER CRUD ====================

// @route   POST /api/admin/products/master
// @desc    Create new ProductMaster entry
// @access  Admin (ecommerce:create)
router.post('/master', createPerm, requireStoreAccess, enforceProductLimit(), async (req, res) => {
  try {
    const product = await ProductMaster.create(req.body);

    if ('additional_sub_category_ids' in req.body) {
      await syncAdditionalSubCategoryMappings(product, req.body.additional_sub_category_ids);
    }

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: product
    });
  } catch (error) {
    console.error('Create ProductMaster error:', error);

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Product with this code already exists'
      });
    }

    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error creating product',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/products/master/:id
// @desc    Update ProductMaster entry
// @access  Admin (ecommerce:edit)
router.put('/master/:id', editPerm, async (req, res) => {
  try {
    // store_code is only known once the record is loaded, unlike
    // /by-store or /master (create) where it's already in the request —
    // so the access check happens here instead of via requireStoreAccess.
    // 404 rather than 403: a store-restricted admin shouldn't learn a
    // product in another store even exists.
    const existing = await ProductMaster.findById(req.params.id).select('store_code');
    if (!existing || !req.user.canAccessStore(existing.store_code)) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    // Also block moving the product to a store this admin can't reach.
    if (req.body.store_code && !req.user.canAccessStore(req.body.store_code)) {
      return res.status(403).json({
        success: false,
        message: `You do not have access to store ${req.body.store_code}`
      });
    }

    const product = await ProductMaster.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Guarded by presence, not truthiness — see syncAdditionalSubCategoryMappings.
    if ('additional_sub_category_ids' in req.body) {
      await syncAdditionalSubCategoryMappings(product, req.body.additional_sub_category_ids);
    }

    res.status(200).json({
      success: true,
      message: 'Product updated successfully',
      data: product
    });
  } catch (error) {
    console.error('Update ProductMaster error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error updating product',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/products/master/:id
// @desc    Delete ProductMaster entry
// @access  Admin (ecommerce:delete)
router.delete('/master/:id', deletePerm, async (req, res) => {
  try {
    const existing = await ProductMaster.findById(req.params.id).select('store_code');
    if (!existing || !req.user.canAccessStore(existing.store_code)) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const product = await ProductMaster.findByIdAndDelete(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    console.error('Delete ProductMaster error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting product',
      error: error.message
    });
  }
});

// ==================== BULK CSV UPDATE ====================

// Minimal comma-split parser — the real exports seen from store admins
// (e.g. My_need_mart_PRODUCT_RATE_MASTER CSV) have no quoted/escaped commas
// in any field, and often carry a trailing empty column from a stray comma
// at the end of every line; since every field below is read by NAME (via
// the header-built index), that extra empty column just goes unused rather
// than shifting anything.
function parseCsvBuffer(buffer) {
  return buffer
    .toString('utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(',').map((cell) => cell.trim()));
}

const PACKAGE_SIZE_RE = /^([0-9.]+)\s*([A-Za-z]+)$/;

// A form field arrives as the string "true"/"false" (multipart never sends
// real booleans) — this is also lenient about a bare "1".
const toBool = (v) => v === true || v === 'true' || v === '1';

// @route   POST /api/admin/products/bulk-update-csv
// @desc    Store admins periodically re-export their own rate/stock sheet
//          (P_CODE, BARCODE, package_size, BRAND_NAME, BR_CODE, our_price,
//          product_mrp, quantity, store_code_status) and upload it here to
//          push a fresh price/stock/active-status snapshot into the
//          catalog. Default pass is UPDATE-only, matched by p_code+store:
//          a combo with no existing product is reported and skipped
//          rather than inserted, since this file carries no department/
//          category to place a new product under (see
//          scripts/update_shree_mega_mart_pricing.js, which this route
//          productizes — same logic, now reusable by any tenant from the
//          admin panel instead of a one-off CLI run). pcode_img and
//          category placement are never touched.
//
//          Opt-in sync_mode=true turns this into a full daily reconcile,
//          for a tenant whose store sends "everything active today" every
//          day: (1) still updates every matched row's price/stock/status/
//          name as above; (2) CREATES a (p_code, store) combo that's in
//          the file but doesn't exist yet for that store, by cloning the
//          department/category/subcategory from a sibling row of the same
//          p_code in any other store — skipped (unresolvable) if no such
//          sibling exists anywhere, since there's nowhere to classify a
//          genuinely brand-new p_code; (3) DEACTIVATES (pcode_status ->
//          'N') any product that's currently active for a store appearing
//          in this file but whose p_code isn't in that store's rows today
//          — never touches a store the file doesn't mention at all. Guarded
//          against a partial/truncated file: if deactivating would drop
//          more than half of a store's currently-active catalog, that
//          store's deactivations are held back and reported in
//          deactivation_blocked instead of applied, until the same file is
//          resubmitted with confirm_deactivation=true. dry_run=true runs
//          every computation and returns the would-be counts without
//          writing anything, for previewing sync_mode before committing.
// @access  Admin (ecommerce:edit)
router.post('/bulk-update-csv', editPerm, csvUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'CSV file is required (field name "file")' });
    }

    // Resolved explicitly rather than via the ambient ProductMaster import:
    // for a large enough multipart upload, Node's AsyncLocalStorage context
    // (which the ambient tenant-model proxy depends on) does not reliably
    // survive multer/busboy's file-stream parsing — past some size the
    // request-scoped tenant context is lost and the proxy silently falls
    // back to the default tenant DB instead of erroring, so every row in a
    // real-sized CSV looks "not found" while the response still (correctly)
    // echoes the intended project_code. req.tenant is a plain property set
    // before multer ever runs, so it's unaffected — resolve the model from
    // it directly instead of trusting ALS this far into the request.
    const ProductMasterTenant = getTenantDb(req.tenant.project.db_name).models.ProductMaster;

    // A single global store_code (given in the body) forces every row to
    // that one store — the common single-store upload, and mandatory for a
    // store-restricted admin (without it, a p_code match would span every
    // store in the tenant, letting a store manager's upload touch another
    // store's catalog). Omitted, and when the file itself carries a
    // BR_CODE column, each row is matched against its own BR_CODE instead
    // — despite the name, this tenant's exports use it for the store code,
    // not a brand code — so one file can refresh several stores at once.
    const bodyStoreCode = typeof req.body.store_code === 'string' ? req.body.store_code.trim() : '';
    const syncMode = toBool(req.body.sync_mode);
    const confirmDeactivation = toBool(req.body.confirm_deactivation);
    const dryRun = toBool(req.body.dry_run);

    if (!bodyStoreCode && req.user.allowed_store_codes && req.user.allowed_store_codes.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'store_code is required for your account'
      });
    }
    if (bodyStoreCode && !req.user.canAccessStore(bodyStoreCode)) {
      return res.status(403).json({
        success: false,
        message: `You do not have access to store ${bodyStoreCode}`
      });
    }

    const rows = parseCsvBuffer(req.file.buffer);
    if (rows.length < 2) {
      return res.status(400).json({ success: false, message: 'CSV has no data rows' });
    }

    const header = rows[0].map((h) => h.trim());
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    if (idx.P_CODE === undefined) {
      return res.status(400).json({ success: false, message: 'CSV is missing a P_CODE column' });
    }

    const dataRows = rows.slice(1).filter((r) => r.length > 1 && r[idx.P_CODE] && r[idx.P_CODE].trim());

    // The store each row matches against: the explicit body store_code
    // wins when given; otherwise that row's own BR_CODE. A row with
    // neither has nothing to match on and is reported, not guessed at.
    const rowStoreCode = (row) =>
      bodyStoreCode || (idx.BR_CODE !== undefined ? (row[idx.BR_CODE] || '').trim() : '');

    const pcodes = [...new Set(dataRows.map((r) => r[idx.P_CODE].trim()))];
    const storeCodesInFile = [...new Set(dataRows.map(rowStoreCode).filter(Boolean))];

    const matchQuery = { p_code: { $in: pcodes } };
    if (storeCodesInFile.length) matchQuery.store_code = { $in: storeCodesInFile };

    const existing = await ProductMasterTenant.find(matchQuery)
      .select('p_code store_code our_price pcode_status');
    // Keyed by p_code+store_code, not p_code alone — a multi-store file
    // (BR_CODE varying per row) legitimately repeats the same p_code once
    // per store, and each occurrence is a different real document.
    const existingByKey = new Map(existing.map((p) => [`${p.p_code}|${p.store_code}`, p]));

    let updated = 0;
    let priceChanged = 0;
    let statusChanged = 0;
    const skippedNotFound = [];
    const packageSizeSkipped = [];

    for (const row of dataRows) {
      const pcode = row[idx.P_CODE].trim();
      const targetStore = rowStoreCode(row);
      const current = targetStore ? existingByKey.get(`${pcode}|${targetStore}`) : undefined;
      if (!current) {
        skippedNotFound.push(targetStore ? `${pcode} (${targetStore})` : pcode);
        continue;
      }

      // Every field is independent — a malformed package_size on one row
      // must not block that same row's price/stock/status update, so a
      // parse failure just skips setting package_size/package_unit, not
      // the whole row.
      const set = {};

      if (idx.BARCODE !== undefined && row[idx.BARCODE]) set.barcode = row[idx.BARCODE].trim();
      if (idx.product_name !== undefined && row[idx.product_name]) set.product_name = row[idx.product_name].trim();
      if (idx.BRAND_NAME !== undefined && row[idx.BRAND_NAME]) set.brand_name = row[idx.BRAND_NAME].trim();
      // BR_CODE/store_code is used above only to pick which store's record
      // this row updates — never written back; reassigning a product to a
      // different store is a classification change, out of scope here.

      if (idx.package_size !== undefined && row[idx.package_size]) {
        const m = PACKAGE_SIZE_RE.exec(row[idx.package_size].trim());
        if (m) {
          set.package_size = parseFloat(m[1]);
          set.package_unit = m[2].toUpperCase();
        } else {
          packageSizeSkipped.push({ p_code: pcode, package_size: row[idx.package_size].trim() });
        }
      }

      if (idx.our_price !== undefined && row[idx.our_price] !== '' && row[idx.our_price] !== undefined) {
        set.our_price = row[idx.our_price].trim();
      }
      if (idx.product_mrp !== undefined && row[idx.product_mrp] !== '' && row[idx.product_mrp] !== undefined) {
        set.product_mrp = row[idx.product_mrp].trim();
      }
      if (idx.quantity !== undefined && row[idx.quantity] !== '' && row[idx.quantity] !== undefined) {
        set.store_quantity = Number(row[idx.quantity]) || 0;
      }
      if (idx.store_code_status !== undefined && row[idx.store_code_status]) {
        set.pcode_status = row[idx.store_code_status].trim().toUpperCase() === 'N' ? 'N' : 'Y';
      }

      if (Object.keys(set).length === 0) continue;

      if (!dryRun) {
        await ProductMasterTenant.updateOne({ _id: current._id }, { $set: set });
      }
      updated++;

      if (set.our_price !== undefined) {
        const before = parseFloat(current.our_price ? current.our_price.toString() : '0');
        const after = parseFloat(set.our_price);
        if (!Number.isNaN(after) && Math.abs(before - after) > 0.01) priceChanged++;
      }
      if (set.pcode_status !== undefined && set.pcode_status !== current.pcode_status) {
        statusChanged++;
      }
    }

    // ==== sync_mode: create newly-stocked combos, deactivate dropped ones ====
    let created = 0;
    const createdDetails = [];
    let createdUnclassified = 0;
    const createdUnclassifiedDetails = [];
    const unresolvablePcodes = [];
    let deactivated = 0;
    const deactivatedCodes = [];
    const deactivationBlocked = [];

    if (syncMode) {
      // --- Create: (p_code, store) combos the file mentions with no
      // existing document. The CSV never carries department/category/
      // subcategory itself, so classification can only come from a
      // sibling — the same p_code already sitting in ANY other store (not
      // just the ones in this file). When no sibling exists anywhere
      // either (a p_code genuinely new to the whole catalog), the product
      // is still created — deliberately left unclassified (empty dept/
      // category/sub_category_id) rather than skipped outright, so it
      // shows up via the Unclassified-only filter on the Products page
      // for someone to classify by hand, instead of silently never
      // existing. unclassifiedOr elsewhere in this route is exactly what
      // then finds it: an empty string matches none of the tenant's real
      // department/category/subcategory ids. ---
      const missingRows = dataRows
        .map((row) => ({ row, pcode: row[idx.P_CODE].trim(), targetStore: rowStoreCode(row) }))
        .filter(({ pcode, targetStore }) => targetStore && !existingByKey.has(`${pcode}|${targetStore}`));

      if (missingRows.length) {
        const missingPcodes = [...new Set(missingRows.map((m) => m.pcode))];
        const siblings = await ProductMasterTenant.find({ p_code: { $in: missingPcodes } })
          .select('p_code dept_id category_id sub_category_id package_size package_unit brand_name product_name barcode max_quantity_allowed search_keyword project_code')
          .lean();
        const siblingByPcode = new Map();
        for (const doc of siblings) {
          if (!siblingByPcode.has(doc.p_code)) siblingByPcode.set(doc.p_code, doc);
        }

        // The same (p_code, store) can appear more than once if the source
        // file has duplicate rows — collapse to the last occurrence rather
        // than creating (or trying to) the same combo twice.
        const toCreate = new Map();
        for (const { row, pcode, targetStore } of missingRows) {
          const sibling = siblingByPcode.get(pcode);

          // Package size/unit: from a sibling when one exists, otherwise
          // parsed straight off this row's own package_size column — the
          // one piece of this data every row carries regardless of
          // whether a sibling exists to clone the rest from.
          let packageSize = sibling ? sibling.package_size : undefined;
          let packageUnit = sibling ? sibling.package_unit : undefined;
          if (idx.package_size !== undefined && row[idx.package_size]) {
            const m = PACKAGE_SIZE_RE.exec(row[idx.package_size].trim());
            if (m) {
              packageSize = parseFloat(m[1]);
              packageUnit = m[2].toUpperCase();
            }
          }
          if (packageSize === undefined || !packageUnit) {
            unresolvablePcodes.push(pcode);
            continue;
          }

          const productName = (idx.product_name !== undefined && row[idx.product_name])
            ? row[idx.product_name].trim()
            : (sibling ? sibling.product_name : undefined);
          if (!productName) {
            unresolvablePcodes.push(pcode);
            continue;
          }

          const ourPriceRaw = idx.our_price !== undefined && row[idx.our_price] !== '' ? row[idx.our_price].trim() : null;
          const productMrpRaw = idx.product_mrp !== undefined && row[idx.product_mrp] !== '' ? row[idx.product_mrp].trim() : null;
          if (!ourPriceRaw || !productMrpRaw) {
            unresolvablePcodes.push(pcode);
            continue;
          }

          const quantity = idx.quantity !== undefined && row[idx.quantity] !== '' ? Number(row[idx.quantity]) || 0 : 0;
          const statusRaw = idx.store_code_status !== undefined ? row[idx.store_code_status] : '';
          const pcodeStatus = statusRaw && statusRaw.trim().toUpperCase() === 'N' ? 'N' : 'Y';

          toCreate.set(`${pcode}|${targetStore}`, {
            p_code: pcode,
            barcode: (idx.BARCODE !== undefined && row[idx.BARCODE]) ? row[idx.BARCODE].trim() : (sibling ? sibling.barcode || '' : ''),
            product_name: productName,
            package_size: packageSize,
            package_unit: packageUnit,
            product_mrp: mongoose.Types.Decimal128.fromString(productMrpRaw),
            our_price: mongoose.Types.Decimal128.fromString(ourPriceRaw),
            brand_name: (idx.BRAND_NAME !== undefined && row[idx.BRAND_NAME]) ? row[idx.BRAND_NAME].trim() : (sibling ? sibling.brand_name || '' : ''),
            store_code: targetStore,
            pcode_status: pcodeStatus,
            // No sibling anywhere to clone a real classification from —
            // left unclassified rather than fabricated. Empty string
            // satisfies the schema's required check while matching none
            // of the tenant's real ids, so unclassified_only picks it up.
            dept_id: sibling ? sibling.dept_id : '',
            category_id: sibling ? sibling.category_id : '',
            sub_category_id: sibling ? sibling.sub_category_id : '',
            store_quantity: quantity,
            max_quantity_allowed: sibling ? sibling.max_quantity_allowed || 10 : 10,
            search_keyword: sibling ? sibling.search_keyword || undefined : undefined,
            project_code: sibling ? sibling.project_code || req.tenant.projectCode : req.tenant.projectCode,
            _unclassified: !sibling
          });
        }

        const docsToCreate = [...toCreate.values()];
        if (docsToCreate.length && !dryRun) {
          // _unclassified is a marker for this handler only, not a schema
          // field — stripped before insert.
          await ProductMasterTenant.insertMany(
            docsToCreate.map(({ _unclassified, ...doc }) => doc),
            { ordered: false }
          );
        }
        created = docsToCreate.length;
        createdDetails.push(...docsToCreate.slice(0, 50).map((d) => `${d.p_code} (${d.store_code})`));
        const unclassifiedCreated = docsToCreate.filter((d) => d._unclassified);
        createdUnclassified = unclassifiedCreated.length;
        createdUnclassifiedDetails.push(...unclassifiedCreated.slice(0, 50).map((d) => `${d.p_code} (${d.store_code})`));
      }

      // --- Deactivate: active docs for a store this file mentions, whose
      // p_code isn't among that store's rows today. A store the file
      // doesn't mention at all is never touched. ---
      const filePcodesByStore = new Map();
      for (const row of dataRows) {
        const store = rowStoreCode(row);
        if (!store) continue;
        if (!filePcodesByStore.has(store)) filePcodesByStore.set(store, new Set());
        filePcodesByStore.get(store).add(row[idx.P_CODE].trim());
      }

      for (const store of storeCodesInFile) {
        const filePcodes = filePcodesByStore.get(store) || new Set();
        const currentActive = await ProductMasterTenant.find({ store_code: store, pcode_status: 'Y' })
          .select('p_code -_id')
          .lean();
        const toDeactivate = currentActive.filter((d) => !filePcodes.has(d.p_code));
        if (toDeactivate.length === 0) continue;

        const ratio = toDeactivate.length / currentActive.length;
        if (ratio > 0.5 && !confirmDeactivation) {
          deactivationBlocked.push({
            store_code: store,
            active_count: currentActive.length,
            would_deactivate: toDeactivate.length,
            ratio: Math.round(ratio * 100) / 100
          });
          continue;
        }

        if (!dryRun) {
          await ProductMasterTenant.updateMany(
            { store_code: store, p_code: { $in: toDeactivate.map((d) => d.p_code) }, pcode_status: 'Y' },
            { $set: { pcode_status: 'N' } }
          );
        }
        deactivated += toDeactivate.length;
        deactivatedCodes.push(...toDeactivate.slice(0, 50).map((d) => `${d.p_code} (${store})`));
      }
    }

    const message = syncMode
      ? `${dryRun ? '[Dry run] ' : ''}Sync: updated ${updated}, created ${created}${createdUnclassified ? ` (${createdUnclassified} unclassified)` : ''}, deactivated ${deactivated} of ${dataRows.length} row(s)`
      : `Updated ${updated} of ${dataRows.length} product(s) from the CSV`;

    res.status(200).json({
      success: true,
      message,
      data: {
        // Echoes back exactly what this update was matched against, so the
        // panel can confirm it after the fact — a wrong project/store
        // selected at upload time shows up here as skipped_not_found near
        // total_rows, not as a silent no-op.
        project_code: req.tenant.projectCode,
        store_code: bodyStoreCode || null,
        // Every distinct store actually matched against — populated even
        // when store_code above is null (a multi-store, BR_CODE-driven
        // upload has no single store_code to echo).
        store_codes_matched: storeCodesInFile,
        total_rows: dataRows.length,
        updated,
        price_changed: priceChanged,
        status_changed: statusChanged,
        skipped_not_found: skippedNotFound.length,
        skipped_not_found_codes: skippedNotFound.slice(0, 50),
        package_size_not_updated: packageSizeSkipped.length,
        package_size_not_updated_details: packageSizeSkipped.slice(0, 20),
        sync_mode: syncMode,
        dry_run: dryRun,
        created,
        created_details: createdDetails,
        // Subset of `created` that had no sibling anywhere to clone a real
        // classification from — created anyway, deliberately unclassified.
        created_unclassified: createdUnclassified,
        created_unclassified_details: createdUnclassifiedDetails,
        // Now only p_codes that couldn't be created at all (no package
        // size obtainable, no product name, or no price in the row) —
        // a missing classification alone no longer lands here.
        unresolvable_pcodes: [...new Set(unresolvablePcodes)].slice(0, 50),
        deactivated,
        deactivated_codes: deactivatedCodes,
        // Non-empty only when a store's deactivation was held back by the
        // partial-file safety guard — resubmit the same file with
        // confirm_deactivation=true to force it through.
        deactivation_blocked: deactivationBlocked
      }
    });
  } catch (error) {
    console.error('Bulk update CSV error:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing CSV',
      error: error.message
    });
  }
});

module.exports = router;
