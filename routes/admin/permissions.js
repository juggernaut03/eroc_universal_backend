const express = require('express');
const router = express.Router();
const { requireSuperAdmin } = require('../../middleware/checkPermission');
const { getTenantDb, DEFAULT_DB_NAME } = require('../../config/database');
const { getProjectModel } = require('../../models/Project');

// Admin accounts always live in the admin-home DB, regardless of which
// project (tenant) is currently selected in the panel.
const HomeUser = () => getTenantDb(DEFAULT_DB_NAME).models.User;

// All routes in this file require super admin access
router.use(requireSuperAdmin);

// Valid permission sections and actions
const VALID_SECTIONS = ['dashboard', 'users', 'orders', 'notifications', 'ecommerce', 'outlet', 'dynamicSection', 'offers', 'digitalCart', 'reports'];
const VALID_ACTIONS = ['view', 'create', 'edit', 'delete'];
const DASHBOARD_ACTIONS = ['view']; // Dashboard only supports view

const ADMIN_FIELDS = 'name email mobile role isSuperAdmin permissions allowed_project_codes createdAt';

// Validate an incoming allowed_project_codes array against the registry.
// Returns { codes } on success or { error } on failure.
const validateProjectCodes = async (codes) => {
  if (!Array.isArray(codes) || codes.some((c) => typeof c !== 'string')) {
    return { error: 'allowed_project_codes must be an array of project code strings' };
  }
  const normalized = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  const Project = getProjectModel();
  const found = await Project.find({ project_code: { $in: normalized } })
    .select('project_code -_id')
    .lean();
  const known = new Set(found.map((p) => p.project_code));
  const unknown = normalized.filter((c) => !known.has(c));
  if (unknown.length) {
    return { error: `Unknown project code(s): ${unknown.join(', ')}` };
  }
  return { codes: normalized };
};

const applyPermissions = (admin, permissions) => {
  for (const section of VALID_SECTIONS) {
    if (permissions[section]) {
      const allowedActions = section === 'dashboard' ? DASHBOARD_ACTIONS : VALID_ACTIONS;
      for (const action of allowedActions) {
        if (typeof permissions[section][action] === 'boolean') {
          admin.permissions[section][action] = permissions[section][action];
        }
      }
    }
  }
  admin.markModified('permissions');
};

// @route   GET /api/admin/permissions/admins
// @desc    List all admin users with their permissions and project access
// @access  Super Admin
router.get('/admins', async (req, res) => {
  try {
    const admins = await HomeUser().find({ role: 'admin' })
      .select(ADMIN_FIELDS)
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: admins
    });
  } catch (error) {
    console.error('Get admin users error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching admin users',
      error: error.message
    });
  }
});

// @route   GET /api/admin/permissions/admins/:id
// @desc    Get a specific admin's permissions
// @access  Super Admin
router.get('/admins/:id', async (req, res) => {
  try {
    const admin = await HomeUser().findOne({ _id: req.params.id, role: 'admin' })
      .select(ADMIN_FIELDS);

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin user not found'
      });
    }

    res.status(200).json({
      success: true,
      data: admin
    });
  } catch (error) {
    console.error('Get admin permissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching admin permissions',
      error: error.message
    });
  }
});

// @route   POST /api/admin/permissions/admins
// @desc    Create a new admin (client admin scoped to assigned projects)
// @access  Super Admin
router.post('/admins', async (req, res) => {
  try {
    const { mobile, name, email, permissions, allowed_project_codes } = req.body;

    if (!mobile || !/^\d{10}$/.test(String(mobile).trim())) {
      return res.status(400).json({
        success: false,
        message: 'A valid 10-digit mobile number is required'
      });
    }
    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        message: 'name is required'
      });
    }

    const { codes, error } = await validateProjectCodes(allowed_project_codes || []);
    if (error) {
      return res.status(400).json({ success: false, message: error });
    }
    if (!codes.length) {
      return res.status(400).json({
        success: false,
        message: 'Assign at least one project code (allowed_project_codes)'
      });
    }

    const User = HomeUser();
    const existing = await User.findOne({ mobile: String(mobile).trim() });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: existing.role === 'admin'
          ? 'An admin with this mobile number already exists'
          : 'A customer account with this mobile number exists in the admin-home DB — promote it instead'
      });
    }

    const admin = new User({
      mobile: String(mobile).trim(),
      name: String(name).trim(),
      email: email ? String(email).trim() : undefined,
      role: 'admin',
      isSuperAdmin: false,
      isVerified: true,
      allowed_project_codes: codes
    });

    if (permissions && typeof permissions === 'object') {
      applyPermissions(admin, permissions);
    }

    await admin.save();

    res.status(201).json({
      success: true,
      message: 'Admin created successfully',
      data: {
        id: admin._id,
        name: admin.name,
        mobile: admin.mobile,
        allowed_project_codes: admin.allowed_project_codes,
        permissions: admin.permissions
      }
    });
  } catch (error) {
    console.error('Create admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating admin',
      error: error.message
    });
  }
});

// @route   PUT /api/admin/permissions/admins/:id
// @desc    Update an admin's permissions and/or project access
// @access  Super Admin
router.put('/admins/:id', async (req, res) => {
  try {
    const { permissions, allowed_project_codes } = req.body;

    if (!permissions && !allowed_project_codes) {
      return res.status(400).json({
        success: false,
        message: 'Provide permissions and/or allowed_project_codes to update'
      });
    }

    // Prevent super admin from modifying their own access
    if (req.params.id === req.user._id.toString()) {
      return res.status(400).json({
        success: false,
        message: 'Cannot modify your own permissions'
      });
    }

    const admin = await HomeUser().findOne({ _id: req.params.id, role: 'admin' });

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin user not found'
      });
    }

    if (permissions && typeof permissions === 'object') {
      applyPermissions(admin, permissions);
    }

    if (allowed_project_codes !== undefined) {
      const { codes, error } = await validateProjectCodes(allowed_project_codes);
      if (error) {
        return res.status(400).json({ success: false, message: error });
      }
      admin.allowed_project_codes = codes;
    }

    await admin.save();

    res.status(200).json({
      success: true,
      message: 'Admin updated successfully',
      data: {
        id: admin._id,
        name: admin.name,
        mobile: admin.mobile,
        allowed_project_codes: admin.allowed_project_codes,
        permissions: admin.permissions
      }
    });
  } catch (error) {
    console.error('Update permissions error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating permissions',
      error: error.message
    });
  }
});

module.exports = router;
