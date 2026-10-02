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
// subcategories (beyond the primary) is each product cross-mapped to, for
// THIS store specifically — SubcategoryProductMap stays per-(p_code,
// store_code) by design (a product can be cross-mapped differently per
// store), so a caller that's already store-scoped must filter by store
// here too, or a product's additional-subcategory list bleeds in entries
// that only apply to a different store.
const buildAdditionalSubCategoryIdsMap = async (pCodes = [], storeCode) => {
  const uniqueCodes = [...new Set(pCodes.filter(Boolean))];
  if (uniqueCodes.length === 0) return {};

  const mappings = await SubcategoryProductMap.find({ p_code: { $in: uniqueCodes }, store_code: storeCode });

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
// storeCode is explicit, not read off `product` — SubcategoryProductMap
// stays per-(p_code, store_code), but a ProductMaster document is no
// longer itself scoped to one store, so there's no `product.store_code` to
// fall back on.
const syncAdditionalSubCategoryMappings = async (product, additionalSubCategoryIds, storeCode) => {
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

  await SubcategoryProductMap.replaceForProduct(product.p_code, storeCode, uniqueIds);
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

    const storeCode = store_code.trim();

    // $elemMatch, not two separate 'stores.store_code'/'stores.pcode_status'
    // conditions — both have to hold on the SAME stores[] entry, or this
    // would match a doc where any element has this store_code and any
    // element (possibly a different one) has the right status.
    const storeElemMatch = { store_code: storeCode };
    if (status === 'active') {
      storeElemMatch.pcode_status = 'Y';
    } else if (status === 'inactive') {
      storeElemMatch.pcode_status = 'N';
    }
    // status === 'all' (or anything else unrecognized): no pcode_status
    // filter at all.

    // Build query
    const query = { stores: { $elemMatch: storeElemMatch } };

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

    // A plain find() can no longer flatten a matched stores[] entry onto
    // the top level by itself, so both the search and non-search paths now
    // go through one aggregation: $match, then pull this store's own
    // listing out of stores[] into `_store` for the response/sort to read.
    const basePipeline = [
      { $match: query },
      {
        $addFields: {
          _store: {
            $first: {
              $filter: {
                input: '$stores',
                cond: { $eq: ['$$this.store_code', storeCode] }
              }
            }
          }
        }
      }
    ];

    // sortBy can name either an identity field (product_name, p_code — top
    // level, unchanged) or a per-store field (our_price, store_quantity,
    // pcode_status — now under _store).
    const PER_STORE_SORT_FIELDS = new Set(['our_price', 'product_mrp', 'store_quantity', 'pcode_status', 'max_quantity_allowed']);
    const sortField = PER_STORE_SORT_FIELDS.has(sortBy) ? `_store.${sortBy}` : sortBy;

    let pipeline;
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
      pipeline = [
        ...basePipeline,
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
    } else {
      pipeline = [
        ...basePipeline,
        { $sort: { [sortField]: sortOrder === 'asc' ? 1 : -1 } },
        { $skip: skip },
        { $limit: parseInt(limit) }
      ];
    }

    const products = await ProductMaster.aggregate(pipeline);
    const total = await ProductMaster.countDocuments(query);

    const additionalSubCategoryIdsMap = await buildAdditionalSubCategoryIdsMap(
      products.map(product => product.p_code),
      storeCode
    );

    // Format response data — identity fields off the document root, price/
    // stock/status off the flattened _store entry.
    const productsData = products.map(product => ({
      id: product._id,
      p_code: product.p_code,
      barcode: product.barcode,
      product_name: product.product_name,
      product_description: product.product_description,
      package_size: product.package_size,
      package_unit: product.package_unit,
      product_mrp: product._store?.product_mrp ? parseFloat(product._store.product_mrp.toString()) : 0,
      our_price: product._store?.our_price ? parseFloat(product._store.our_price.toString()) : 0,
      brand_name: product.brand_name,
      store_code: storeCode,
      pcode_status: product._store?.pcode_status,
      dept_id: product.dept_id,
      category_id: product.category_id,
      sub_category_id: product.sub_category_id,
      additional_sub_category_ids: additionalSubCategoryIdsMap[product.p_code] || [],
      store_quantity: product._store?.store_quantity,
      max_quantity_allowed: product._store?.max_quantity_allowed,
      pcode_img: product.pcode_img
    }));

    // Store-wide counters for the header — deliberately ignore every filter
    // above (department/category/search/status) so they read as a stable
    // "how's this store doing overall" figure, not one that jumps around as
    // someone types into search. total_products/active_count are always
    // computed; inactive_count/unclassified_active_count are mutually
    // exclusive with each other, matching whichever side of the
    // Unclassified-only toggle the request is on.
    const totalProducts = await ProductMaster.countDocuments({ 'stores.store_code': storeCode });
    const activeCount = await ProductMaster.countDocuments({
      stores: { $elemMatch: { store_code: storeCode, pcode_status: 'Y' } }
    });
    let inactiveCount = null;
    let unclassifiedActiveCount = null;
    if (unclassified_only && unclassifiedOr) {
      unclassifiedActiveCount = await ProductMaster.countDocuments({
        stores: { $elemMatch: { store_code: storeCode, pcode_status: 'Y' } },
        $or: unclassifiedOr
      });
    } else {
      inactiveCount = await ProductMaster.countDocuments({
        stores: { $elemMatch: { store_code: storeCode, pcode_status: 'N' } }
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
// @desc    Create a new product, OR — when p_code already exists for this
//          tenant — add a new store listing to it. Two real actions
//          sharing one endpoint, distinguished by whether p_code is
//          already known: identity fields (name/barcode/category/image)
//          only ever apply on the create path; adding to another store
//          never touches them, since they already belong to the existing
//          document and affect every store at once.
// @access  Admin (ecommerce:create)
router.post('/master', createPerm, requireStoreAccess, enforceProductLimit(), async (req, res) => {
  try {
    const {
      p_code, store_code,
      our_price, product_mrp, store_quantity, pcode_status, max_quantity_allowed,
      additional_sub_category_ids,
      ...identityFields
    } = req.body;

    if (!p_code || !store_code) {
      return res.status(400).json({
        success: false,
        message: 'p_code and store_code are required'
      });
    }

    const storeListing = { store_code, our_price, product_mrp, store_quantity, pcode_status, max_quantity_allowed };

    const existing = await ProductMaster.findOne({ p_code });
    let product;
    let statusCode = 201;

    if (existing) {
      if (existing.storeListing(store_code)) {
        return res.status(400).json({
          success: false,
          message: `${p_code} is already listed at store ${store_code}`
        });
      }
      // Conditional on the push itself ($ne), not just the read above —
      // nothing in Mongo stops two concurrent requests from both passing
      // the existing.storeListing() check and both pushing; this makes
      // the actual write race-safe instead of just the read.
      product = await ProductMaster.findOneAndUpdate(
        { p_code, 'stores.store_code': { $ne: store_code } },
        { $push: { stores: storeListing } },
        { new: true, runValidators: true }
      );
      if (!product) {
        return res.status(409).json({
          success: false,
          message: `${p_code} is already listed at store ${store_code} (added by another request just now)`
        });
      }
      statusCode = 200;
    } else {
      product = await ProductMaster.create({
        ...identityFields,
        p_code,
        project_code: req.tenant.projectCode,
        stores: [storeListing]
      });
    }

    if ('additional_sub_category_ids' in req.body) {
      await syncAdditionalSubCategoryMappings(product, additional_sub_category_ids, store_code);
    }

    res.status(statusCode).json({
      success: true,
      message: existing ? 'Store listing added' : 'Product created successfully',
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
// @desc    Edit this product. Two shapes in one request, kept separate
//          internally: a `store_code` + any of
//          our_price/product_mrp/store_quantity/pcode_status/
//          max_quantity_allowed edits ONE store's listing via an
//          arrayFilters update; everything else in the body (name/barcode/
//          category/image/etc.) is an identity edit applied once, which
//          affects every store this product is listed at — a
//          store-restricted admin is blocked from that unless they can
//          access every store the product is listed at (see below), since
//          it isn't really "their store's" change to make alone.
// @access  Admin (ecommerce:edit)
router.put('/master/:id', editPerm, async (req, res) => {
  try {
    const existing = await ProductMaster.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const {
      store_code,
      our_price, product_mrp, store_quantity, pcode_status, max_quantity_allowed,
      additional_sub_category_ids,
      ...identityFields
    } = req.body;

    const listedStoreCodes = existing.stores.map((s) => s.store_code);
    // 404, not 403, for a store this admin can't reach at all — a
    // store-restricted admin shouldn't learn a product is listed
    // somewhere else even exists. Only applies when the product is listed
    // at a store outside their access; a product entirely within their
    // reach never trips this.
    if (!listedStoreCodes.every((s) => req.user.canAccessStore(s)) && !req.user.canAccessStore(store_code || listedStoreCodes[0])) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const hasStoreEdit = [our_price, product_mrp, store_quantity, pcode_status, max_quantity_allowed]
      .some((v) => v !== undefined);
    const hasIdentityEdit = Object.keys(identityFields).length > 0;

    if (hasStoreEdit) {
      if (!store_code) {
        return res.status(400).json({
          success: false,
          message: 'store_code is required to edit price/stock/status'
        });
      }
      if (!req.user.canAccessStore(store_code)) {
        return res.status(403).json({
          success: false,
          message: `You do not have access to store ${store_code}`
        });
      }
      if (!existing.storeListing(store_code)) {
        return res.status(404).json({
          success: false,
          message: `${existing.p_code} is not listed at store ${store_code}`
        });
      }

      const storeSet = {};
      if (our_price !== undefined) storeSet['stores.$[elem].our_price'] = our_price;
      if (product_mrp !== undefined) storeSet['stores.$[elem].product_mrp'] = product_mrp;
      if (store_quantity !== undefined) storeSet['stores.$[elem].store_quantity'] = store_quantity;
      if (pcode_status !== undefined) storeSet['stores.$[elem].pcode_status'] = pcode_status;
      if (max_quantity_allowed !== undefined) storeSet['stores.$[elem].max_quantity_allowed'] = max_quantity_allowed;

      await ProductMaster.updateOne(
        { _id: req.params.id },
        { $set: storeSet },
        { arrayFilters: [{ 'elem.store_code': store_code }], runValidators: true }
      );
    }

    if (hasIdentityEdit) {
      // Editing identity affects every store at once — a store-restricted
      // admin needs access to all of them, not just one, or this is
      // silently changing something for a store they can't even see.
      if (!listedStoreCodes.every((s) => req.user.canAccessStore(s))) {
        return res.status(403).json({
          success: false,
          message: 'Editing name/category/image affects every store this product is listed at — you do not have access to all of them'
        });
      }
      await ProductMaster.updateOne(
        { _id: req.params.id },
        { $set: identityFields },
        { runValidators: true }
      );
    }

    const product = await ProductMaster.findById(req.params.id);

    // Guarded by presence, not truthiness — see syncAdditionalSubCategoryMappings.
    if ('additional_sub_category_ids' in req.body) {
      await syncAdditionalSubCategoryMappings(product, additional_sub_category_ids, store_code || listedStoreCodes[0]);
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
// @desc    Remove this product from one store (store_code in the body —
//          $pull one stores[] entry), or delete the whole document when
//          no store_code is given AND the admin can access every store
//          it's listed at. A store-restricted admin's delete always means
//          "remove my store's listing," never the whole product — even if
//          they happen to be the only store it's listed at, since that's
//          still a $pull down to an empty stores[], not a document delete,
//          for consistency with what "their delete button" always does.
// @access  Admin (ecommerce:delete)
router.delete('/master/:id', deletePerm, async (req, res) => {
  try {
    const existing = await ProductMaster.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const listedStoreCodes = existing.stores.map((s) => s.store_code);
    const isStoreRestricted = !!(req.user.allowed_store_codes && req.user.allowed_store_codes.length > 0);
    const store_code = req.body.store_code || (isStoreRestricted ? req.user.allowed_store_codes.find((s) => listedStoreCodes.includes(s)) : undefined);

    if (store_code && !listedStoreCodes.includes(store_code)) {
      return res.status(404).json({
        success: false,
        message: `${existing.p_code} is not listed at store ${store_code}`
      });
    }
    if (store_code && !req.user.canAccessStore(store_code)) {
      return res.status(403).json({
        success: false,
        message: `You do not have access to store ${store_code}`
      });
    }
    if (!store_code && !listedStoreCodes.every((s) => req.user.canAccessStore(s))) {
      // Whole-document delete requested (or forced, for a store-restricted
      // admin with no accessible listing on this product) but this admin
      // can't reach every store it's listed at — 404, not 403, same reasoning
      // as PUT above.
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (store_code) {
      await ProductMaster.updateOne({ _id: req.params.id }, { $pull: { stores: { store_code } } });
      await SubcategoryProductMap.deleteMany({ p_code: existing.p_code, store_code });
    } else {
      await ProductMaster.findByIdAndDelete(req.params.id);
      await SubcategoryProductMap.deleteMany({ p_code: existing.p_code });
    }

    res.status(200).json({
      success: true,
      message: store_code ? `Removed from store ${store_code}` : 'Product deleted successfully'
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

// Placeholder dept/category/sub_category_id for a sync-created product with
// no sibling anywhere to clone real classification from. Can't be '' —
// Mongoose's required validator rejects an empty string for a String field,
// which silently drops the whole insertMany document when combined with
// { ordered: false } (no document, no thrown error either — it was passing
// validation past nobody's notice). Guaranteed to never collide with a real
// id, which are numeric strings everywhere in this dataset, so it still
// falls out of unclassified_only's $nin check exactly like '' would have.
const UNCLASSIFIED_ID = 'UNCLASSIFIED';

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

    // The admin panel always sends whichever store happens to be selected
    // in its sidebar as store_code — that's ambient UI context (which
    // store you're currently "looking at"), not an instruction to force a
    // multi-store file onto one store. A real incident came from exactly
    // this: a multi-store file uploaded while one store was selected
    // force-matched EVERY row (including every other store's rows) onto
    // that single store, repeatedly overwriting it and never correctly
    // deactivating anything for it either — rowStoreCode below is what
    // actually decides this now, not this value directly.
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

    // The store each row matches against:
    //   - a store-restricted admin is pinned to their own (already
    //     access-checked) store, full stop — the file's BR_CODE can never
    //     be used to reach past it. Any row for another store just won't
    //     match anything and comes back skipped, not applied elsewhere.
    //   - otherwise, the row's own BR_CODE wins whenever the file carries
    //     one, regardless of which store is selected in the panel's
    //     sidebar — that selection is just ambient context, not a scope
    //     for this upload. Falls back to the body store_code only when
    //     the file has no BR_CODE column at all (a genuine single-store
    //     export).
    // A row with neither has nothing to match on and is reported, not
    // guessed at.
    const isStoreRestricted = !!(req.user.allowed_store_codes && req.user.allowed_store_codes.length > 0);
    const rowStoreCode = (row) => {
      if (isStoreRestricted) return bodyStoreCode;
      const fileStore = idx.BR_CODE !== undefined ? (row[idx.BR_CODE] || '').trim() : '';
      return fileStore || bodyStoreCode;
    };

    const pcodes = [...new Set(dataRows.map((r) => r[idx.P_CODE].trim()))];
    const storeCodesInFile = [...new Set(dataRows.map(rowStoreCode).filter(Boolean))];

    // Fetched by p_code alone now — one document per product, carrying
    // every store's listing in stores[]. Per-row lookups below pull the
    // specific store's listing out of it.
    const existing = await ProductMasterTenant.find({ p_code: { $in: pcodes } });
    const existingByPcode = new Map(existing.map((p) => [p.p_code, p]));

    let updated = 0;
    let priceChanged = 0;
    let statusChanged = 0;
    const skippedNotFound = [];
    const packageSizeSkipped = [];
    const updateOps = [];

    for (const row of dataRows) {
      const pcode = row[idx.P_CODE].trim();
      const targetStore = rowStoreCode(row);
      const current = targetStore ? existingByPcode.get(pcode) : undefined;
      const currentListing = current?.storeListing(targetStore);
      if (!current || !currentListing) {
        skippedNotFound.push(targetStore ? `${pcode} (${targetStore})` : pcode);
        continue;
      }

      // Identity fields (affect every store this product is listed at) and
      // per-store fields (this one row's store only) are two different
      // kinds of update against the same document — a flat $set can't mix
      // a top-level field with an arrayFilters-targeted one in a way that's
      // obviously correct, so they're built and applied separately.
      const identitySet = {};
      const storeSet = {};

      if (idx.BARCODE !== undefined && row[idx.BARCODE]) identitySet.barcode = row[idx.BARCODE].trim();
      if (idx.product_name !== undefined && row[idx.product_name]) identitySet.product_name = row[idx.product_name].trim();
      if (idx.BRAND_NAME !== undefined && row[idx.BRAND_NAME]) identitySet.brand_name = row[idx.BRAND_NAME].trim();
      // BR_CODE/store_code is used above only to pick which store's listing
      // this row updates — never written back; reassigning a product to a
      // different store is a classification change, out of scope here.

      // A malformed package_size on one row must not block that same row's
      // price/stock/status update, so a parse failure just skips setting
      // package_size/package_unit, not the whole row.
      if (idx.package_size !== undefined && row[idx.package_size]) {
        const m = PACKAGE_SIZE_RE.exec(row[idx.package_size].trim());
        if (m) {
          identitySet.package_size = parseFloat(m[1]);
          identitySet.package_unit = m[2].toUpperCase();
        } else {
          packageSizeSkipped.push({ p_code: pcode, package_size: row[idx.package_size].trim() });
        }
      }

      let newPrice;
      let newStatus;
      if (idx.our_price !== undefined && row[idx.our_price] !== '' && row[idx.our_price] !== undefined) {
        newPrice = row[idx.our_price].trim();
        storeSet['stores.$[elem].our_price'] = newPrice;
      }
      if (idx.product_mrp !== undefined && row[idx.product_mrp] !== '' && row[idx.product_mrp] !== undefined) {
        storeSet['stores.$[elem].product_mrp'] = row[idx.product_mrp].trim();
      }
      if (idx.quantity !== undefined && row[idx.quantity] !== '' && row[idx.quantity] !== undefined) {
        storeSet['stores.$[elem].store_quantity'] = Number(row[idx.quantity]) || 0;
      }
      if (idx.store_code_status !== undefined && row[idx.store_code_status]) {
        newStatus = row[idx.store_code_status].trim().toUpperCase() === 'N' ? 'N' : 'Y';
        storeSet['stores.$[elem].pcode_status'] = newStatus;
      }

      const hasIdentityChange = Object.keys(identitySet).length > 0;
      const hasStoreChange = Object.keys(storeSet).length > 0;
      if (!hasIdentityChange && !hasStoreChange) continue;

      if (!dryRun) {
        const update = { $set: { ...identitySet, ...storeSet } };
        const options = hasStoreChange ? { arrayFilters: [{ 'elem.store_code': targetStore }] } : {};
        updateOps.push({ updateOne: { filter: { _id: current._id }, update, ...options } });
      }
      updated++;

      if (newPrice !== undefined) {
        const before = parseFloat(currentListing.our_price ? currentListing.our_price.toString() : '0');
        const after = parseFloat(newPrice);
        if (!Number.isNaN(after) && Math.abs(before - after) > 0.01) priceChanged++;
      }
      if (newStatus !== undefined && newStatus !== currentListing.pcode_status) {
        statusChanged++;
      }
    }

    if (!dryRun && updateOps.length) {
      await ProductMasterTenant.bulkWrite(updateOps, { ordered: false });
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
      // existing listing. There are two real cases now, and the old
      // "clone from a sibling in another store" mechanism this used to
      // need is GONE for one of them: once there's one document per
      // product, a p_code already known to this tenant already has its
      // identity fields (name/barcode/package/category) sitting right on
      // the document — a missing store for it is just a new stores[]
      // entry, nothing to clone. Only a p_code genuinely new to the whole
      // tenant (no document at all) needs identity fields built from the
      // row, and even then there's nowhere to classify it — left
      // unclassified (UNCLASSIFIED_ID) rather than fabricated, so it shows
      // up via the Unclassified-only filter for someone to classify by
      // hand instead of silently never existing. ---
      const missingRows = dataRows
        .map((row) => ({ row, pcode: row[idx.P_CODE].trim(), targetStore: rowStoreCode(row) }))
        .filter(({ pcode, targetStore }) => {
          if (!targetStore) return false;
          const current = existingByPcode.get(pcode);
          return !current || !current.storeListing(targetStore);
        });

      if (missingRows.length) {
        // Grouped by p_code so a brand-new product introduced to several
        // stores in the same file becomes ONE new document carrying every
        // target store's listing, not several inserts racing on the same
        // p_code — and so a known p_code missing from two stores becomes
        // one $push of both listings, not two separate updates.
        const missingByPcode = new Map();
        for (const m of missingRows) {
          if (!missingByPcode.has(m.pcode)) missingByPcode.set(m.pcode, new Map());
          // Same (pcode, store) appearing twice in the file — last row wins.
          missingByPcode.get(m.pcode).set(m.targetStore, m.row);
        }

        // Builds one store-listing subdocument from a row, or null (and
        // records why) if the row can't supply the required price fields —
        // the one thing that can never be inferred from anywhere else.
        const buildListing = (pcode, targetStore, row) => {
          const ourPriceRaw = idx.our_price !== undefined && row[idx.our_price] !== '' ? row[idx.our_price].trim() : null;
          const productMrpRaw = idx.product_mrp !== undefined && row[idx.product_mrp] !== '' ? row[idx.product_mrp].trim() : null;
          if (!ourPriceRaw || !productMrpRaw) {
            unresolvablePcodes.push(pcode);
            return null;
          }
          const quantity = idx.quantity !== undefined && row[idx.quantity] !== '' ? Number(row[idx.quantity]) || 0 : 0;
          const statusRaw = idx.store_code_status !== undefined ? row[idx.store_code_status] : '';
          const pcodeStatus = statusRaw && statusRaw.trim().toUpperCase() === 'N' ? 'N' : 'Y';
          return {
            store_code: targetStore,
            our_price: mongoose.Types.Decimal128.fromString(ourPriceRaw),
            product_mrp: mongoose.Types.Decimal128.fromString(productMrpRaw),
            store_quantity: quantity,
            max_quantity_allowed: 10,
            pcode_status: pcodeStatus
          };
        };

        const newDocs = [];
        const pushOps = [];

        for (const [pcode, rowsByStore] of missingByPcode) {
          const current = existingByPcode.get(pcode);

          if (current) {
            // Known p_code — just missing one or more stores. No sibling
            // lookup, no identity fields to resolve: they're already on
            // this document.
            const listings = [...rowsByStore.entries()]
              .map(([targetStore, row]) => buildListing(pcode, targetStore, row))
              .filter(Boolean);
            if (listings.length) {
              pushOps.push({
                updateOne: {
                  // Conditional on the push, not just on having read
                  // `current` above — a concurrent request pushing the
                  // same store between then and now would otherwise
                  // produce two stores[] entries for one store_code.
                  filter: { _id: current._id, 'stores.store_code': { $nin: listings.map((l) => l.store_code) } },
                  update: { $push: { stores: { $each: listings } } }
                },
                pcode,
                storeCodes: listings.map((l) => l.store_code)
              });
            }
            continue;
          }

          // Genuinely new to the tenant — identity has to come from the
          // row itself; the first row for this p_code supplies it, every
          // target store becomes one stores[] entry on this one new doc.
          const firstRow = rowsByStore.values().next().value;
          let packageSize;
          let packageUnit;
          if (idx.package_size !== undefined && firstRow[idx.package_size]) {
            const m = PACKAGE_SIZE_RE.exec(firstRow[idx.package_size].trim());
            if (m) { packageSize = parseFloat(m[1]); packageUnit = m[2].toUpperCase(); }
          }
          const productName = idx.product_name !== undefined ? (firstRow[idx.product_name] || '').trim() : '';
          if (packageSize === undefined || !packageUnit || !productName) {
            unresolvablePcodes.push(pcode);
            continue;
          }

          const stores = [...rowsByStore.entries()]
            .map(([targetStore, row]) => buildListing(pcode, targetStore, row))
            .filter(Boolean);
          if (stores.length === 0) continue; // every target store's price was unresolvable

          newDocs.push({
            p_code: pcode,
            barcode: (idx.BARCODE !== undefined && firstRow[idx.BARCODE]) ? firstRow[idx.BARCODE].trim() : '',
            product_name: productName,
            package_size: packageSize,
            package_unit: packageUnit,
            brand_name: (idx.BRAND_NAME !== undefined && firstRow[idx.BRAND_NAME]) ? firstRow[idx.BRAND_NAME].trim() : '',
            dept_id: UNCLASSIFIED_ID,
            category_id: UNCLASSIFIED_ID,
            sub_category_id: UNCLASSIFIED_ID,
            project_code: req.tenant.projectCode,
            stores,
            _unclassified: true
          });
        }

        // insertMany's own return value is the only trustworthy record of
        // what actually landed: with { ordered: false }, a document that
        // fails schema validation is silently dropped from the batch with
        // no thrown error — trusting the attempted list as "created" would
        // report success for documents never actually written (a real bug
        // caught earlier this session, when dept/category/sub_category_id
        // were briefly '' instead of UNCLASSIFIED_ID).
        if (dryRun) {
          // No DB round trip in a preview — validate client-side instead,
          // so a dry run's "would create" count matches what a real run
          // would actually manage, not just what was attempted.
          const validNewDocs = newDocs.filter(({ _unclassified, ...doc }) => !new ProductMasterTenant(doc).validateSync());
          created = validNewDocs.reduce((sum, d) => sum + d.stores.length, 0) + pushOps.reduce((sum, op) => sum + op.storeCodes.length, 0);
          createdDetails.push(
            ...validNewDocs.flatMap((d) => d.stores.map((s) => `${d.p_code} (${s.store_code})`)).slice(0, 50)
          );
          createdUnclassified = validNewDocs.reduce((sum, d) => sum + d.stores.length, 0);
          createdUnclassifiedDetails.push(
            ...validNewDocs.flatMap((d) => d.stores.map((s) => `${d.p_code} (${s.store_code})`)).slice(0, 50)
          );
          unresolvablePcodes.push(
            ...newDocs.filter((d) => !validNewDocs.includes(d)).map((d) => d.p_code)
          );
        } else {
          if (newDocs.length) {
            const inserted = await ProductMasterTenant.insertMany(
              newDocs.map(({ _unclassified, ...doc }) => doc),
              { ordered: false }
            );
            const insertedPcodes = new Set(inserted.map((d) => d.p_code));
            const actuallyInserted = newDocs.filter((d) => insertedPcodes.has(d.p_code));
            created += actuallyInserted.reduce((sum, d) => sum + d.stores.length, 0);
            createdDetails.push(...actuallyInserted.flatMap((d) => d.stores.map((s) => `${d.p_code} (${s.store_code})`)));
            createdUnclassified += actuallyInserted.reduce((sum, d) => sum + d.stores.length, 0);
            createdUnclassifiedDetails.push(...actuallyInserted.flatMap((d) => d.stores.map((s) => `${d.p_code} (${s.store_code})`)));
            unresolvablePcodes.push(
              ...newDocs.filter((d) => !insertedPcodes.has(d.p_code)).map((d) => d.p_code)
            );
          }
          if (pushOps.length) {
            const result = await ProductMasterTenant.bulkWrite(
              pushOps.map(({ pcode, storeCodes, ...op }) => op),
              { ordered: false }
            );
            // bulkWrite's own matchedCount is the only trustworthy signal a
            // given push actually landed (the $nin race guard above means
            // a lost race matches zero documents, not an error) — a push
            // this route attempted but didn't match is reported as
            // unresolvable, same discipline as the insertMany branch above.
            if (result.matchedCount === pushOps.length) {
              created += pushOps.reduce((sum, op) => sum + op.storeCodes.length, 0);
              createdDetails.push(...pushOps.flatMap((op) => op.storeCodes.map((s) => `${op.pcode} (${s})`)));
            } else {
              // A partial bulkWrite failure can't be attributed to one op
              // without re-querying — flag every pushed p_code so it's
              // never silently reported as created when it might not be.
              unresolvablePcodes.push(...pushOps.map((op) => op.pcode));
            }
          }
        }
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
        // Projected down to just the matching stores[] entry per doc — same
        // cheapness intent as the old .select('p_code -_id').
        const currentActive = await ProductMasterTenant.find(
          { stores: { $elemMatch: { store_code: store, pcode_status: 'Y' } } },
          { p_code: 1 }
        ).lean();
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
          // One flat updateMany can no longer reach every target doc — a
          // top-level store_code match no longer exists — so this is now a
          // bulkWrite of one arrayFilters-targeted update per p_code.
          const ops = toDeactivate.map((d) => ({
            updateOne: {
              filter: { p_code: d.p_code },
              update: { $set: { 'stores.$[elem].pcode_status': 'N' } },
              arrayFilters: [{ 'elem.store_code': store }]
            }
          }));
          await ProductMasterTenant.bulkWrite(ops, { ordered: false });
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
