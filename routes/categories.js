const express = require('express');
const router = express.Router();
const Category = require('../models/Category');
const Department = require('../models/Department');

/**
 * @route   POST /api/categories/get-categories
 * @desc    Get categories by dept_id, store_code, and project_code
 * @access  Public
 * @body    { "dept_id": "1", "store_code": "AME", "project_code": "PROJ001" }
 */
router.post('/get-categories', async (req, res, next) => {
  try {
    const { dept_id, store_code, project_code } = req.body;
    
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
    
    
    // Find categories for the specific store_code and dept_id (storefront —
    // categories hidden from the mobile app via the admin panel are excluded)
    const categories = await Category.find({
      store_code: store_code.trim(),
      dept_id: dept_id,
      is_visible: { $ne: false }
    }).sort({ sequence_id: 1 });
    
    if (!categories || categories.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: `No categories found for dept_id: ${dept_id}, store_code: ${store_code.trim()}, and project_code: ${project_code}`,
        dept_id: dept_id,
        store_code: store_code.trim(),
        project_code: project_code,
        data: []
      });
    }
    
    // Format response data
    const categoriesData = categories.map(category => ({
      id: category._id,
      idcategory_master: category.idcategory_master,
      category_name: category.category_name,
      dept_id: category.dept_id,
      sequence_id: category.sequence_id,
      store_code: category.store_code,
      no_of_col: category.no_of_col,
      image_link: category.image_link,
      category_bg_color: category.category_bg_color
    }));
    
    res.status(200).json({
      success: true,
      count: categoriesData.length,
      message: `Found ${categoriesData.length} category(ies) for dept_id: ${dept_id}, store_code: ${store_code.trim()}, and project_code: ${project_code}`,
      dept_id: dept_id,
      store_code: store_code.trim(),
      project_code: project_code,
      data: categoriesData
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/categories
 * @desc    Get all categories
 * @access  Public
 */
router.get('/', async (req, res, next) => {
  try {
    const categories = await Category.findAllSorted();
    
    if (!categories || categories.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: 'No categories found',
        data: []
      });
    }
    
    // Format response data
    const categoriesData = categories.map(category => ({
      id: category._id,
      idcategory_master: category.idcategory_master,
      category_name: category.category_name,
      dept_id: category.dept_id,
      sequence_id: category.sequence_id,
      store_code: category.store_code,
      no_of_col: category.no_of_col,
      image_link: category.image_link,
      category_bg_color: category.category_bg_color
    }));
    
    res.status(200).json({
      success: true,
      count: categoriesData.length,
      message: `Found ${categoriesData.length} category(ies)`,
      data: categoriesData
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
