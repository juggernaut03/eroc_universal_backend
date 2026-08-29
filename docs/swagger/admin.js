/**
 * COMPREHENSIVE SWAGGER DOCUMENTATION FOR ADMIN ENDPOINTS
 * All admin endpoints require authentication and admin role
 */

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     tags:
 *       - Admin - Users
 *     summary: Get all users with pagination and filters
 *     description: Retrieves all users with search, filtering, sorting, and pagination support
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Items per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by mobile, name, or email
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [user, admin]
 *         description: Filter by role
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           default: createdAt
 *         description: Field to sort by
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Users retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/User'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     total:
 *                       type: integer
 *                     pages:
 *                       type: integer
 *
 * @swagger
 * /api/admin/users/{id}:
 *   get:
 *     tags:
 *       - Admin - Users
 *     summary: Get user by ID with detailed information
 *     description: Retrieves detailed user information including order statistics
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     responses:
 *       200:
 *         description: User details retrieved
 *       404:
 *         description: User not found
 *
 *   put:
 *     tags:
 *       - Admin - Users
 *     summary: Update user details
 *     description: Updates user information
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *               mobile:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [user, admin]
 *               isVerified:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: User updated successfully
 *       404:
 *         description: User not found
 *
 *   delete:
 *     tags:
 *       - Admin - Users
 *     summary: Delete user (super admin only)
 *     description: >
 *       Permanently deletes a user. Restricted to super admins - the
 *       `users.delete` permission does not grant it. Refused if the user has
 *       active orders, is a super admin, or is the caller's own account.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User deleted successfully
 *       400:
 *         description: Cannot delete user with active orders, or own account
 *       403:
 *         description: Super admin access required, or target is a super admin
 *       404:
 *         description: User not found
 *
 * @swagger
 * /api/admin/users/{id}/block:
 *   patch:
 *     tags:
 *       - Admin - Users
 *     summary: Block user (super admin only)
 *     description: >
 *       Blocks a user: every live session is revoked, sign-in is refused and
 *       any access token already issued stops working on its next request.
 *       All of the user's data is retained. Super admins only.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Optional note stored as blockedReason
 *     responses:
 *       200:
 *         description: User blocked successfully
 *       400:
 *         description: User already blocked, or own account
 *       403:
 *         description: Super admin access required, or target is a super admin
 *       404:
 *         description: User not found
 *
 * @swagger
 * /api/admin/users/{id}/unblock:
 *   patch:
 *     tags:
 *       - Admin - Users
 *     summary: Unblock user (super admin only)
 *     description: Lifts a block so the user can sign in again. Super admins only.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User unblocked successfully
 *       400:
 *         description: User is not blocked
 *       403:
 *         description: Super admin access required
 *       404:
 *         description: User not found
 *
 * @swagger
 * /api/admin/users/{id}/role:
 *   patch:
 *     tags:
 *       - Admin - Users
 *     summary: Change user role
 *     description: Updates user role to admin or user
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - role
 *             properties:
 *               role:
 *                 type: string
 *                 enum: [user, admin]
 *     responses:
 *       200:
 *         description: User role changed successfully
 *
 * @swagger
 * /api/admin/users/stats/overview:
 *   get:
 *     tags:
 *       - Admin - Users
 *     summary: Get user statistics overview
 *     description: Retrieves aggregate user statistics
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User statistics retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalUsers:
 *                       type: integer
 *                     verifiedUsers:
 *                       type: integer
 *                     adminUsers:
 *                       type: integer
 *                     activeUsers24h:
 *                       type: integer
 *                     newUsersLast7Days:
 *                       type: integer
 *
 * @swagger
 * /api/admin/products:
 *   get:
 *     tags:
 *       - Admin - Products
 *     summary: Get all products with pagination
 *     description: Retrieves all products with search, filtering, and pagination
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: store_code
 *         schema:
 *           type: string
 *       - in: query
 *         name: pcode_status
 *         schema:
 *           type: string
 *           enum: [Y, N]
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           default: product_name
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: asc
 *     responses:
 *       200:
 *         description: Products retrieved successfully
 *
 *   post:
 *     tags:
 *       - Admin - Products
 *     summary: Create new product
 *     description: Creates a new product
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Product'
 *     responses:
 *       201:
 *         description: Product created successfully
 *
 * @swagger
 * /api/admin/products/by-store:
 *   post:
 *     tags:
 *       - Admin - Products
 *     summary: Get products by store
 *     description: Retrieves products filtered by store code with pagination
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - store_code
 *             properties:
 *               store_code:
 *                 type: string
 *               page:
 *                 type: integer
 *                 default: 1
 *               limit:
 *                 type: integer
 *                 default: 20
 *     responses:
 *       200:
 *         description: Products retrieved successfully
 *
 * @swagger
 * /api/admin/products/{id}:
 *   get:
 *     tags:
 *       - Admin - Products
 *     summary: Get product by ID
 *     description: Retrieves detailed product information
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Product details retrieved
 *       404:
 *         description: Product not found
 *
 *   put:
 *     tags:
 *       - Admin - Products
 *     summary: Update product
 *     description: Updates product information
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Product'
 *     responses:
 *       200:
 *         description: Product updated successfully
 *
 *   delete:
 *     tags:
 *       - Admin - Products
 *     summary: Delete product
 *     description: Deletes a product
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Product deleted successfully
 *       404:
 *         description: Product not found
 *
 * @swagger
 * /api/admin/products/{id}/stock:
 *   patch:
 *     tags:
 *       - Admin - Products
 *     summary: Update product stock
 *     description: Updates product stock quantity
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - store_quantity
 *             properties:
 *               store_quantity:
 *                 type: number
 *               max_quantity_allowed:
 *                 type: number
 *     responses:
 *       200:
 *         description: Stock updated successfully
 *
 * @swagger
 * /api/admin/products/{id}/status:
 *   patch:
 *     tags:
 *       - Admin - Products
 *     summary: Update product status
 *     description: Activates or deactivates a product
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - pcode_status
 *             properties:
 *               pcode_status:
 *                 type: string
 *                 enum: [Y, N]
 *     responses:
 *       200:
 *         description: Product status updated
 *
 * @swagger
 * /api/admin/products/{id}/price:
 *   patch:
 *     tags:
 *       - Admin - Products
 *     summary: Update product price
 *     description: Updates product pricing
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               product_mrp:
 *                 type: number
 *               our_price:
 *                 type: number
 *     responses:
 *       200:
 *         description: Price updated successfully
 *
 * @swagger
 * /api/admin/products/stats/overview:
 *   get:
 *     tags:
 *       - Admin - Products
 *     summary: Get product statistics
 *     description: Retrieves aggregate product statistics
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Product statistics retrieved
 *
 * @swagger
 * /api/admin/products/bulk-update-status:
 *   post:
 *     tags:
 *       - Admin - Products
 *     summary: Bulk update product status
 *     description: Updates status for multiple products at once
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - product_ids
 *               - pcode_status
 *             properties:
 *               product_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *               pcode_status:
 *                 type: string
 *                 enum: [Y, N]
 *     responses:
 *       200:
 *         description: Products updated successfully
 *
 * @swagger
 * /api/admin/orders:
 *   get:
 *     tags:
 *       - Admin - Orders
 *     summary: Get all orders with pagination
 *     description: Retrieves all orders with search, filtering, and pagination
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by order number or mobile
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by order status
 *       - in: query
 *         name: payment_status
 *         schema:
 *           type: string
 *         description: Filter by payment status
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           default: order_placed_at
 *       - in: query
 *         name: sortOrder
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *     responses:
 *       200:
 *         description: Orders retrieved successfully
 *
 * @swagger
 * /api/admin/orders/{id}:
 *   get:
 *     tags:
 *       - Admin - Orders
 *     summary: Get order by ID
 *     description: Retrieves detailed order information
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Order details retrieved
 *       404:
 *         description: Order not found
 *
 * @swagger
 * /api/admin/orders/{id}/status:
 *   patch:
 *     tags:
 *       - Admin - Orders
 *     summary: Update order status
 *     description: Updates order status and timestamps
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - order_status
 *             properties:
 *               order_status:
 *                 type: string
 *                 enum: [pending, confirmed, processing, shipped, delivered, cancelled]
 *     responses:
 *       200:
 *         description: Order status updated
 *
 * @swagger
 * /api/admin/orders/{id}/payment:
 *   patch:
 *     tags:
 *       - Admin - Orders
 *     summary: Update payment status
 *     description: Updates order payment status
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - payment_status
 *             properties:
 *               payment_status:
 *                 type: string
 *                 enum: [pending, completed, failed, refunded]
 *     responses:
 *       200:
 *         description: Payment status updated
 *
 * @swagger
 * /api/admin/orders/stats/overview:
 *   get:
 *     tags:
 *       - Admin - Orders
 *     summary: Get order statistics
 *     description: Retrieves aggregate order statistics
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Order statistics retrieved
 *
 * @swagger
 * /api/admin/dashboard/overview:
 *   get:
 *     tags:
 *       - Admin - Dashboard
 *     summary: Get dashboard overview
 *     description: Retrieves key metrics and statistics for admin dashboard
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard data retrieved successfully
 *
 * @swagger
 * /api/admin/dashboard/sales-trend:
 *   get:
 *     tags:
 *       - Admin - Dashboard
 *     summary: Get sales trend data
 *     description: Retrieves sales trend data for analytics
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [daily, weekly, monthly]
 *           default: daily
 *     responses:
 *       200:
 *         description: Sales trend data retrieved
 *
 * @swagger
 * /api/admin/dashboard/top-products:
 *   get:
 *     tags:
 *       - Admin - Dashboard
 *     summary: Get top selling products
 *     description: Retrieves list of top selling products
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Top products retrieved
 *
 * @swagger
 * /api/admin/dashboard/top-categories:
 *   get:
 *     tags:
 *       - Admin - Dashboard
 *     summary: Get top categories
 *     description: Retrieves top performing categories
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Top categories retrieved
 *
 * @swagger
 * /api/admin/dashboard/recent-orders:
 *   get:
 *     tags:
 *       - Admin - Dashboard
 *     summary: Get recent orders
 *     description: Retrieves list of recent orders
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Recent orders retrieved
 *
 * @swagger
 * /api/admin/dashboard/order-status-distribution:
 *   get:
 *     tags:
 *       - Admin - Dashboard
 *     summary: Get order status distribution
 *     description: Retrieves distribution of orders by status
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Order status distribution retrieved
 *
 * @swagger
 * /api/admin/dashboard/payment-status-distribution:
 *   get:
 *     tags:
 *       - Admin - Dashboard
 *     summary: Get payment status distribution
 *     description: Retrieves distribution of orders by payment status
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Payment status distribution retrieved
 *
 * @swagger
 * /api/admin/dashboard/user-activity:
 *   get:
 *     tags:
 *       - Admin - Dashboard
 *     summary: Get user activity data
 *     description: Retrieves user activity and engagement metrics
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User activity data retrieved
 *
 * @swagger
 * /api/admin/categories:
 *   get:
 *     tags:
 *       - Admin - Categories
 *     summary: Get all categories
 *     description: Retrieves all categories with pagination
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Categories retrieved successfully
 *
 *   post:
 *     tags:
 *       - Admin - Categories
 *     summary: Create new category
 *     description: Creates a new category
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Category'
 *     responses:
 *       201:
 *         description: Category created successfully
 *
 * @swagger
 * /api/admin/categories/{id}:
 *   get:
 *     tags:
 *       - Admin - Categories
 *     summary: Get category by ID
 *     description: Retrieves detailed category information
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Category details retrieved
 *
 *   put:
 *     tags:
 *       - Admin - Categories
 *     summary: Update category
 *     description: Updates category information
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Category'
 *     responses:
 *       200:
 *         description: Category updated successfully
 *
 *   delete:
 *     tags:
 *       - Admin - Categories
 *     summary: Delete category
 *     description: Deletes a category
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Category deleted successfully
 *
 * @swagger
 * /api/admin/content/best-sellers:
 *   get:
 *     tags:
 *       - Admin - Content
 *     summary: Get all best seller entries
 *     description: Retrieves all best seller product configurations
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Best sellers retrieved successfully
 *
 *   post:
 *     tags:
 *       - Admin - Content
 *     summary: Create best seller entry
 *     description: Adds a product to best sellers
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - product_id
 *               - store_code
 *             properties:
 *               product_id:
 *                 type: string
 *               store_code:
 *                 type: string
 *               sequence_id:
 *                 type: number
 *     responses:
 *       201:
 *         description: Best seller created successfully
 *
 * @swagger
 * /api/admin/content/best-sellers/{id}:
 *   get:
 *     tags:
 *       - Admin - Content
 *     summary: Get best seller by ID
 *     description: Retrieves a specific best seller entry
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Best seller details retrieved
 *
 *   put:
 *     tags:
 *       - Admin - Content
 *     summary: Update best seller entry
 *     description: Updates best seller configuration
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Best seller updated successfully
 *
 *   delete:
 *     tags:
 *       - Admin - Content
 *     summary: Delete best seller entry
 *     description: Removes a product from best sellers
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Best seller deleted successfully
 *
 * @swagger
 * /api/admin/content/advertisements:
 *   get:
 *     tags:
 *       - Admin - Content
 *     summary: Get all advertisements
 *     description: Retrieves all advertisement banners
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Advertisements retrieved successfully
 *
 *   post:
 *     tags:
 *       - Admin - Content
 *     summary: Create advertisement
 *     description: Creates a new advertisement banner
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - image_url
 *             properties:
 *               title:
 *                 type: string
 *               image_url:
 *                 type: string
 *               link:
 *                 type: string
 *               is_active:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Advertisement created successfully
 *
 * @swagger
 * /api/admin/notifications/send-to-user:
 *   post:
 *     tags:
 *       - Admin - Notifications
 *     summary: Send notification to specific user
 *     description: Sends a push notification to a specific user
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - title
 *               - message
 *             properties:
 *               userId:
 *                 type: string
 *               title:
 *                 type: string
 *               message:
 *                 type: string
 *               data:
 *                 type: object
 *     responses:
 *       200:
 *         description: Notification sent successfully
 *
 * @swagger
 * /api/admin/notifications/send-to-all:
 *   post:
 *     tags:
 *       - Admin - Notifications
 *     summary: Send notification to all users
 *     description: Broadcasts a push notification to all users
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - message
 *             properties:
 *               title:
 *                 type: string
 *               message:
 *                 type: string
 *               data:
 *                 type: object
 *     responses:
 *       200:
 *         description: Notifications sent successfully
 *
 * @swagger
 * /api/admin/notifications/users:
 *   get:
 *     tags:
 *       - Admin - Notifications
 *     summary: Get users with FCM tokens
 *     description: Retrieves list of users who can receive push notifications
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Users retrieved successfully
 */
