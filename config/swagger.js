const swaggerJsdoc = require('swagger-jsdoc');

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Ecommerce Backend API Documentation',
            version: '1.0.0',
            description: 'Complete API documentation for E-commerce platform including authentication, products, cart, orders, and admin endpoints',
            contact: {
                name: 'Gaurav Pawar',
                email: 'support@patelecommerce.com'
            },
            license: {
                name: 'ISC',
                url: 'https://opensource.org/licenses/ISC'
            }
        },
        servers: [
            {
                url: 'http://localhost:5001',
                description: 'Development server'
            }
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                    description: 'Enter JWT token obtained from login/verify-otp endpoint'
                }
            },
            schemas: {
                Error: {
                    type: 'object',
                    properties: {
                        success: {
                            type: 'boolean',
                            example: false
                        },
                        error: {
                            type: 'string',
                            example: 'Error message'
                        }
                    }
                },
                User: {
                    type: 'object',
                    properties: {
                        _id: {
                            type: 'string',
                            example: '507f1f77bcf86cd799439011'
                        },
                        mobile: {
                            type: 'string',
                            example: '9876543210'
                        },
                        name: {
                            type: 'string',
                            example: 'John Doe'
                        },
                        email: {
                            type: 'string',
                            example: 'john@example.com'
                        },
                        role: {
                            type: 'string',
                            enum: ['user', 'admin'],
                            example: 'user'
                        },
                        isActive: {
                            type: 'boolean',
                            example: true
                        }
                    }
                },
                Product: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            example: '507f1f77bcf86cd799439011'
                        },
                        p_code: {
                            type: 'string',
                            example: '2390'
                        },
                        barcode: {
                            type: 'string',
                            example: '1234567890'
                        },
                        product_name: {
                            type: 'string',
                            example: 'SABUDANA 250 (N.W.)'
                        },
                        product_description: {
                            type: 'string',
                            example: 'Premium quality sabudana'
                        },
                        package_size: {
                            type: 'number',
                            example: 250
                        },
                        package_unit: {
                            type: 'string',
                            example: 'GM'
                        },
                        product_mrp: {
                            type: 'number',
                            example: 20
                        },
                        our_price: {
                            type: 'number',
                            example: 18
                        },
                        brand_name: {
                            type: 'string',
                            example: 'INDIAN CHASKA'
                        },
                        store_code: {
                            type: 'string',
                            example: 'AVB'
                        },
                        pcode_status: {
                            type: 'string',
                            example: 'Y'
                        },
                        dept_id: {
                            type: 'string',
                            example: '2'
                        },
                        category_id: {
                            type: 'string',
                            example: '89'
                        },
                        sub_category_id: {
                            type: 'string',
                            example: '349'
                        },
                        store_quantity: {
                            type: 'number',
                            example: 100
                        },
                        max_quantity_allowed: {
                            type: 'number',
                            example: 10
                        },
                        pcode_img: {
                            type: 'string',
                            example: 'https://example.com/image.jpg'
                        }
                    }
                },
                CartItem: {
                    type: 'object',
                    properties: {
                        p_code: {
                            type: 'string',
                            example: '2390'
                        },
                        product_name: {
                            type: 'string',
                            example: 'SABUDANA 250 (N.W.)'
                        },
                        quantity: {
                            type: 'number',
                            example: 2
                        },
                        unit_price: {
                            type: 'number',
                            example: 18
                        },
                        total_price: {
                            type: 'number',
                            example: 36
                        },
                        package_size: {
                            type: 'number',
                            example: 250
                        },
                        package_unit: {
                            type: 'string',
                            example: 'GM'
                        },
                        brand_name: {
                            type: 'string',
                            example: 'INDIAN CHASKA'
                        },
                        pcode_img: {
                            type: 'string',
                            example: 'https://example.com/image.jpg'
                        },
                        store_code: {
                            type: 'string',
                            example: 'AVB'
                        }
                    },
                    required: ['p_code', 'product_name', 'quantity', 'unit_price']
                },
                Order: {
                    type: 'object',
                    properties: {
                        order_number: {
                            type: 'string',
                            example: 'ORD-2024-00001'
                        },
                        order_status: {
                            type: 'string',
                            enum: ['pending', 'accepted', 'accepted_by_store', 'in_packaging', 'out_for_delivery', 'delivered', 'cancelled'],
                            example: 'pending'
                        },
                        order_placed_at: {
                            type: 'string',
                            format: 'date-time',
                            example: '2024-01-15T10:30:00Z'
                        },
                        estimated_delivery_date: {
                            type: 'string',
                            format: 'date',
                            example: '2024-01-20'
                        },
                        delivery_slot: {
                            type: 'string',
                            example: '10:00 AM - 12:00 PM'
                        },
                        payment_mode: {
                            type: 'string',
                            example: 'Cash on Delivery'
                        },
                        order_summary: {
                            type: 'object',
                            properties: {
                                subtotal: {
                                    type: 'number',
                                    example: 500
                                },
                                delivery_charges: {
                                    type: 'number',
                                    example: 0
                                },
                                tax_amount: {
                                    type: 'number',
                                    example: 90
                                },
                                discount_amount: {
                                    type: 'number',
                                    example: 0
                                },
                                total_amount: {
                                    type: 'number',
                                    example: 590
                                },
                                total_items: {
                                    type: 'number',
                                    example: 5
                                },
                                total_quantity: {
                                    type: 'number',
                                    example: 10
                                }
                            }
                        }
                    }
                },
                Category: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            example: '507f1f77bcf86cd799439011'
                        },
                        idcategory_master: {
                            type: 'string',
                            example: '89'
                        },
                        category_name: {
                            type: 'string',
                            example: 'Groceries'
                        },
                        dept_id: {
                            type: 'string',
                            example: '1'
                        },
                        sequence_id: {
                            type: 'number',
                            example: 1
                        },
                        store_code: {
                            type: 'string',
                            example: 'AVB'
                        },
                        no_of_col: {
                            type: 'number',
                            example: 2
                        },
                        image_link: {
                            type: 'string',
                            example: 'https://example.com/category.jpg'
                        },
                        category_bg_color: {
                            type: 'string',
                            example: '#FF5733'
                        }
                    }
                },
                Address: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            example: '507f1f77bcf86cd799439011'
                        },
                        full_name: {
                            type: 'string',
                            example: 'John Doe'
                        },
                        mobile_number: {
                            type: 'string',
                            example: '9876543210'
                        },
                        email_id: {
                            type: 'string',
                            example: 'john@example.com'
                        },
                        delivery_addr_line_1: {
                            type: 'string',
                            example: '123 Main Street'
                        },
                        delivery_addr_line_2: {
                            type: 'string',
                            example: 'Apartment 4B'
                        },
                        delivery_addr_city: {
                            type: 'string',
                            example: 'Mumbai'
                        },
                        delivery_addr_pincode: {
                            type: 'string',
                            example: '400001'
                        },
                        latitude: {
                            type: 'number',
                            example: 19.0760
                        },
                        longitude: {
                            type: 'number',
                            example: 72.8777
                        }
                    }
                }
            }
        },
        tags: [
            {
                name: 'Authentication',
                description: 'OTP-based authentication endpoints'
            },
            {
                name: 'Products',
                description: 'Product catalog and search endpoints'
            },
            {
                name: 'Cart',
                description: 'Shopping cart management endpoints'
            },
            {
                name: 'Orders',
                description: 'Order placement and history endpoints'
            },
            {
                name: 'Categories',
                description: 'Product category endpoints'
            },
            {
                name: 'Subcategories',
                description: 'Product subcategory endpoints'
            },
            {
                name: 'Departments',
                description: 'Department management endpoints'
            },
            {
                name: 'Favorites',
                description: 'User favorites/wishlist endpoints'
            },
            {
                name: 'Addresses',
                description: 'User address management endpoints'
            },
            {
                name: 'Payment Modes',
                description: 'Payment mode configuration endpoints'
            },
            {
                name: 'Delivery Slots',
                description: 'Delivery slot management endpoints'
            },
            {
                name: 'Stores',
                description: 'Store information endpoints'
            },
            {
                name: 'Pincodes',
                description: 'Pincode serviceability endpoints'
            },
            {
                name: 'Banners',
                description: 'Banner/advertisement management endpoints'
            },
            {
                name: 'Best Sellers',
                description: 'Best selling products endpoints'
            },
            {
                name: 'Top Sellers',
                description: 'Top selling products endpoints'
            },
            {
                name: 'Popular Categories',
                description: 'Popular category management endpoints'
            },
            {
                name: 'Seasonal Categories',
                description: 'Seasonal category management endpoints'
            },
            {
                name: 'Advertisements',
                description: 'Advertisement management endpoints'
            },
            {
                name: 'Notifications',
                description: 'User notification endpoints'
            },
            {
                name: 'Razorpay',
                description: 'Payment gateway integration endpoints'
            },
            {
                name: 'Upload',
                description: 'File upload endpoints'
            },
            {
                name: 'Admin - Dashboard',
                description: 'Admin dashboard analytics endpoints'
            },
            {
                name: 'Admin - Users',
                description: 'Admin user management endpoints'
            },
            {
                name: 'Admin - Products',
                description: 'Admin product management endpoints'
            },
            {
                name: 'Admin - Orders',
                description: 'Admin order management endpoints'
            },
            {
                name: 'Admin - Categories',
                description: 'Admin category management endpoints'
            },
            {
                name: 'Admin - Content',
                description: 'Admin content management endpoints'
            },
            {
                name: 'Admin - Notifications',
                description: 'Admin notification management endpoints'
            }
        ]
    },
    apis: [
        './routes/*.js',
        './routes/admin/*.js',
        './docs/swagger/*.js',
        './server.js'
    ]
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
