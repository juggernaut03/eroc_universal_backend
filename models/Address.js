const mongoose = require('mongoose');
const { MOBILE_REGEX, MOBILE_MESSAGE } = require('../utils/phone');
const { POSTCODE_REGEX, POSTCODE_MESSAGE } = require('../utils/postcode');

const addressSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['home', 'work', 'other'],
    default: 'home'
  },
  name: {
    type: String,
    required: [true, 'Address name is required'],
    trim: true,
    maxlength: [100, 'Address name cannot be more than 100 characters']
  },
  street: {
    type: String,
    required: [true, 'Street address is required'],
    trim: true,
    maxlength: [200, 'Street address cannot be more than 200 characters']
  },
  city: {
    type: String,
    required: [true, 'City is required'],
    trim: true,
    maxlength: [50, 'City cannot be more than 50 characters']
  },
  state: {
    type: String,
    required: [true, 'State is required'],
    trim: true,
    maxlength: [50, 'State cannot be more than 50 characters']
  },
  pincode: {
    type: String,
    required: [true, 'Pincode is required'],
    match: [POSTCODE_REGEX, POSTCODE_MESSAGE]
  },
  country: {
    type: String,
    default: 'India',
    trim: true
  },
  landmark: {
    type: String,
    trim: true,
    maxlength: [100, 'Landmark cannot be more than 100 characters']
  },
  phone: {
    type: String,
    match: [MOBILE_REGEX, MOBILE_MESSAGE]
  },
  isDefault: {
    type: Boolean,
    default: false
  },
  coordinates: {
    latitude: {
      type: Number,
      min: [-90, 'Latitude must be between -90 and 90'],
      max: [90, 'Latitude must be between -90 and 90']
    },
    longitude: {
      type: Number,
      min: [-180, 'Longitude must be between -180 and 180'],
      max: [180, 'Longitude must be between -180 and 180']
    }
  },
  deliveryInstructions: {
    type: String,
    trim: true,
    maxlength: [200, 'Delivery instructions cannot be more than 200 characters']
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Index for better query performance
addressSchema.index({ user: 1, isActive: 1 });
addressSchema.index({ pincode: 1 });
addressSchema.index({ user: 1, isDefault: 1 });

// Virtual for full address string
addressSchema.virtual('fullAddress').get(function() {
  const parts = [
    this.street,
    this.landmark && `Near ${this.landmark}`,
    this.city,
    this.state,
    this.pincode,
    this.country
  ].filter(Boolean);

  return parts.join(', ');
});

// Static method to find user's addresses
addressSchema.statics.findByUser = function(userId) {
  return this.find({ user: userId, isActive: true }).sort({ isDefault: -1, createdAt: -1 });
};

// Static method to find default address
addressSchema.statics.findDefaultByUser = function(userId) {
  return this.findOne({ user: userId, isDefault: true, isActive: true });
};

// Instance method to make address default
addressSchema.methods.makeDefault = function() {
  return this.constructor.updateMany(
    { user: this.user },
    { $set: { isDefault: false } }
  ).then(() => {
    this.isDefault = true;
    return this.save();
  });
};

// Pre-save middleware to ensure only one default address per user
addressSchema.pre('save', async function(next) {
  if (this.isDefault && this.isModified('isDefault')) {
    // Remove default status from other addresses
    await this.constructor.updateMany(
      { user: this.user, _id: { $ne: this._id } },
      { $set: { isDefault: false } }
    );
  }
  next();
});

module.exports = require('./tenantModel')('Address', addressSchema);
