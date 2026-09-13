const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const BestSeller = require('../../models/BestSeller');
const TopSeller = require('../../models/TopSeller');
const Advertisement = require('../../models/Advertisement');
const PopularCategory = require('../../models/PopularCategory');
const SeasonalCategory = require('../../models/SeasonalCategory');
const PaymentMode = require('../../models/PaymentMode');
const Pincode = require('../../models/Pincode');
const Store = require('../../models/Store');
const DeliverySlot = require('../../models/DeliverySlot');
const Banner = require('../../models/Banner');
const { checkPermission } = require('../../middleware/checkPermission');

// Dynamic Section permissions (best-sellers, top-sellers, advertisements, popular-categories, seasonal-categories, banners)
const dynView = checkPermission('dynamicSection', 'view');
const dynCreate = checkPermission('dynamicSection', 'create');
const dynEdit = checkPermission('dynamicSection', 'edit');
const dynDelete = checkPermission('dynamicSection', 'delete');

// Outlet permissions (payment-modes, pincodes, stores, delivery-slots)
const outView = checkPermission('outlet', 'view');
const outCreate = checkPermission('outlet', 'create');
const outEdit = checkPermission('outlet', 'edit');
const outDelete = checkPermission('outlet', 'delete');

// Helper function to validate and sanitize MongoDB ObjectId
const validateObjectId = (id) => {
  if (!id || typeof id !== 'string') {
    return null;
  }
  
  // Remove any colon prefix if present
  const sanitized = id.startsWith(':') ? id.substring(1) : id.trim();
  
  // Validate it's a valid ObjectId format (24 hex characters)
  if (!mongoose.Types.ObjectId.isValid(sanitized)) {
    return null;
  }
  
  return sanitized;
};

// Helper function to find document by ID (handles string _id in database)
const findDocumentById = async (Model, id, modelName) => {
  // Try multiple query methods since _id might be stored as string
  let doc = await Model.findById(id);
  if (!doc) {
    doc = await Model.findOne({ _id: id });
  }
  if (!doc) {
    // Ultimate fallback: find all and match by string
    const allDocs = await Model.find({}).lean();
    const matchingDoc = allDocs.find(d => d._id && d._id.toString() === id);
    if (matchingDoc) {
      const docIdString = matchingDoc._id.toString();
      doc = await Model.findOne({ _id: docIdString });
    }
  }
  return doc;
};

// Helper function to update document by ID (handles string _id in database)
const updateDocumentById = async (Model, id, updateData, modelName) => {
  // Try to find the document first
  let existingDoc = await findDocumentById(Model, id, modelName);
  
  if (!existingDoc) {
    return null;
  }
  
  // Get the actual _id from the found document (might be string)
  const updateId = existingDoc._id.toString();
  
  // Try multiple update methods
  let updatedDoc = await Model.findOneAndUpdate(
    { _id: updateId },
    updateData,
    { new: true, runValidators: true }
  );
  
  if (!updatedDoc) {
    // Try without validators
    updatedDoc = await Model.findOneAndUpdate(
      { _id: updateId },
      updateData,
      { new: true, runValidators: false }
    );
  }
  
  if (!updatedDoc) {
    // Final fallback: use updateOne
    const updateResult = await Model.updateOne(
      { _id: updateId },
      { $set: updateData }
    );
    if (updateResult.matchedCount > 0) {
      updatedDoc = await Model.findOne({ _id: updateId });
    }
  }
  
  return updatedDoc;
};

// Helper function to delete document by ID (handles string _id in database)
const deleteDocumentById = async (Model, id, modelName) => {
  // Try to find the document first
  let existingDoc = await findDocumentById(Model, id, modelName);
  
  if (!existingDoc) {
    return null;
  }
  
  // Get the actual _id from the found document (might be string)
  const deleteId = existingDoc._id.toString();
  
  // Try multiple delete methods
  let deletedDoc = await Model.findOneAndDelete({ _id: deleteId });
  
  if (!deletedDoc) {
    // Fallback: use deleteOne
    const deleteResult = await Model.deleteOne({ _id: deleteId });
    if (deleteResult.deletedCount > 0) {
      deletedDoc = existingDoc; // Return the found doc as confirmation
    }
  }
  
  return deletedDoc;
};

const formatBannerDocument = (doc) => {
  if (!doc) {
    return doc;
  }

  const banner = doc.toObject ? doc.toObject() : { ...doc };

  const assets = Array.isArray(banner.banner_assets)
    ? banner.banner_assets.map((asset, index) => {
      const key = asset && asset.key && asset.key.toString().trim() !== ''
        ? asset.key.toString().trim()
        : `bannerUrl${index + 1}`;

      return {
        key,
        desktop: asset && asset.desktop ? asset.desktop : null,
        mobile: asset && asset.mobile ? asset.mobile : null
      };
    })
    : [];

  const bannerUrls = assets.reduce((acc, asset) => {
    acc[asset.key] = {
      desktop: asset.desktop,
      mobile: asset.mobile
    };
    return acc;
  }, {});

  const primaryAsset = assets.find(item => item.desktop || item.mobile) || {};

  return {
    ...banner,
    banner_assets: assets,
    banner_urls: bannerUrls,
    image_url: banner.image_url || primaryAsset.desktop || primaryAsset.mobile || null
  };
};

const normalizeBannerPayload = (input, { isUpdate = false } = {}) => {
  const payload = { ...input };
  const assets = [];

  const registerAsset = (desktop, mobile, key, fallbackIndex) => {
    const desktopUrl = typeof desktop === 'string' ? desktop.trim() : desktop;
    const mobileUrl = typeof mobile === 'string' ? mobile.trim() : mobile;

    if ((desktopUrl && desktopUrl !== '') || (mobileUrl && mobileUrl !== '')) {
      const resolvedKey = key && key.toString().trim() !== ''
        ? key.toString().trim()
        : `bannerUrl${fallbackIndex + 1 || assets.length + 1}`;

      assets.push({
        key: resolvedKey,
        desktop: desktopUrl && desktopUrl !== '' ? desktopUrl : undefined,
        mobile: mobileUrl && mobileUrl !== '' ? mobileUrl : undefined
      });
    }
  };

  if (Array.isArray(input.banner_assets)) {
    input.banner_assets.forEach((asset, index) => {
      if (!asset) {
        return;
      }
      registerAsset(asset.desktop, asset.mobile, asset.key, index);
    });
  }

  if (input.banner_urls && typeof input.banner_urls === 'object' && !Array.isArray(input.banner_urls)) {
    Object.entries(input.banner_urls).forEach(([key, value]) => {
      if (!value || typeof value !== 'object') {
        return;
      }
      registerAsset(value.desktop, value.mobile, key);
    });
  }

  for (let i = 1; i <= 10; i += 1) {
    const camelDesktop = input[`bannerUrl${i}Desktop`];
    const camelMobile = input[`bannerUrl${i}Mobile`];
    const snakeDesktop = input[`bannerUrl${i}_desktop`];
    const snakeMobile = input[`bannerUrl${i}_mobile`];

    const desktop = camelDesktop || snakeDesktop;
    const mobile = camelMobile || snakeMobile;

    if (desktop !== undefined || mobile !== undefined) {
      registerAsset(desktop, mobile, `bannerUrl${i}`, i - 1);
    }
  }

  delete payload.banner_assets;
  delete payload.banner_urls;

  for (let i = 1; i <= 10; i += 1) {
    delete payload[`bannerUrl${i}Desktop`];
    delete payload[`bannerUrl${i}Mobile`];
    delete payload[`bannerUrl${i}_desktop`];
    delete payload[`bannerUrl${i}_mobile`];
  }

  if (assets.length > 0) {
    const cappedAssets = assets.slice(0, 10).map((asset, index) => ({
      key: asset.key || `bannerUrl${index + 1}`,
      desktop: asset.desktop,
      mobile: asset.mobile
    }));

    payload.banner_assets = cappedAssets;

    if (!payload.image_url) {
      const primary = cappedAssets.find(item => item.desktop || item.mobile);
      if (primary) {
        payload.image_url = primary.desktop || primary.mobile || payload.image_url;
      }
    }
  } else if (Array.isArray(input.banner_assets) && input.banner_assets.length === 0) {
    payload.banner_assets = [];
  } else if (isUpdate) {
    // Do not overwrite existing assets when update does not include new data
    delete payload.banner_assets;
  }

  if (typeof payload.image_url === 'string') {
    payload.image_url = payload.image_url.trim();
    if (payload.image_url === '') {
      delete payload.image_url;
    }
  }

  return payload;
};

// ==================== BEST SELLERS MANAGEMENT ====================

// @route   GET /api/admin/content/best-sellers
// @desc    Get all best sellers
// @access  Admin
router.get('/best-sellers', dynView, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortBy = 'sequence',
      sortOrder = 'asc'
    } = req.query;

    const query = {};
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const bestSellers = await BestSeller.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    const total = await BestSeller.countDocuments(query);

    res.status(200).json({
      success: true,
      data: bestSellers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get best sellers error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching best sellers',
      error: error.message
    });
  }
});

// @route   GET /api/admin/content/best-sellers/:id
// @desc    Get single best seller by ID
// @access  Admin
router.get('/best-sellers/:id', dynView, async (req, res) => {
  try {
    const bestSeller = await BestSeller.findById(req.params.id);

    if (!bestSeller) {
      return res.status(404).json({
        success: false,
        message: 'Best seller not found'
      });
    }

    res.status(200).json({
      success: true,
      data: bestSeller
    });
  } catch (error) {
    console.error('Get best seller error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching best seller',
      error: error.message
    });
  }
});

// @route   POST /api/admin/content/best-sellers
// @desc    Create best seller
// @access  Admin
router.post('/best-sellers', dynCreate, async (req, res) => {
  try {
    const bestSeller = await BestSeller.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Best seller created successfully',
      data: bestSeller
    });
  } catch (error) {
    console.error('Create best seller error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating best seller',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/content/best-sellers/:id
// @desc    Update best seller
// @access  Admin
router.put('/best-sellers/:id', dynEdit, async (req, res) => {
  try {
    const bestSeller = await BestSeller.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!bestSeller) {
      return res.status(404).json({
        success: false,
        message: 'Best seller not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Best seller updated successfully',
      data: bestSeller
    });
  } catch (error) {
    console.error('Update best seller error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating best seller',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/content/best-sellers/:id
// @desc    Delete best seller
// @access  Admin
router.delete('/best-sellers/:id', dynDelete, async (req, res) => {
  try {
    const bestSeller = await BestSeller.findByIdAndDelete(req.params.id);

    if (!bestSeller) {
      return res.status(404).json({
        success: false,
        message: 'Best seller not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Best seller deleted successfully'
    });
  } catch (error) {
    console.error('Delete best seller error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting best seller',
      error: error.message
    });
  }
});

// ==================== TOP SELLERS MANAGEMENT ====================

// @route   GET /api/admin/content/top-sellers
// @desc    Get all top sellers
// @access  Admin
router.get('/top-sellers', dynView, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortBy = 'sequence',
      sortOrder = 'asc'
    } = req.query;

    const query = {};
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const topSellers = await TopSeller.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    const total = await TopSeller.countDocuments(query);

    res.status(200).json({
      success: true,
      data: topSellers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get top sellers error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching top sellers',
      error: error.message
    });
  }
});

// @route   GET /api/admin/content/top-sellers/:id
// @desc    Get single top seller by ID
// @access  Admin
router.get('/top-sellers/:id', dynView, async (req, res) => {
  try {
    const topSeller = await TopSeller.findById(req.params.id);

    if (!topSeller) {
      return res.status(404).json({
        success: false,
        message: 'Top seller not found'
      });
    }

    res.status(200).json({
      success: true,
      data: topSeller
    });
  } catch (error) {
    console.error('Get top seller error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching top seller',
      error: error.message
    });
  }
});

// @route   POST /api/admin/content/top-sellers
// @desc    Create top seller
// @access  Admin
router.post('/top-sellers', dynCreate, async (req, res) => {
  try {
    const topSeller = await TopSeller.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Top seller created successfully',
      data: topSeller
    });
  } catch (error) {
    console.error('Create top seller error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating top seller',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/content/top-sellers/:id
// @desc    Update top seller
// @access  Admin
router.put('/top-sellers/:id', dynEdit, async (req, res) => {
  try {
    const topSeller = await TopSeller.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!topSeller) {
      return res.status(404).json({
        success: false,
        message: 'Top seller not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Top seller updated successfully',
      data: topSeller
    });
  } catch (error) {
    console.error('Update top seller error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating top seller',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/content/top-sellers/:id
// @desc    Delete top seller
// @access  Admin
router.delete('/top-sellers/:id', dynDelete, async (req, res) => {
  try {
    const topSeller = await TopSeller.findByIdAndDelete(req.params.id);

    if (!topSeller) {
      return res.status(404).json({
        success: false,
        message: 'Top seller not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Top seller deleted successfully'
    });
  } catch (error) {
    console.error('Delete top seller error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting top seller',
      error: error.message
    });
  }
});

// ==================== ADVERTISEMENTS MANAGEMENT ====================

// @route   GET /api/admin/content/advertisements
// @desc    Get all advertisements
// @access  Admin
router.get('/advertisements', dynView, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortBy = 'sequence',
      sortOrder = 'asc'
    } = req.query;

    const query = {};
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const advertisements = await Advertisement.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    const total = await Advertisement.countDocuments(query);

    res.status(200).json({
      success: true,
      data: advertisements,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get advertisements error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching advertisements',
      error: error.message
    });
  }
});

// @route   GET /api/admin/content/advertisements/:id
// @desc    Get single advertisement by ID
// @access  Admin
router.get('/advertisements/:id', dynView, async (req, res) => {
  try {
    const advertisement = await Advertisement.findById(req.params.id);

    if (!advertisement) {
      return res.status(404).json({
        success: false,
        message: 'Advertisement not found'
      });
    }

    res.status(200).json({
      success: true,
      data: advertisement
    });
  } catch (error) {
    console.error('Get advertisement error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching advertisement',
      error: error.message
    });
  }
});

// @route   POST /api/admin/content/advertisements
// @desc    Create advertisement
// @access  Admin
router.post('/advertisements', dynCreate, async (req, res) => {
  try {
    const advertisement = await Advertisement.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Advertisement created successfully',
      data: advertisement
    });
  } catch (error) {
    console.error('Create advertisement error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating advertisement',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/content/advertisements/:id
// @desc    Update advertisement
// @access  Admin
router.put('/advertisements/:id', dynEdit, async (req, res) => {
  try {
    const advertisement = await Advertisement.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!advertisement) {
      return res.status(404).json({
        success: false,
        message: 'Advertisement not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Advertisement updated successfully',
      data: advertisement
    });
  } catch (error) {
    console.error('Update advertisement error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating advertisement',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/content/advertisements/:id
// @desc    Delete advertisement
// @access  Admin
router.delete('/advertisements/:id', dynDelete, async (req, res) => {
  try {
    const advertisement = await Advertisement.findByIdAndDelete(req.params.id);

    if (!advertisement) {
      return res.status(404).json({
        success: false,
        message: 'Advertisement not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Advertisement deleted successfully'
    });
  } catch (error) {
    console.error('Delete advertisement error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting advertisement',
      error: error.message
    });
  }
});

// ==================== POPULAR CATEGORIES MANAGEMENT ====================

// @route   GET /api/admin/content/popular-categories
// @desc    Get all popular categories
// @access  Admin
router.get('/popular-categories', dynView, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortBy = 'sequence',
      sortOrder = 'asc'
    } = req.query;

    const query = {};
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const popularCategories = await PopularCategory.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    const total = await PopularCategory.countDocuments(query);

    res.status(200).json({
      success: true,
      data: popularCategories,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get popular categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching popular categories',
      error: error.message
    });
  }
});

// @route   GET /api/admin/content/popular-categories/:id
// @desc    Get single popular category by ID
// @access  Admin
router.get('/popular-categories/:id', dynView, async (req, res) => {
  try {
    const popularCategory = await PopularCategory.findById(req.params.id);

    if (!popularCategory) {
      return res.status(404).json({
        success: false,
        message: 'Popular category not found'
      });
    }

    res.status(200).json({
      success: true,
      data: popularCategory
    });
  } catch (error) {
    console.error('Get popular category error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching popular category',
      error: error.message
    });
  }
});

// @route   POST /api/admin/content/popular-categories
// @desc    Create popular category
// @access  Admin
router.post('/popular-categories', dynCreate, async (req, res) => {
  try {
    const popularCategory = await PopularCategory.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Popular category created successfully',
      data: popularCategory
    });
  } catch (error) {
    console.error('Create popular category error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating popular category',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/content/popular-categories/:id
// @desc    Update popular category
// @access  Admin
router.put('/popular-categories/:id', dynEdit, async (req, res) => {
  try {
    const popularCategory = await PopularCategory.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!popularCategory) {
      return res.status(404).json({
        success: false,
        message: 'Popular category not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Popular category updated successfully',
      data: popularCategory
    });
  } catch (error) {
    console.error('Update popular category error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating popular category',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/content/popular-categories/:id
// @desc    Delete popular category
// @access  Admin
router.delete('/popular-categories/:id', dynDelete, async (req, res) => {
  try {
    const popularCategory = await PopularCategory.findByIdAndDelete(req.params.id);

    if (!popularCategory) {
      return res.status(404).json({
        success: false,
        message: 'Popular category not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Popular category deleted successfully'
    });
  } catch (error) {
    console.error('Delete popular category error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting popular category',
      error: error.message
    });
  }
});

// ==================== SEASONAL CATEGORIES MANAGEMENT ====================

// @route   GET /api/admin/content/seasonal-categories
// @desc    Get all seasonal categories
// @access  Admin
router.get('/seasonal-categories', dynView, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortBy = 'sequence',
      sortOrder = 'asc'
    } = req.query;

    const query = {};
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const seasonalCategories = await SeasonalCategory.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    const total = await SeasonalCategory.countDocuments(query);

    res.status(200).json({
      success: true,
      data: seasonalCategories,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get seasonal categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching seasonal categories',
      error: error.message
    });
  }
});

// @route   GET /api/admin/content/seasonal-categories/:id
// @desc    Get single seasonal category by ID
// @access  Admin
router.get('/seasonal-categories/:id', dynView, async (req, res) => {
  try {
    const seasonalCategory = await SeasonalCategory.findById(req.params.id);

    if (!seasonalCategory) {
      return res.status(404).json({
        success: false,
        message: 'Seasonal category not found'
      });
    }

    res.status(200).json({
      success: true,
      data: seasonalCategory
    });
  } catch (error) {
    console.error('Get seasonal category error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching seasonal category',
      error: error.message
    });
  }
});

// @route   POST /api/admin/content/seasonal-categories
// @desc    Create seasonal category
// @access  Admin
router.post('/seasonal-categories', dynCreate, async (req, res) => {
  try {
    const seasonalCategory = await SeasonalCategory.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Seasonal category created successfully',
      data: seasonalCategory
    });
  } catch (error) {
    console.error('Create seasonal category error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating seasonal category',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/content/seasonal-categories/:id
// @desc    Update seasonal category
// @access  Admin
router.put('/seasonal-categories/:id', dynEdit, async (req, res) => {
  try {
    const seasonalCategory = await SeasonalCategory.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!seasonalCategory) {
      return res.status(404).json({
        success: false,
        message: 'Seasonal category not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Seasonal category updated successfully',
      data: seasonalCategory
    });
  } catch (error) {
    console.error('Update seasonal category error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating seasonal category',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/content/seasonal-categories/:id
// @desc    Delete seasonal category
// @access  Admin
router.delete('/seasonal-categories/:id', dynDelete, async (req, res) => {
  try {
    const seasonalCategory = await SeasonalCategory.findByIdAndDelete(req.params.id);

    if (!seasonalCategory) {
      return res.status(404).json({
        success: false,
        message: 'Seasonal category not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Seasonal category deleted successfully'
    });
  } catch (error) {
    console.error('Delete seasonal category error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting seasonal category',
      error: error.message
    });
  }
});

// ==================== PAYMENT MODES MANAGEMENT ====================

// @route   GET /api/admin/content/payment-modes
// @desc    Get all payment modes
// @access  Admin
router.get('/payment-modes', outView, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortBy = 'sequence_id',
      sortOrder = 'asc'
    } = req.query;

    const query = {};
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const paymentModes = await PaymentMode.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    const total = await PaymentMode.countDocuments(query);

    res.status(200).json({
      success: true,
      data: paymentModes,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get payment modes error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching payment modes',
      error: error.message
    });
  }
});

// @route   POST /api/admin/content/payment-modes
// @desc    Create payment mode
// @access  Admin
router.post('/payment-modes', outCreate, async (req, res) => {
  try {
    const paymentMode = await PaymentMode.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Payment mode created successfully',
      data: paymentMode
    });
  } catch (error) {
    console.error('Create payment mode error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating payment mode',
      error: error.message
    });
  }
});

// @route   GET /api/admin/content/payment-modes/:id
// @desc    Get payment mode by ID
// @access  Admin
router.get('/payment-modes/:id', outView, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment mode ID format'
      });
    }

    const paymentMode = await findDocumentById(PaymentMode, id, 'PaymentMode');

    if (!paymentMode) {
      return res.status(404).json({
        success: false,
        message: 'Payment mode not found'
      });
    }

    res.status(200).json({
      success: true,
      data: paymentMode
    });
  } catch (error) {
    console.error('Get payment mode error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching payment mode',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/content/payment-modes/:id
// @desc    Update payment mode
// @access  Admin
router.put('/payment-modes/:id', outEdit, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment mode ID format'
      });
    }

    const paymentMode = await updateDocumentById(PaymentMode, id, req.body, 'PaymentMode');

    if (!paymentMode) {
      return res.status(404).json({
        success: false,
        message: 'Payment mode not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Payment mode updated successfully',
      data: paymentMode
    });
  } catch (error) {
    console.error('Update payment mode error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating payment mode',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/content/payment-modes/:id
// @desc    Delete payment mode
// @access  Admin
router.delete('/payment-modes/:id', outDelete, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment mode ID format'
      });
    }

    const paymentMode = await deleteDocumentById(PaymentMode, id, 'PaymentMode');

    if (!paymentMode) {
      return res.status(404).json({
        success: false,
        message: 'Payment mode not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Payment mode deleted successfully'
    });
  } catch (error) {
    console.error('Delete payment mode error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting payment mode',
      error: error.message
    });
  }
});

// ==================== PINCODES MANAGEMENT ====================

// @route   GET /api/admin/content/pincodes
// @desc    Get all pincodes
// @access  Admin
router.get('/pincodes', outView, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      storeCode = '',
      sortBy = 'pincode',
      sortOrder = 'asc'
    } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { pincode: { $regex: search, $options: 'i' } },
        { area: { $regex: search, $options: 'i' } },
        { city: { $regex: search, $options: 'i' } }
      ];
    }

    // Which pincodes a store covers — used by the Stores page.
    if (storeCode) {
      query.store_code = storeCode.trim().toUpperCase();
    }

    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const pincodes = await Pincode.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    const total = await Pincode.countDocuments(query);

    res.status(200).json({
      success: true,
      data: pincodes,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get pincodes error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching pincodes',
      error: error.message
    });
  }
});

// @route   POST /api/admin/content/pincodes
// @desc    Create pincode
// @access  Admin
router.post('/pincodes', outCreate, async (req, res) => {
  try {
    const pincode = await Pincode.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Pincode created successfully',
      data: pincode
    });
  } catch (error) {
    console.error('Create pincode error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating pincode',
      error: error.message
    });
  }
});

// @route   GET /api/admin/content/pincodes/:id
// @desc    Get pincode by ID
// @access  Admin
router.get('/pincodes/:id', outView, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid pincode ID format'
      });
    }

    const pincode = await findDocumentById(Pincode, id, 'Pincode');

    if (!pincode) {
      return res.status(404).json({
        success: false,
        message: 'Pincode not found'
      });
    }

    res.status(200).json({
      success: true,
      data: pincode
    });
  } catch (error) {
    console.error('Get pincode error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching pincode',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/content/pincodes/:id
// @desc    Update pincode
// @access  Admin
router.put('/pincodes/:id', outEdit, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid pincode ID format'
      });
    }

    const pincode = await updateDocumentById(Pincode, id, req.body, 'Pincode');

    if (!pincode) {
      return res.status(404).json({
        success: false,
        message: 'Pincode not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Pincode updated successfully',
      data: pincode
    });
  } catch (error) {
    console.error('Update pincode error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating pincode',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/content/pincodes/:id
// @desc    Delete pincode
// @access  Admin
router.delete('/pincodes/:id', outDelete, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid pincode ID format'
      });
    }

    const pincode = await deleteDocumentById(Pincode, id, 'Pincode');

    if (!pincode) {
      return res.status(404).json({
        success: false,
        message: 'Pincode not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Pincode deleted successfully'
    });
  } catch (error) {
    console.error('Delete pincode error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting pincode',
      error: error.message
    });
  }
});

// ==================== STORES MANAGEMENT ====================

// @route   GET /api/admin/content/stores/codes
// @desc    Get all unique store codes with store names
// @access  Admin
router.get('/stores/codes', outView, async (req, res) => {
  try {
    // A store-restricted admin only ever sees their own store(s) here — this
    // is what backs the admin panel's store switcher/dropdown, so a
    // restricted admin never even sees another store's code to pick from.
    const query = { is_enabled: 'Enabled' };
    if (req.user.allowed_store_codes && req.user.allowed_store_codes.length > 0) {
      query.store_code = { $in: req.user.allowed_store_codes };
    }
    const stores = await Store.find(query)
      .select('store_code mobile_outlet_name')
      .sort({ store_code: 1 });

    // Get unique store codes (use Map to deduplicate)
    const storeCodesMap = new Map();
    stores.forEach(store => {
      if (!storeCodesMap.has(store.store_code)) {
        storeCodesMap.set(store.store_code, {
          store_code: store.store_code,
          store_name: store.mobile_outlet_name
        });
      }
    });

    const storeCodes = Array.from(storeCodesMap.values());

    res.status(200).json({
      success: true,
      data: storeCodes
    });
  } catch (error) {
    console.error('Get store codes error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching store codes',
      error: error.message
    });
  }
});

// @route   GET /api/admin/content/stores
// @desc    Get all stores
// @access  Admin
router.get('/stores', outView, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      sortBy = 'store_code',
      sortOrder = 'asc'
    } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { store_code: { $regex: search, $options: 'i' } },
        { mobile_outlet_name: { $regex: search, $options: 'i' } }
      ];
    }

    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const stores = await Store.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    const total = await Store.countDocuments(query);

    res.status(200).json({
      success: true,
      data: stores,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get stores error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching stores',
      error: error.message
    });
  }
});

// @route   GET /api/admin/content/stores/:id
// @desc    Get store by ID
// @access  Admin
router.get('/stores/:id', outView, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid store ID format',
        received_id: req.params.id
      });
    }

    // Try multiple query methods to handle edge cases
    let store = null;
    
    // Debug: Log the ID we're searching for
    console.log('Searching for store with ID:', id, 'Type:', typeof id);
    
    // First try findById with string (Mongoose handles this automatically)
    store = await Store.findById(id);
    console.log('findById result:', store ? 'Found' : 'Not found');
    
    // If not found, try with explicit ObjectId conversion
    if (!store) {
      try {
        const objectId = new mongoose.Types.ObjectId(id);
        console.log('Trying with ObjectId:', objectId.toString());
        store = await Store.findById(objectId);
        console.log('findById with ObjectId result:', store ? 'Found' : 'Not found');
      } catch (e) {
        console.log('ObjectId conversion failed:', e.message);
      }
    }
    
    // If still not found, try findOne with string _id
    if (!store) {
      console.log('Trying findOne with string _id');
      store = await Store.findOne({ _id: id });
      console.log('findOne with string result:', store ? 'Found' : 'Not found');
    }
    
    // Last resort: try findOne with ObjectId
    if (!store) {
      try {
        const objectId = new mongoose.Types.ObjectId(id);
        console.log('Trying findOne with ObjectId');
        store = await Store.findOne({ _id: objectId });
        console.log('findOne with ObjectId result:', store ? 'Found' : 'Not found');
      } catch (e) {
        console.log('findOne with ObjectId failed:', e.message);
      }
    }
    
    // Final fallback: try casting the id string directly
    if (!store) {
      try {
        store = await Store.findOne({ _id: mongoose.Types.ObjectId(id) });
        console.log('Final fallback result:', store ? 'Found' : 'Not found');
      } catch (e) {
        console.log('Final fallback failed:', e.message);
      }
    }
    
    // Ultimate fallback: find all stores and match by _id string
    if (!store) {
      console.log('Trying ultimate fallback: finding all stores and matching by _id string');
      const allStores = await Store.find({}).lean();
      console.log(`Found ${allStores.length} stores total`);
      const matchingStore = allStores.find(s => {
        const storeIdStr = s._id ? s._id.toString() : '';
        const match = storeIdStr === id;
        if (match) {
          console.log('Found matching store:', storeIdStr, '===', id);
        }
        return match;
      });
      if (matchingStore) {
        // Use the actual _id from the matching store
        console.log('Matching store _id:', matchingStore._id, 'Type:', typeof matchingStore._id);
        store = await Store.findById(matchingStore._id);
        if (!store) {
          // Try with the string version
          store = await Store.findOne({ _id: matchingStore._id });
        }
        console.log('Ultimate fallback: Found store by string matching:', store ? 'Yes' : 'No');
      } else {
        console.log('Ultimate fallback: No matching store found. Sample IDs:', allStores.slice(0, 3).map(s => s._id.toString()));
      }
    }

    if (!store) {
      return res.status(404).json({
        success: false,
        message: 'Store not found',
        id: id
      });
    }

    res.status(200).json({
      success: true,
      data: store
    });
  } catch (error) {
    console.error('Get store error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching store',
      error: error.message
    });
  }
});

// @route   POST /api/admin/content/stores
// @desc    Create store
// @access  Admin
router.post('/stores', outCreate, async (req, res) => {
  try {
    const store = await Store.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Store created successfully',
      data: store
    });
  } catch (error) {
    console.error('Create store error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating store',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/content/stores/:id
// @desc    Update store
// @access  Admin
router.put('/stores/:id', outEdit, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid store ID format'
      });
    }

    // Try multiple query methods to handle edge cases
    let existingStore = null;
    
    // First try findById with string (Mongoose handles this automatically)
    existingStore = await Store.findById(id);
    
    // If not found, try with explicit ObjectId conversion
    if (!existingStore) {
      try {
        const objectId = new mongoose.Types.ObjectId(id);
        existingStore = await Store.findById(objectId);
      } catch (e) {
        // ObjectId conversion failed, skip
      }
    }
    
    // If still not found, try findOne with string _id
    if (!existingStore) {
      existingStore = await Store.findOne({ _id: id });
    }
    
    // Last resort: try findOne with ObjectId
    if (!existingStore) {
      try {
        const objectId = new mongoose.Types.ObjectId(id);
        existingStore = await Store.findOne({ _id: objectId });
      } catch (e) {
        // Skip
      }
    }
    
    // Ultimate fallback: find all stores and match by _id string
    let fallbackStoreId = null;
    let matchingStore = null; // Store for later use
    if (!existingStore) {
      console.log('PUT: Trying ultimate fallback: finding all stores and matching by _id string');
      const allStores = await Store.find({}).lean();
      console.log(`PUT: Found ${allStores.length} stores total`);
      matchingStore = allStores.find(s => {
        const storeIdStr = s._id ? s._id.toString().trim() : '';
        const searchId = id.trim();
        const match = storeIdStr === searchId || storeIdStr.toLowerCase() === searchId.toLowerCase();
        if (match) {
          console.log('PUT: Found matching store:', storeIdStr, '===', searchId);
        }
        return match;
      });
      
      // Process the matching store
      if (matchingStore) {
        // IMPORTANT: _id is stored as STRING in database, not ObjectId!
        const storeIdString = matchingStore._id.toString();
        console.log('PUT: Matching store _id string:', storeIdString);
        console.log('PUT: _id type in DB:', typeof matchingStore._id);
        
        // Store the string ID directly (not ObjectId) since that's how it's stored in DB
        fallbackStoreId = storeIdString;
        console.log('PUT: Using string _id for update:', fallbackStoreId);
        
        // Try to get the full document using string _id
        existingStore = await Store.findOne({ _id: storeIdString });
        if (!existingStore) {
          // Also try with store_code and pincode as fallback
          existingStore = await Store.findOne({ 
            store_code: matchingStore.store_code, 
            pincode: matchingStore.pincode 
          });
        }
        console.log('PUT: Ultimate fallback result:', existingStore ? 'Found document' : 'Will use string _id directly');
      } else {
        // If not found with exact match, try case-insensitive
        console.log('PUT: Exact match failed, trying case-insensitive match');
        const searchIdLower = id.trim().toLowerCase();
        matchingStore = allStores.find(s => {
          const storeIdStr = s._id ? s._id.toString().trim().toLowerCase() : '';
          return storeIdStr === searchIdLower;
        });
        if (matchingStore) {
          console.log('PUT: Found with case-insensitive match');
          const storeIdString = matchingStore._id.toString();
          // Store as string since _id is stored as string in DB
          fallbackStoreId = storeIdString;
          console.log('PUT: Using string _id from case-insensitive match:', fallbackStoreId);
          
          // Try to get the full document using string _id
          existingStore = await Store.findOne({ _id: storeIdString });
          if (!existingStore) {
            // Also try with store_code and pincode
            existingStore = await Store.findOne({ 
              store_code: matchingStore.store_code, 
              pincode: matchingStore.pincode 
            });
          }
        } else {
          console.log('PUT: No matching store found. Sample IDs:', allStores.slice(0, 3).map(s => s._id.toString()));
        }
      }
    }
    
    if (!existingStore && !fallbackStoreId) {
      return res.status(404).json({
        success: false,
        message: 'Store not found',
        id: id
      });
    }

    // Map common field aliases to actual model fields
    const updateData = { ...req.body };
    if (updateData.store_name !== undefined) {
      updateData.mobile_outlet_name = updateData.store_name;
      delete updateData.store_name;
    }
    if (updateData.is_active !== undefined) {
      updateData.is_enabled = updateData.is_active === true || updateData.is_active === 'true' || updateData.is_active === 'Enabled' 
        ? 'Enabled' 
        : 'Disabled';
      delete updateData.is_active;
    }

    // Use the same ID that worked for finding the store
    // IMPORTANT: _id is stored as STRING in database, so use string directly
    let updateId = existingStore ? existingStore._id.toString() : (fallbackStoreId || id);
    
    // Ensure updateId is a string (since _id is stored as string in DB)
    updateId = updateId ? updateId.toString() : id;
    console.log('PUT: Final updateId before update (STRING):', updateId, 'Type:', typeof updateId);
    
    // Also get store_code and pincode for alternative update method
    let updateByCode = null;
    if (existingStore) {
      updateByCode = {
        store_code: existingStore.store_code,
        pincode: existingStore.pincode
      };
    } else if (matchingStore) {
      updateByCode = {
        store_code: matchingStore.store_code,
        pincode: matchingStore.pincode
      };
    }
    console.log('PUT: Alternative update by code:', updateByCode);
    
    // Try findOneAndUpdate with string _id first (since _id is stored as string)
    let store = null;
    try {
      store = await Store.findOneAndUpdate(
        { _id: updateId },
        updateData,
        { new: true, runValidators: true }
      );
      console.log('PUT: findOneAndUpdate with string _id result:', store ? 'Success' : 'Failed');
    } catch (updateError) {
      console.log('PUT: findOneAndUpdate error:', updateError.message);
      // Try without validators
      try {
        store = await Store.findOneAndUpdate(
          { _id: updateId },
          updateData,
          { new: true, runValidators: false }
        );
      } catch (e) {
        console.log('PUT: findOneAndUpdate without validators also failed:', e.message);
      }
    }
    
    // If that fails and we have store_code/pincode, try updating by those
    if (!store && updateByCode) {
      console.log('PUT: Trying update by store_code and pincode');
      try {
        store = await Store.findOneAndUpdate(
          { store_code: updateByCode.store_code, pincode: updateByCode.pincode },
          updateData,
          { new: true, runValidators: true }
        );
        console.log('PUT: Update by code result:', store ? 'Success' : 'Failed');
      } catch (e) {
        console.log('PUT: Update by code error:', e.message);
      }
    }
    
    // Final fallback: use updateOne with string _id
    if (!store) {
      console.log('PUT: All update methods failed, trying updateOne with string _id');
      console.log('PUT: updateOne query - _id (STRING):', updateId, 'Type:', typeof updateId);
      console.log('PUT: updateOne data:', JSON.stringify(updateData));
      try {
        const updateResult = await Store.updateOne(
          { _id: updateId },
          { $set: updateData }
        );
        console.log('PUT: updateOne result - matchedCount:', updateResult.matchedCount, 'modifiedCount:', updateResult.modifiedCount);
        if (updateResult.matchedCount > 0) {
          console.log('PUT: Document was matched, fetching updated document');
          // Fetch the updated document using string _id
          store = await Store.findOne({ _id: updateId });
          console.log('PUT: Fetched document after updateOne:', store ? 'Success' : 'Failed');
        } else {
          console.log('PUT: updateOne matchedCount is 0 - trying update by store_code/pincode');
          // Try updating by store_code and pincode as final fallback
          if (updateByCode) {
            const codeUpdateResult = await Store.updateOne(
              { store_code: updateByCode.store_code, pincode: updateByCode.pincode },
              { $set: updateData }
            );
            console.log('PUT: updateOne by code result - matchedCount:', codeUpdateResult.matchedCount, 'modifiedCount:', codeUpdateResult.modifiedCount);
            if (codeUpdateResult.matchedCount > 0) {
              store = await Store.findOne({ store_code: updateByCode.store_code, pincode: updateByCode.pincode });
            }
          }
        }
      } catch (e) {
        console.error('PUT: updateOne failed with error:', e.message);
        console.error('PUT: updateOne error stack:', e.stack);
      }
    }
    
    console.log('PUT: Final update result:', store ? 'Success' : 'Failed');

    if (!store) {
      return res.status(404).json({
        success: false,
        message: 'Store not found after update',
        updateId: updateId ? updateId.toString() : 'null'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Store updated successfully',
      data: store
    });
  } catch (error) {
    console.error('Update store error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating store',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/content/stores/:id
// @desc    Delete store
// @access  Admin
router.delete('/stores/:id', outDelete, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid store ID format'
      });
    }

    const store = await Store.findByIdAndDelete(id);

    if (!store) {
      return res.status(404).json({
        success: false,
        message: 'Store not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Store deleted successfully'
    });
  } catch (error) {
    console.error('Delete store error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting store',
      error: error.message
    });
  }
});

// ==================== DELIVERY SLOTS MANAGEMENT ====================

// @route   GET /api/admin/content/delivery-slots
// @desc    Get all delivery slots
// @access  Admin
router.get('/delivery-slots', outView, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sortBy = 'sequence_id',
      sortOrder = 'asc'
    } = req.query;

    const query = {};
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const deliverySlots = await DeliverySlot.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    const total = await DeliverySlot.countDocuments(query);

    res.status(200).json({
      success: true,
      data: deliverySlots,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get delivery slots error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching delivery slots',
      error: error.message
    });
  }
});

// @route   POST /api/admin/content/delivery-slots
// @desc    Create delivery slot
// @access  Admin
router.post('/delivery-slots', outCreate, async (req, res) => {
  try {
    const deliverySlot = await DeliverySlot.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Delivery slot created successfully',
      data: deliverySlot
    });
  } catch (error) {
    console.error('Create delivery slot error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating delivery slot',
      error: error.message
    });
  }
});

// @route   GET /api/admin/content/delivery-slots/:id
// @desc    Get delivery slot by ID
// @access  Admin
router.get('/delivery-slots/:id', outView, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid delivery slot ID format'
      });
    }

    const deliverySlot = await findDocumentById(DeliverySlot, id, 'DeliverySlot');

    if (!deliverySlot) {
      return res.status(404).json({
        success: false,
        message: 'Delivery slot not found'
      });
    }

    res.status(200).json({
      success: true,
      data: deliverySlot
    });
  } catch (error) {
    console.error('Get delivery slot error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching delivery slot',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/content/delivery-slots/:id
// @desc    Update delivery slot
// @access  Admin
router.put('/delivery-slots/:id', outEdit, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid delivery slot ID format'
      });
    }

    const deliverySlot = await updateDocumentById(DeliverySlot, id, req.body, 'DeliverySlot');

    if (!deliverySlot) {
      return res.status(404).json({
        success: false,
        message: 'Delivery slot not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Delivery slot updated successfully',
      data: deliverySlot
    });
  } catch (error) {
    console.error('Update delivery slot error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating delivery slot',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/content/delivery-slots/:id
// @desc    Delete delivery slot
// @access  Admin
router.delete('/delivery-slots/:id', outDelete, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid delivery slot ID format'
      });
    }

    const deliverySlot = await deleteDocumentById(DeliverySlot, id, 'DeliverySlot');

    if (!deliverySlot) {
      return res.status(404).json({
        success: false,
        message: 'Delivery slot not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Delivery slot deleted successfully'
    });
  } catch (error) {
    console.error('Delete delivery slot error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting delivery slot',
      error: error.message
    });
  }
});

// ==================== BANNERS MANAGEMENT ====================

// @route   GET /api/admin/content/banners
// @desc    Get all banners
// @access  Admin
router.get('/banners', dynView, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      section_name = '',
      sortBy = 'sequence',
      sortOrder = 'asc'
    } = req.query;

    const query = {};

    if (section_name) {
      query.section_name = section_name;
    }

    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const banners = await Banner.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    const total = await Banner.countDocuments(query);

    const formattedBanners = banners.map(formatBannerDocument);

    res.status(200).json({
      success: true,
      data: formattedBanners,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get banners error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching banners',
      error: error.message
    });
  }
});

// @route   GET /api/admin/content/banners/:id
// @desc    Get single banner by ID
// @access  Admin
router.get('/banners/:id', dynView, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid banner ID format'
      });
    }

    const banner = await findDocumentById(Banner, id, 'Banner');

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: 'Banner not found'
      });
    }

    res.status(200).json({
      success: true,
      data: formatBannerDocument(banner)
    });
  } catch (error) {
    console.error('Get banner error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching banner',
      error: error.message
    });
  }
});

// @route   POST /api/admin/content/banners
// @desc    Create banner
// @access  Admin
router.post('/banners', dynCreate, async (req, res) => {
  try {
    const payload = normalizeBannerPayload(req.body);
    const banner = await Banner.create(payload);

    res.status(201).json({
      success: true,
      message: 'Banner created successfully',
      data: formatBannerDocument(banner)
    });
  } catch (error) {
    console.error('Create banner error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating banner',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/content/banners/:id
// @desc    Update banner
// @access  Admin
router.put('/banners/:id', dynEdit, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid banner ID format'
      });
    }

    const payload = normalizeBannerPayload(req.body, { isUpdate: true });
    const banner = await updateDocumentById(Banner, id, payload, 'Banner');

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: 'Banner not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Banner updated successfully',
      data: formatBannerDocument(banner)
    });
  } catch (error) {
    console.error('Update banner error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating banner',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/content/banners/:id
// @desc    Delete banner
// @access  Admin
router.delete('/banners/:id', dynDelete, async (req, res) => {
  try {
    const id = validateObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid banner ID format'
      });
    }

    const banner = await deleteDocumentById(Banner, id, 'Banner');

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: 'Banner not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Banner deleted successfully'
    });
  } catch (error) {
    console.error('Delete banner error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting banner',
      error: error.message
    });
  }
});

module.exports = router;
