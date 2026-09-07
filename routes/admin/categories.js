const express = require('express');
const router = express.Router();
const Category = require('../../models/Category');
const Department = require('../../models/Department');
const Subcategory = require('../../models/Subcategory');
const CategorySubcategoryMap = require('../../models/CategorySubcategoryMap');
const { checkPermission } = require('../../middleware/checkPermission');

// All routes in this file fall under the 'ecommerce' permission section
const viewPerm = checkPermission('ecommerce', 'view');
const createPerm = checkPermission('ecommerce', 'create');
const editPerm = checkPermission('ecommerce', 'edit');
const deletePerm = checkPermission('ecommerce', 'delete');

const buildDepartmentNameMap = async (deptIds = []) => {
  const uniqueIds = [...new Set(deptIds.filter(Boolean))];
  if (uniqueIds.length === 0) {
    return {};
  }

  const departments = await Department.find({ department_id: { $in: uniqueIds } })
    .select('department_id department_name');

  return departments.reduce((acc, dept) => {
    acc[dept.department_id] = dept.department_name;
    return acc;
  }, {});
};

const buildSearchRegex = (search) => ({ $regex: search.trim(), $options: 'i' });

// Batched reverse lookup for the by-store subcategory list: which additional
// categories (beyond the primary) is each subcategory cross-mapped to.
const buildAdditionalCategoryIdsMap = async (subCategoryIds = []) => {
  const uniqueIds = [...new Set(subCategoryIds.filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  const mappings = await CategorySubcategoryMap.find({
    idsub_category_master: { $in: uniqueIds }
  });

  return mappings.reduce((acc, mapping) => {
    const list = acc[mapping.idsub_category_master] || (acc[mapping.idsub_category_master] = []);
    list.push(mapping.idcategory_master);
    return acc;
  }, {});
};

// Validates `additionalCategoryIds` (every id must resolve to a real Category
// in the same store as the subcategory's own primary category — a store's
// category tree should not silently absorb another store's category id) and
// syncs CategorySubcategoryMap to exactly that set. Only called when the
// caller's request body explicitly names the field (see the `in req.body`
// guards below) — a request that doesn't mention mappings must never touch
// them, e.g. the list page's `{ is_visible }`-only partial update.
const syncAdditionalCategoryMappings = async (subcategory, additionalCategoryIds) => {
  const primaryCategory = await Category.findOne({ idcategory_master: subcategory.category_id });
  if (!primaryCategory) {
    throw Object.assign(
      new Error('Cannot manage additional category mappings: this subcategory\'s primary category_id does not match any existing category.'),
      { statusCode: 400 }
    );
  }

  const storeCode = primaryCategory.store_code;
  const uniqueIds = [...new Set((additionalCategoryIds || []).filter(Boolean))]
    .filter((id) => id !== subcategory.category_id); // mapping to your own primary is a no-op, not an error

  if (uniqueIds.length > 0) {
    const validCount = await Category.countDocuments({
      idcategory_master: { $in: uniqueIds },
      store_code: storeCode
    });
    if (validCount !== uniqueIds.length) {
      throw Object.assign(
        new Error('One or more additional category IDs are invalid for this subcategory\'s store.'),
        { statusCode: 400 }
      );
    }
  }

  await CategorySubcategoryMap.replaceForSubcategory(
    subcategory.idsub_category_master,
    storeCode,
    uniqueIds
  );
};

// ==================== CATEGORY MANAGEMENT ====================

// @route   GET /api/admin/categories
// @desc    Get all categories with pagination and filters
// @access  Admin
router.get('/', viewPerm, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      storeCode = '',
      deptId = '',
      sortBy = 'sequence_id',
      sortOrder = 'asc'
    } = req.query;

    // Build query
    const query = {};

    if (search) {
      const searchRegex = buildSearchRegex(search);
      query.$or = [
        { category_name: searchRegex },
        { idcategory_master: searchRegex },
        { dept_id: searchRegex },
      ];
    }

    if (storeCode) {
      query.store_code = storeCode;
    }

    if (deptId) {
      query.dept_id = deptId;
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const categories = await Category.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    // Get total count for pagination
    const total = await Category.countDocuments(query);

    res.status(200).json({
      success: true,
      data: categories,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching categories',
      error: error.message
    });
  }
});

// @route   POST /api/admin/categories/by-store
// @desc    Get categories by store_code with filters
// @access  Admin
router.post('/by-store', viewPerm, async (req, res) => {
  try {
    const {
      store_code,
      search = '',
      deptId = '',
      page = 1,
      limit = 20,
      sortBy = 'sequence_id',
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
    const query = {
      store_code: store_code.trim()
    };

    if (search) {
      const searchRegex = buildSearchRegex(search);
      query.$or = [
        { category_name: searchRegex },
        { idcategory_master: searchRegex },
        { dept_id: searchRegex },
      ];
    }

    if (deptId) {
      query.dept_id = deptId;
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const categories = await Category.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    const deptNameMap = await buildDepartmentNameMap(categories.map((cat) => cat.dept_id));
    const enrichedCategories = categories.map((cat) => ({
      ...cat.toObject(),
      department_name: deptNameMap[cat.dept_id] || '',
    }));

    // Get total count for pagination
    const total = await Category.countDocuments(query);

    res.status(200).json({
      success: true,
      data: enrichedCategories,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get categories by store error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching categories',
      error: error.message
    });
  }
});

// @route   GET /api/admin/categories/:id
// @desc    Get single category by ID
// @access  Admin
router.get('/:id', viewPerm, async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    res.status(200).json({
      success: true,
      data: category
    });
  } catch (error) {
    console.error('Get category error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching category',
      error: error.message
    });
  }
});

// @route   POST /api/admin/categories
// @desc    Create new category
// @access  Admin
router.post('/', createPerm, async (req, res) => {
  try {
    const category = await Category.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      data: category
    });
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating category',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/categories/:id
// @desc    Update category
// @access  Admin
router.put('/:id', editPerm, async (req, res) => {
  try {
    const category = await Category.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Category updated successfully',
      data: category
    });
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating category',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/categories/:id
// @desc    Delete category
// @access  Admin
router.delete('/:id', deletePerm, async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting category',
      error: error.message
    });
  }
});

// ==================== DEPARTMENT MANAGEMENT ====================

// @route   GET /api/admin/categories/departments/all
// @desc    Get all departments with pagination and filters
// @access  Admin
router.get('/departments/all', viewPerm, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      storeCode = '',
      deptTypeId = '',
      sortBy = 'sequence_id',
      sortOrder = 'asc'
    } = req.query;

    // Build query
    const query = {};

    if (search) {
      const searchRegex = buildSearchRegex(search);
      query.$or = [
        { department_name: searchRegex },
        { department_id: searchRegex },
        { dept_type_id: searchRegex },
      ];
    }

    if (storeCode) {
      // A department with no store_code (stored as null, or 'null' per the
      // schema's own default) applies to every store — the same convention
      // Department.findByStoreCode already implements. Most tenants seed
      // their departments this way (shared across stores; only categories
      // vary per store), so a strict equality match here was hiding every
      // department for any tenant that hadn't also given each one a real
      // store_code, e.g. RET2690 (Shree Mega Mart).
      query.store_code = { $in: [storeCode, null, 'null'] };
    }

    if (deptTypeId) {
      query.dept_type_id = deptTypeId;
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const departments = await Department.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    // Get total count for pagination
    const total = await Department.countDocuments(query);

    res.status(200).json({
      success: true,
      data: departments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get departments error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching departments',
      error: error.message
    });
  }
});

// @route   GET /api/admin/categories/departments/:id
// @desc    Get single department by ID
// @access  Admin
router.get('/departments/:id', viewPerm, async (req, res) => {
  try {
    const department = await Department.findById(req.params.id);

    if (!department) {
      return res.status(404).json({
        success: false,
        message: 'Department not found'
      });
    }

    res.status(200).json({
      success: true,
      data: department
    });
  } catch (error) {
    console.error('Get department error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching department',
      error: error.message
    });
  }
});

// @route   POST /api/admin/categories/departments
// @desc    Create new department
// @access  Admin
router.post('/departments', createPerm, async (req, res) => {
  try {
    const department = await Department.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Department created successfully',
      data: department
    });
  } catch (error) {
    console.error('Create department error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating department',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/categories/departments/:id
// @desc    Update department
// @access  Admin
router.put('/departments/:id', editPerm, async (req, res) => {
  try {
    const department = await Department.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!department) {
      return res.status(404).json({
        success: false,
        message: 'Department not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Department updated successfully',
      data: department
    });
  } catch (error) {
    console.error('Update department error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating department',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/categories/departments/:id
// @desc    Delete department
// @access  Admin
router.delete('/departments/:id', deletePerm, async (req, res) => {
  try {
    const department = await Department.findByIdAndDelete(req.params.id);

    if (!department) {
      return res.status(404).json({
        success: false,
        message: 'Department not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Department deleted successfully'
    });
  } catch (error) {
    console.error('Delete department error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting department',
      error: error.message
    });
  }
});

// @route   POST /api/admin/categories/departments/by-store
// @desc    Get departments by store_code with filters
// @access  Admin
router.post('/departments/by-store', viewPerm, async (req, res) => {
  try {
    const {
      store_code,
      search = '',
      deptTypeId = '',
      page = 1,
      limit = 20,
      sortBy = 'sequence_id',
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
    const query = {};

    // Handle store_code - can be null or specific value
    if (store_code.trim().toLowerCase() === 'null') {
      query.store_code = null;
    } else {
      query.store_code = store_code.trim();
    }

    if (search) {
      const searchRegex = buildSearchRegex(search);
      query.$or = [
        { department_name: searchRegex },
        { department_id: searchRegex },
        { dept_type_id: searchRegex },
      ];
    }

    if (deptTypeId) {
      query.dept_type_id = deptTypeId;
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const departments = await Department.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    // Get total count for pagination
    const total = await Department.countDocuments(query);

    res.status(200).json({
      success: true,
      data: departments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get departments by store error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching departments',
      error: error.message
    });
  }
});

// ==================== SUBCATEGORY MANAGEMENT ====================

// @route   GET /api/admin/categories/subcategories/all
// @desc    Get all subcategories with pagination and filters
// @access  Admin
router.get('/subcategories/all', viewPerm, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search = '',
      categoryId = '',
      sortBy = 'sequence_id',
      sortOrder = 'asc'
    } = req.query;

    // Build query
    const query = {};

    if (search) {
      query.subcategory_name = { $regex: search, $options: 'i' };
    }

    if (categoryId) {
      query.category_id = categoryId;
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const subcategories = await Subcategory.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    // Get total count for pagination
    const total = await Subcategory.countDocuments(query);

    res.status(200).json({
      success: true,
      data: subcategories,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get subcategories error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching subcategories',
      error: error.message
    });
  }
});

// @route   POST /api/admin/categories/subcategories/by-store
// @desc    Get subcategories by store_code with filters
// @access  Admin
router.post('/subcategories/by-store', viewPerm, async (req, res) => {
  try {
    const {
      store_code,
      search = '',
      categoryId = '',
      page = 1,
      limit = 20,
      sortBy = 'idsub_category_master',
      sortOrder = 'asc'
    } = req.body;

    // Validate required fields
    if (!store_code || store_code.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'store_code is required'
      });
    }

    // Build query - subcategories don't have store_code directly
    // We need to get categories for this store_code first, then get subcategories
    const categoryQuery = { store_code: store_code.trim() };
    const storeCategories = await Category.find(categoryQuery).select('idcategory_master dept_id');
    const categoryIds = storeCategories.map((cat) => cat.idcategory_master);
    const categoryDeptMap = storeCategories.reduce((acc, cat) => {
      acc[cat.idcategory_master] = cat.dept_id;
      return acc;
    }, {});

    const query = {};

    // Filter by category IDs that belong to this store
    if (categoryIds.length > 0) {
      query.category_id = { $in: categoryIds };
    } else {
      // If no categories found for this store, return empty
      return res.status(200).json({
        success: true,
        data: [],
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: 0,
          pages: 0
        }
      });
    }

    if (search) {
      const searchRegex = buildSearchRegex(search);
      query.$and = [
        { category_id: query.category_id },
        {
          $or: [
            { sub_category_name: searchRegex },
            { idsub_category_master: searchRegex },
            { main_category_name: searchRegex },
            { category_id: searchRegex },
          ],
        },
      ];
      delete query.category_id;
    }

    if (categoryId) {
      query.category_id = categoryId;
      if (query.$and) {
        query.$and[0].category_id = categoryId;
      }
    }

    // Build sort object
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Execute query with pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const subcategories = await Subcategory.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip(skip);

    const deptNameMap = await buildDepartmentNameMap(
      subcategories.map((sub) => categoryDeptMap[sub.category_id])
    );
    const additionalCategoryIdsMap = await buildAdditionalCategoryIdsMap(
      subcategories.map((sub) => sub.idsub_category_master)
    );
    const enrichedSubcategories = subcategories.map((sub) => {
      const deptId = categoryDeptMap[sub.category_id];
      return {
        ...sub.toObject(),
        department_name: deptNameMap[deptId] || '',
        additional_category_ids: additionalCategoryIdsMap[sub.idsub_category_master] || [],
      };
    });

    // Get total count for pagination
    const total = await Subcategory.countDocuments(query);

    res.status(200).json({
      success: true,
      data: enrichedSubcategories,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get subcategories by store error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching subcategories',
      error: error.message
    });
  }
});

// @route   POST /api/admin/categories/subcategories
// @desc    Create new subcategory
// @access  Admin
router.post('/subcategories', createPerm, async (req, res) => {
  try {
    const subcategory = await Subcategory.create(req.body);

    if ('additional_category_ids' in req.body) {
      await syncAdditionalCategoryMappings(subcategory, req.body.additional_category_ids);
    }

    res.status(201).json({
      success: true,
      message: 'Subcategory created successfully',
      data: subcategory
    });
  } catch (error) {
    console.error('Create subcategory error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error creating subcategory',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/categories/subcategories/:id
// @desc    Update subcategory
// @access  Admin
router.put('/subcategories/:id', editPerm, async (req, res) => {
  try {
    const subcategory = await Subcategory.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!subcategory) {
      return res.status(404).json({
        success: false,
        message: 'Subcategory not found'
      });
    }

    // Guarded by presence, not truthiness: a request that never mentions
    // mappings (e.g. the list page's `{ is_visible }`-only toggle) must never
    // touch them, while an explicit `[]` must clear them.
    if ('additional_category_ids' in req.body) {
      await syncAdditionalCategoryMappings(subcategory, req.body.additional_category_ids);
    }

    res.status(200).json({
      success: true,
      message: 'Subcategory updated successfully',
      data: subcategory
    });
  } catch (error) {
    console.error('Update subcategory error:', error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Error updating subcategory',
      error: error.message
    });
  }
});

// @route   DELETE /api/admin/categories/subcategories/:id
// @desc    Delete subcategory
// @access  Admin
router.delete('/subcategories/:id', deletePerm, async (req, res) => {
  try {
    const subcategory = await Subcategory.findByIdAndDelete(req.params.id);

    if (!subcategory) {
      return res.status(404).json({
        success: false,
        message: 'Subcategory not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Subcategory deleted successfully'
    });
  } catch (error) {
    console.error('Delete subcategory error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting subcategory',
      error: error.message
    });
  }
});

module.exports = router;
