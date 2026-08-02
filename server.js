require('dotenv').config();

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('./models/User');

const { connectDB } = require('./config/database');
const { UPLOAD_ROOT } = require('./config/mediaStorage');
const errorHandler = require('./middleware/errorHandler');
const notFound = require('./middleware/notFound');
const { tenantResolver } = require('./middleware/tenant');
const { warnIfTestOtpEnabled } = require('./utils/sms');

// Swagger imports
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');

// Import models to register them with Mongoose
require('./models/User');
require('./models/Address');
require('./models/Product');
require('./models/ProductMaster');
require('./models/Pincode');
require('./models/Store');
require('./models/Department');
require('./models/Category');
require('./models/Subcategory');
require('./models/PaymentMode');
require('./models/DeliverySlot');
require('./models/AddressBook');
require('./models/Counter');
require('./models/Favorite');
require('./models/Cart');
require('./models/Order');
require('./models/BestSeller');
require('./models/TopSeller');
require('./models/PopularCategory');
require('./models/Advertisement');

// Import routes
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const categoryRoutes = require('./routes/categories');
const subcategoryRoutes = require('./routes/subcategories');
const paymentModeRoutes = require('./routes/payment-modes');
const deliverySlotRoutes = require('./routes/delivery-slots');
const addressCrudRoutes = require('./routes/address-crud');
const favoriteRoutes = require('./routes/favorites');
const cartRoutes = require('./routes/cart');
const orderRoutes = require('./routes/orders');
const userRoutes = require('./routes/users');
const bannerRoutes = require('./routes/banners');
const addressRoutes = require('./routes/addresses');
const paymentRoutes = require('./routes/payments');
const uploadRoutes = require('./routes/upload');
const pincodeRoutes = require('./routes/pincodes');
const storeRoutes = require('./routes/stores');
const departmentRoutes = require('./routes/departments');
const bestSellerRoutes = require('./routes/best-sellers');
const topSellerRoutes = require('./routes/top-sellers');
const popularCategoryRoutes = require('./routes/popular-categories');
const seasonalCategoryRoutes = require('./routes/seasonal-categories');
const advertisementRoutes = require('./routes/advertisements');
const deliveryChargesRoutes = require('./routes/deliveryCharges');
const adminRoutes = require('./routes/admin');
const razorpayRoutes = require('./routes/razorpay');
const notificationRoutes = require('./routes/notifications');
const offerRoutes = require('./routes/offers');
const projectConfigRoutes = require('./routes/project-config');
const contentRoutes = require('./routes/content');
const faqRoutes = require('./routes/faqs');
const projectsRoutes = require('./routes/projects');
const digitalCartRoutes = require('./routes/digital-cart');
const onboardingRoutes = require('./routes/onboarding');
const homeRoutes = require('./routes/home');
const homeAnalyticsRoutes = require('./routes/home-analytics');

const app = express();
const PORT = process.env.PORT || 5001;

// Module-scoped so the process-level handlers below can close it. It used to be
// a const inside startServer(), so `server.close()` in the unhandledRejection
// handler threw ReferenceError instead of shutting down.
let server;

// Behind nginx — use real client IP for rate limiting
app.set('trust proxy', 1);

const parseRateLimitSkipIps = () => {
  const raw = process.env.RATE_LIMIT_SKIP_IPS || '';
  return new Set(
    raw
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean)
  );
};

const rateLimitSkipIps = parseRateLimitSkipIps();

const getClientIp = (req) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip;
};

const shouldSkipRateLimit = (req) => {
  if (rateLimitSkipIps.size === 0) {
    return false;
  }
  return rateLimitSkipIps.has(getClientIp(req));
};

// Security middleware
app.use(helmet());

const parseAllowedOrigins = () => {
  if (!process.env.CLIENT_URL) {
    return [];
  }

  return process.env.CLIENT_URL
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
};

const allowedOrigins = parseAllowedOrigins();
const allowAllOrigins = allowedOrigins.length === 0 || allowedOrigins.includes('*');

const corsOptionsDelegate = (req, callback) => {
  const requestOrigin = req.header('Origin');

  if (!requestOrigin) {
    // Allow requests with no origin (like mobile apps, curl requests, Postman)
    return callback(null, {
      origin: true
    });
  }

  if (allowAllOrigins || allowedOrigins.includes(requestOrigin)) {
    return callback(null, {
      origin: requestOrigin
    });
  }

  console.warn(`🛑 CORS blocked origin: ${requestOrigin}`);
  return callback(null, {
    origin: false
  });
};

const corsOptions = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'Cache-Control', 'X-Project-Code'],
  exposedHeaders: ['Content-Length', 'Date', 'X-Request-Id'],
  optionsSuccessStatus: 204,
  maxAge: 86400
};

app.use(cors((req, callback) => {
  corsOptionsDelegate(req, (error, options) => {
    if (error) {
      return callback(error, options);
    }
    callback(null, { ...corsOptions, ...options });
  });
}));
app.options('*', cors((req, callback) => {
  corsOptionsDelegate(req, (error, options) => {
    if (error) {
      return callback(error, options);
    }
    callback(null, { ...corsOptions, ...options });
  });
}));

// Rate limiting - stricter for auth routes.
//
// The OTP is 4 digits (10k possibilities), so the old 1000-per-15-min ceiling
// was not a meaningful brute-force barrier — a handful of windows covered the
// whole keyspace. Credential and OTP submission now get their own tight limit,
// counted per mobile number as well as per IP so one attacker rotating IPs
// still cannot grind a single account.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: {
    error: 'Too many authentication attempts, please try again later.'
  },
  skip: shouldSkipRateLimit,
});

const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  keyGenerator: (req) => {
    const mobile = (req.body && req.body.mobile) || '';
    return `${getClientIp(req)}:${mobile}`;
  },
  message: {
    error: 'Too many attempts for this account, please try again later.'
  },
  skip: shouldSkipRateLimit,
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1500, // limit each IP to 1500 requests per windowMs for general routes
  message: {
    error: 'Too many requests from this IP, please try again later.'
  },
  skip: shouldSkipRateLimit,
});

// Apply general rate limiting to all routes
app.use(generalLimiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression middleware
app.use(compression());

// Logging middleware
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// Suppress favicon requests
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Local media (dev fallback; production is served by nginx at /media/)
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
app.use('/media', express.static(UPLOAD_ROOT, {
  maxAge: '30d',
  immutable: true,
}));

// Health check route
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Universal E-commerce API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Swagger API Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Patel E-commerce API Docs'
}));

// Swagger JSON endpoint
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Multi-tenant resolution — every /api request is bound to its client DB via
// X-Project-Code header (or project_code in body/query, or DEFAULT_PROJECT_CODE)
app.use('/api', tenantResolver);

// API routes
app.use('/api/project-config', projectConfigRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/faqs', faqRoutes);
app.use('/api/projects', projectsRoutes);
// Tight per-account limits on the endpoints that accept a secret. Registered
// before the /api/auth mount so they run first; express.json() has already
// populated req.body by this point, which the key generator needs.
app.use('/api/auth/send-otp', credentialLimiter);
app.use('/api/auth/verify-otp', credentialLimiter);
app.use('/api/auth/admin-login', credentialLimiter);

app.use('/api/auth', authLimiter, authRoutes); // Apply stricter rate limiting to auth routes
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/subcategories', subcategoryRoutes);
app.use('/api/payment-modes', paymentModeRoutes);
app.use('/api/delivery-slots', deliverySlotRoutes);
app.use('/api/address-crud', addressCrudRoutes);
app.use('/api/favorites', favoriteRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/users', userRoutes);
app.use('/api/banners', bannerRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/pincodes', pincodeRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/best-sellers', bestSellerRoutes);
app.use('/api/top-sellers', topSellerRoutes);
app.use('/api/popular-categories', popularCategoryRoutes);
app.use('/api/seasonal-categories', seasonalCategoryRoutes);
app.use('/api/advertisements', advertisementRoutes);
app.use('/api/delivery-charges', deliveryChargesRoutes);
app.use('/api/offers', offerRoutes);
app.use('/api/digital-cart', digitalCartRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/home', homeRoutes);
app.use('/api/home', homeAnalyticsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/razorpay', razorpayRoutes);
app.use('/api/notifications', notificationRoutes);

// Error handling middleware (must be last)
app.use(notFound);
app.use(errorHandler);

// Connect to MongoDB and start server
const startServer = async () => {
  try {
    await connectDB();

    // Loudly surface the fixed-OTP escape hatch if an operator left it on.
    warnIfTestOtpEnabled();

    // Create HTTP server and attach Socket.io
    server = http.createServer(app);
    const io = new Server(server, {
      cors: {
        origin: true,
        credentials: true,
        methods: ['GET', 'POST']
      }
    });

    // Make io accessible to routes via req.app.get('io')
    app.set('io', io);

    // Socket.io auth middleware — only allow admin connections
    io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        if (!token) return next(new Error('No token'));

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
        const user = await User.findById(decoded.id).select('role name mobile');
        if (!user || user.role !== 'admin') return next(new Error('Not admin'));

        socket.user = user;
        next();
      } catch (err) {
        next(new Error('Auth failed'));
      }
    });

    io.on('connection', (socket) => {
      // Join admin room for broadcast notifications
      socket.join('admins');
      console.log(`🔌 Admin connected: ${socket.user?.name || socket.user?.mobile}`);

      socket.on('disconnect', () => {
        console.log(`🔌 Admin disconnected: ${socket.user?.name || socket.user?.mobile}`);
      });
    });

    server.listen(PORT, () => {
      console.log(`
🚀 Universal E-commerce API Server Started!
📍 Running on: http://localhost:${PORT}
🌍 Environment: ${process.env.NODE_ENV || 'development'}
📊 Health check: http://localhost:${PORT}/health
📚 API Documentation: http://localhost:${PORT}/api-docs
🔗 Database: multi-tenant (control: ${process.env.CONTROL_DB_NAME || 'Universal_Control'})
🔐 Authentication: OTP-based with JWT tokens
🔌 WebSocket: Socket.io ready for real-time notifications
⚡ Ready to handle requests!
      `);
    });
  } catch (error) {
    console.error('Failed to start server:', error.message);
    process.exit(1);
  }
};

// Stop accepting connections, then exit. Falls back to a hard exit if the
// server never came up or refuses to close within the grace period.
const shutdown = (reason, err) => {
  console.error(`${reason}:`, err?.stack || err?.message || err);

  if (!server) {
    return process.exit(1);
  }

  const force = setTimeout(() => process.exit(1), 10000);
  force.unref();

  server.close(() => {
    clearTimeout(force);
    process.exit(1);
  });
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  shutdown('Unhandled Promise Rejection', err);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  shutdown('Uncaught Exception', err);
});

startServer();

module.exports = app;
