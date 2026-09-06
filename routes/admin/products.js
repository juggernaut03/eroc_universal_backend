const express = require('express');
const router = express.Router();
const Product = require('../../models/Product');
const ProductMaster = require('../../models/ProductMaster');
const Subcategory = require('../../models/Subcategory');
const SubcategoryProductMap = require('../../models/SubcategoryProductMap');
const { checkPermission } = require('../../middleware/checkPermission');
const { enforceProductLimit } = require('../../middleware/subscription');

const viewPerm = checkPermission('ecommerce', 'view');
const createPerm = checkPermission('ecommerce', 'create');
const editPerm = checkPermission('ecommerce', 'edit');
const deletePerm = checkPermission('ecommerce', 'delete');

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
router.post('/by-store', viewPerm, async (req, res) => {
  try {
    const {
      store_code,
      search = '',
      page = 1,
      limit = 20,
      dept_id = '',
      category_id = '',
      sub_category_id = '',
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
    if (search && search.trim() !== '') {
      const re = { $regex: search.trim(), $options: 'i' };
      query.$or = [
        { product_name: re },
        { p_code: re },
        { barcode: re },
        { brand_name: re }
      ];
    }

    // Add optional filters
    if (dept_id) {
      query.dept_id = dept_id;
    }

    if (category_id) {
      query.category_id = category_id;
    }

    if (sub_category_id) {
      query.sub_category_id = sub_category_id;
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const products = await ProductMaster.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    // Get total count for pagination
    const total = await ProductMaster.countDocuments(query);

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

    res.status(200).json({
      success: true,
      data: productsData,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
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
router.post('/master', createPerm, enforceProductLimit(), async (req, res) => {
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

module.exports = router;
