const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const { requireProjectAccess } = require('../middleware/checkPermission');
const { attachSubscription, requireActiveSubscription } = require('../middleware/subscription');

// Import admin sub-routes
const userAdminRoutes = require('./admin/users');
const productAdminRoutes = require('./admin/products');
const orderAdminRoutes = require('./admin/orders');
const dashboardAdminRoutes = require('./admin/dashboard');
const categoryAdminRoutes = require('./admin/categories');
const contentAdminRoutes = require('./admin/content');
const contentPageAdminRoutes = require('./admin/content-pages');
const faqAdminRoutes = require('./admin/faqs');
const notificationAdminRoutes = require('./admin/notifications');
const permissionAdminRoutes = require('./admin/permissions');
const offerAdminRoutes = require('./admin/offers');
const projectSettingsAdminRoutes = require('./admin/project-settings');
const digitalCartAdminRoutes = require('./admin/digital-cart');
const onboardingAdminRoutes = require('./admin/onboarding');
const homeSectionAdminRoutes = require('./admin/home-sections');
const reportsAdminRoutes = require('./admin/reports');
const loyaltyAdminRoutes = require('./admin/loyalty');
const imageCdnAdminRoutes = require('./admin/image-cdn');

// All admin routes require authentication, admin role, and access to the
// project (tenant) the request is bound to.
//
// The subscription gate is mounted here, once, rather than on individual
// routes: when a tenant's subscription has expired its admins lose the whole
// panel API — orders, status changes, reports, content, everything — not just
// the ability to create a product. Super admins are exempt (see the
// middleware), and this covers /api/admin only, so login (/api/auth) and the
// subscription status endpoint (/api/subscriptions/status) stay reachable and
// the panel can still tell a locked-out admin why.
router.use(protect);
router.use(authorize('admin'));
router.use(requireProjectAccess);
router.use(attachSubscription);
router.use(requireActiveSubscription);

// Mount admin sub-routes
router.use('/users', userAdminRoutes);
router.use('/products', productAdminRoutes);
router.use('/orders', orderAdminRoutes);
router.use('/dashboard', dashboardAdminRoutes);
router.use('/categories', categoryAdminRoutes);
router.use('/content', contentAdminRoutes);
router.use('/content-pages', contentPageAdminRoutes);
router.use('/faqs', faqAdminRoutes);
router.use('/notifications', notificationAdminRoutes);
router.use('/permissions', permissionAdminRoutes);
router.use('/offers', offerAdminRoutes);
router.use('/project-settings', projectSettingsAdminRoutes);
router.use('/digital-cart', digitalCartAdminRoutes);
router.use('/onboarding', onboardingAdminRoutes);
router.use('/home-sections', homeSectionAdminRoutes);
router.use('/reports', reportsAdminRoutes);
router.use('/loyalty', loyaltyAdminRoutes);
router.use('/image-cdn', imageCdnAdminRoutes);

module.exports = router;
