const mongoose = require('mongoose');

const seasonalCategoryItemSchema = new mongoose.Schema({
  sub_category_id: {
    type: String,
    required: [true, 'Sub category ID is required'],
    trim: true
  },
  // Which collection `sub_category_id` is actually an id into. Category and
  // Subcategory ids are both small per-tenant sequences, so the same number
  // commonly names two unrelated things — an admin typing a category id into
  // this field (thinking "which tile category") used to silently resolve to
  // a same-numbered subcategory instead. Explicit beats guessed. Defaults to
  // 'subcategory' so every tile entered before this field existed keeps
  // resolving exactly as it did (see routes/seasonal-categories.js).
  reference_type: {
    type: String,
    enum: ['category', 'subcategory'],
    default: 'subcategory'
  },
  store_code: {
    type: String,
    trim: true
  },
  position: {
    type: Number,
    default: 0
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  redirect_url: {
    type: String,
    trim: true
  }
}, { _id: false });

const seasonalCategorySchema = new mongoose.Schema({
  store_code: {
    type: String,
    trim: true,
    default: null
  },
  store_codes: {
    type: [String],
    default: undefined,
    validate: {
      validator: function(codes) {
        return !codes || (Array.isArray(codes) && codes.length > 0 && codes.every(code => code && code.trim() !== ''));
      },
      message: 'store_codes must be a non-empty array of valid store codes'
    }
  },
  banner_urls: {
    desktop: {
      type: String,
      required: [true, 'Desktop banner URL is required'],
      trim: true
    },
    mobile: {
      type: String,
      required: [true, 'Mobile banner URL is required'],
      trim: true
    }
  },
  background_color: {
    type: String,
    required: [true, 'Background color is required'],
    trim: true
  },
  title: {
    type: String,
    required: [true, 'Title is required'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  redirect_url: {
    type: String,
    trim: true
  },
  subcategories: {
    type: [seasonalCategoryItemSchema],
    default: [],
    validate: [
      {
        validator: function(items) {
          return Array.isArray(items) && items.length > 0;
        },
        message: 'At least one subcategory is required'
      }
    ]
  },
  is_active: {
    type: Boolean,
    default: true
  },
  sequence: {
    type: Number,
    default: 0
  },
  season: {
    type: String,
    trim: true,
    enum: ['spring', 'summer', 'autumn', 'fall', 'winter', 'holiday', 'festive', 'all'],
    default: 'all'
  },
  start_date: {
    type: Date,
    default: Date.now
  },
  end_date: {
    type: Date
  }
}, {
  timestamps: true,
  collection: 'seasonal_categories'
});

seasonalCategorySchema.index({ store_code: 1, is_active: 1, sequence: 1 });
seasonalCategorySchema.index({ store_codes: 1, is_active: 1, sequence: 1 });
seasonalCategorySchema.index({ season: 1, is_active: 1 });
seasonalCategorySchema.index({ start_date: 1, end_date: 1 });

seasonalCategorySchema.statics.findActiveByStore = function(storeCode) {
  const query = { is_active: true };

  if (storeCode) {
    query.store_code = storeCode.trim();
  }

  return this.find(query).sort({ sequence: 1, createdAt: -1 });
};

seasonalCategorySchema.statics.findByStore = function(storeCode) {
  const query = {};

  if (storeCode) {
    query.store_code = storeCode.trim();
  }

  return this.find(query).sort({ sequence: 1, createdAt: -1 });
};

seasonalCategorySchema.statics.findByStoreCodes = function(storeCodes, activeOnly = false) {
  const query = {};

  if (activeOnly) {
    query.is_active = true;
  }

  if (storeCodes && Array.isArray(storeCodes) && storeCodes.length > 0) {
    query.$or = [
      { store_codes: { $in: storeCodes } },
      { store_code: { $in: storeCodes } }
    ];
  }

  return this.find(query).sort({ sequence: 1, createdAt: -1 });
};

seasonalCategorySchema.statics.findActiveBySeason = function(season, activeOn = new Date()) {
  const query = {
    is_active: true,
    start_date: { $lte: activeOn }
  };

  query.$or = [
    { end_date: { $exists: false } },
    { end_date: null },
    { end_date: { $gte: activeOn } }
  ];

  if (season && season !== 'all') {
    query.season = season;
  }

  return this.find(query).sort({ sequence: 1, createdAt: -1 });
};

module.exports = require('./tenantModel')('SeasonalCategory', seasonalCategorySchema);
