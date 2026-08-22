const express = require('express');
const router = express.Router();
const Subcategory = require('../models/Subcategory');
const Category = require('../models/Category');
const Department = require('../models/Department');
const CategorySubcategoryMap = require('../models/CategorySubcategoryMap');
const { resolveSubcategoryIdsForCategories } = require('../utils/catalogueResolution');

/**
 * @route   POST /api/subcategories/get-subcategories
 * @desc    Get subcategories by dept_id, store_code, project_code, and idcategory_master
 * @access  Public
 * @body    { "dept_id": "1", "store_code": "AME", "project_code": "PROJ001", "idcategory_master": "2" }
 */
router.post('/get-subcategories', async (req, res, next) => {
  try {
    const { dept_id, store_code, project_code, idcategory_master } = req.body;
    
    // Validate required fields
    if (!dept_id) {
      return res.status(400).json({
        success: false,
        error: 'dept_id is required'
      });
    }
    
    if (!store_code || store_code.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'store_code is required'
      });
    }
    
    
    if (!idcategory_master) {
      return res.status(400).json({
        success: false,
        error: 'idcategory_master is required'
      });
    }
    
    // Find categories for the specific store_code, dept_id, and idcategory_master
    // (storefront — a hidden category has no visible subcategories under it)
    const categories = await Category.find({
      store_code: store_code.trim(),
      dept_id: dept_id,
      idcategory_master: idcategory_master,
      is_visible: { $ne: false }
    });
    
    if (!categories || categories.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: `No categories found for dept_id: ${dept_id}, store_code: ${store_code.trim()}, project_code: ${project_code}, and idcategory_master: ${idcategory_master}`,
        dept_id: dept_id,
        store_code: store_code.trim(),
        project_code: project_code,
        idcategory_master: idcategory_master,
        data: []
      });
    }
    
    // Extract category IDs from the found categories
    const categoryIds = categories.map(category => category.idcategory_master);

    // Subcategories under these categories: primary parent match, PLUS any
    // subcategory cross-mapped to one of these categories via
    // CategorySubcategoryMap even though its primary parent is elsewhere
    // (storefront — hidden subcategories are excluded either way).
    const subcategoryIds = await resolveSubcategoryIdsForCategories(categoryIds, store_code.trim());

    if (subcategoryIds.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: `No subcategories found for dept_id: ${dept_id}, store_code: ${store_code.trim()}, project_code: ${project_code}, and idcategory_master: ${idcategory_master}`,
        dept_id: dept_id,
        store_code: store_code.trim(),
        project_code: project_code,
        idcategory_master: idcategory_master,
        data: []
      });
    }

    const subcategories = await Subcategory.find({
      idsub_category_master: { $in: subcategoryIds },
      is_visible: { $ne: false }
    }).sort({ idsub_category_master: 1 });

    if (!subcategories || subcategories.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: `No subcategories found for dept_id: ${dept_id}, store_code: ${store_code.trim()}, project_code: ${project_code}, and idcategory_master: ${idcategory_master}`,
        dept_id: dept_id,
        store_code: store_code.trim(),
        project_code: project_code,
        idcategory_master: idcategory_master,
        data: []
      });
    }

    // Format response data. mapping_type is additive/informational — 'primary'
    // when this subcategory's own category_id is one of the requested
    // categories, 'additional' when it's only reachable via the cross-mapping.
    const subcategoriesData = subcategories.map(subcategory => ({
      id: subcategory._id,
      idsub_category_master: subcategory.idsub_category_master,
      sub_category_name: subcategory.sub_category_name,
      category_id: subcategory.category_id,
      main_category_name: subcategory.main_category_name,
      mapping_type: categoryIds.includes(subcategory.category_id) ? 'primary' : 'additional'
    }));
    
    res.status(200).json({
      success: true,
      count: subcategoriesData.length,
      message: `Found ${subcategoriesData.length} subcategory(ies) for dept_id: ${dept_id}, store_code: ${store_code.trim()}, project_code: ${project_code}, and idcategory_master: ${idcategory_master}`,
      dept_id: dept_id,
      store_code: store_code.trim(),
      project_code: project_code,
      idcategory_master: idcategory_master,
      data: subcategoriesData
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/subcategories
 * @desc    Get all subcategories
 * @access  Public
 */
router.get('/', async (req, res, next) => {
  try {
    const subcategories = await Subcategory.findAllSorted();
    
    if (!subcategories || subcategories.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: 'No subcategories found',
        data: []
      });
    }
    
    // Every additional category each subcategory is cross-mapped to, batched
    // in one query — folded into category_ids below so the mobile app's
    // tenant-wide fallback filter (which has no per-store scope to resolve a
    // targeted lookup through) can match on array membership, not just the
    // bare primary category_id.
    const allSubcategoryIds = subcategories.map(subcategory => subcategory.idsub_category_master);
    const mappings = await CategorySubcategoryMap.find({
      idsub_category_master: { $in: allSubcategoryIds }
    });
    const extraCategoryIdsBySubcategory = mappings.reduce((acc, mapping) => {
      const list = acc[mapping.idsub_category_master] || (acc[mapping.idsub_category_master] = []);
      list.push(mapping.idcategory_master);
      return acc;
    }, {});

    // Format response data
    const subcategoriesData = subcategories.map(subcategory => ({
      id: subcategory._id,
      idsub_category_master: subcategory.idsub_category_master,
      sub_category_name: subcategory.sub_category_name,
      category_id: subcategory.category_id,
      main_category_name: subcategory.main_category_name,
      category_ids: [
        subcategory.category_id,
        ...(extraCategoryIdsBySubcategory[subcategory.idsub_category_master] || [])
      ]
    }));

    res.status(200).json({
      success: true,
      count: subcategoriesData.length,
      message: `Found ${subcategoriesData.length} subcategory(ies)`,
      data: subcategoriesData
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
