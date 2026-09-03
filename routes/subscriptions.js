const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { requireSuperAdmin } = require('../middleware/checkPermission');
const { getProjectModel } = require('../models/Project');
const { getSubscriptionModel } = require('../models/Subscription');
const { getEffectiveSubscription, computeSubscriptionStatus, countTenantProducts } = require('../utils/subscription');
const { invalidateSubscriptionCache } = require('../middleware/subscription');

const router = express.Router();

// Mounted at /api/subscriptions — deliberately top-level, NOT under
// /api/admin, since routes/admin.js applies requireProjectAccess to its
// entire subtree, which is wrong for /admin/* here: those routes are
// cross-tenant superadmin management, not scoped to the requesting admin's
// own project.
router.use(protect);

// GET /api/subscriptions/status
// Any tenant admin — the current tenant's own subscription status, resolved
// normally via the X-Project-Code header.
router.get('/status', authorize('admin'), async (req, res) => {
  try {
    const projectCode = req.tenant?.projectCode;
    const sub = await getEffectiveSubscription(projectCode);
    const status = computeSubscriptionStatus(sub);
    const currentProductCount = await countTenantProducts();

    res.status(200).json({
      success: true,
      data: {
        ...status,
        currentProductCount,
      },
    });
  } catch (error) {
    console.error('Get subscription status error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching subscription status',
      error: error.message,
    });
  }
});

// GET /api/subscriptions/admin
// Super admin — every active project joined with its effective subscription.
// Application-level join (loop + getEffectiveSubscription), no aggregation
// pipeline — matches this repo's general style for cross-collection reads.
router.get('/admin', requireSuperAdmin, async (req, res) => {
  try {
    const Project = getProjectModel();
    const projects = await Project.find({ status: 'active' })
      .select('project_code client_name')
      .sort({ client_name: 1 })
      .lean();

    const data = await Promise.all(
      projects.map(async (project) => ({
        project_code: project.project_code,
        client_name: project.client_name,
        current: await getEffectiveSubscription(project.project_code),
      }))
    );

    res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error('List subscriptions error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching subscriptions',
      error: error.message,
    });
  }
});

// GET /api/subscriptions/admin/:projectCode/history
// Super admin — full billing history for one project, newest period first.
router.get('/admin/:projectCode/history', requireSuperAdmin, async (req, res) => {
  try {
    const projectCode = req.params.projectCode.trim().toUpperCase();
    const Subscription = getSubscriptionModel();
    const history = await Subscription.find({ project_code: projectCode }).sort({ start_date: -1 });

    res.status(200).json({
      success: true,
      data: history,
    });
  } catch (error) {
    console.error('Get subscription history error:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching subscription history',
      error: error.message,
    });
  }
});

// POST /api/subscriptions/admin/:projectCode
// Super admin — start a new billing period. Always creates a NEW document,
// never mutates a past one; this is how "renew" works (see
// models/Subscription.js / utils/subscription.js).
router.post('/admin/:projectCode', requireSuperAdmin, async (req, res) => {
  try {
    const projectCode = req.params.projectCode.trim().toUpperCase();
    const { start_date, end_date, product_limit, notes = '' } = req.body;

    if (!start_date || !end_date || product_limit === undefined || product_limit === null) {
      return res.status(400).json({
        success: false,
        message: 'start_date, end_date and product_limit are required',
      });
    }

    const Project = getProjectModel();
    const project = await Project.findOne({ project_code: projectCode });
    if (!project) {
      return res.status(404).json({
        success: false,
        message: `Unknown project code: ${projectCode}`,
      });
    }

    const startDate = new Date(start_date);
    const status = startDate <= new Date() ? 'active' : 'upcoming';

    const Subscription = getSubscriptionModel();
    const subscription = await Subscription.create({
      project_code: projectCode,
      start_date: startDate,
      end_date: new Date(end_date),
      product_limit,
      notes,
      status,
      created_by_name: req.user.name || '',
      created_by_email: req.user.email || '',
    });

    invalidateSubscriptionCache(projectCode);

    res.status(201).json({
      success: true,
      message: 'Subscription created successfully',
      data: subscription,
    });
  } catch (error) {
    console.error('Create subscription error:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating subscription',
      error: error.message,
    });
  }
});

// PUT /api/subscriptions/admin/:projectCode/:subId
// Super admin — edit a period that hasn't run its course yet.
router.put('/admin/:projectCode/:subId', requireSuperAdmin, async (req, res) => {
  try {
    const Subscription = getSubscriptionModel();
    const subscription = await Subscription.findOne({
      _id: req.params.subId,
      project_code: req.params.projectCode.trim().toUpperCase(),
    });

    if (!subscription) {
      return res.status(404).json({
        success: false,
        message: 'Subscription not found',
      });
    }

    if (!['active', 'upcoming'].includes(subscription.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot edit a subscription with status '${subscription.status}'. Only active or upcoming periods can be edited.`,
      });
    }

    const { start_date, end_date, product_limit, notes } = req.body;
    if (start_date !== undefined) subscription.start_date = new Date(start_date);
    if (end_date !== undefined) subscription.end_date = new Date(end_date);
    if (product_limit !== undefined) subscription.product_limit = product_limit;
    if (notes !== undefined) subscription.notes = notes;

    await subscription.save();
    invalidateSubscriptionCache(subscription.project_code);

    res.status(200).json({
      success: true,
      message: 'Subscription updated successfully',
      data: subscription,
    });
  } catch (error) {
    console.error('Update subscription error:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating subscription',
      error: error.message,
    });
  }
});

// POST /api/subscriptions/admin/:projectCode/:subId/cancel
// Super admin — cancel a period. Cancelled periods are excluded from
// getEffectiveSubscription, so the tenant immediately falls back to
// whichever earlier period (if any) is still in effect, or no subscription.
router.post('/admin/:projectCode/:subId/cancel', requireSuperAdmin, async (req, res) => {
  try {
    const Subscription = getSubscriptionModel();
    const subscription = await Subscription.findOne({
      _id: req.params.subId,
      project_code: req.params.projectCode.trim().toUpperCase(),
    });

    if (!subscription) {
      return res.status(404).json({
        success: false,
        message: 'Subscription not found',
      });
    }

    subscription.status = 'cancelled';
    subscription.cancelled_at = new Date();
    subscription.cancelled_by_name = req.user.name || '';
    await subscription.save();
    invalidateSubscriptionCache(subscription.project_code);

    res.status(200).json({
      success: true,
      message: 'Subscription cancelled successfully',
      data: subscription,
    });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({
      success: false,
      message: 'Error cancelling subscription',
      error: error.message,
    });
  }
});

module.exports = router;
