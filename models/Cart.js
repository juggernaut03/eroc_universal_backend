const mongoose = require('mongoose');

const cartItemSchema = new mongoose.Schema({
  p_code: {
    type: String,
    required: [true, 'Product code is required'],
    trim: true
  },
  product_name: {
    type: String,
    required: [true, 'Product name is required'],
    trim: true
  },
  quantity: {
    type: Number,
    required: [true, 'Quantity is required'],
    min: [1, 'Quantity must be at least 1']
  },
  unit_price: {
    type: Number,
    required: [true, 'Unit price is required'],
    min: [0, 'Unit price cannot be negative']
  },
  total_price: {
    type: Number,
    required: [true, 'Total price is required'],
    min: [0, 'Total price cannot be negative']
  },
  package_size: {
    type: Number,
    trim: true
  },
  package_unit: {
    type: String,
    trim: true
  },
  brand_name: {
    type: String,
    trim: true
  },
  pcode_img: {
    type: String,
    trim: true
  },
  store_code: {
    type: String,
    required: [true, 'Store code is required'],
    trim: true
  }
}, { _id: false });

const cartSchema = new mongoose.Schema({
  mobile_no: {
    type: String,
    required: [true, 'Mobile number is required'],
    trim: true
  },
  store_code: {
    type: String,
    required: [true, 'Store code is required'],
    trim: true
  },
  project_code: {
    type: String,
    required: [true, 'Project code is required'],
    trim: true
  },
  items: [cartItemSchema],
  subtotal: {
    type: Number,
    required: [true, 'Subtotal is required'],
    min: [0, 'Subtotal cannot be negative'],
    default: 0
  },
  total_items: {
    type: Number,
    required: [true, 'Total items count is required'],
    min: [0, 'Total items cannot be negative'],
    default: 0
  },
  total_quantity: {
    type: Number,
    required: [true, 'Total quantity is required'],
    min: [0, 'Total quantity cannot be negative'],
    default: 0
  },
  last_updated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  collection: 'carts'
});

// Indexes for better query performance
cartSchema.index({ mobile_no: 1 }, { unique: true }); // One cart per user
cartSchema.index({ mobile_no: 1, store_code: 1 });
cartSchema.index({ last_updated: -1 });
cartSchema.index({ 'items.p_code': 1 });

// Pre-save middleware to calculate totals
cartSchema.pre('save', function (next) {
  let subtotal = 0;
  let totalQuantity = 0;
  let totalItems = this.items.length;

  this.items.forEach(item => {
    subtotal += item.total_price;
    totalQuantity += item.quantity;
  });

  this.subtotal = subtotal;
  this.total_items = totalItems;
  this.total_quantity = totalQuantity;
  this.last_updated = new Date();

  next();
});

// Static method to find cart by mobile number
cartSchema.statics.findByMobile = function (mobileNo) {
  return this.findOne({ mobile_no: mobileNo });
};

// Static method to find or create cart for user
cartSchema.statics.findOrCreateByMobile = function (mobileNo, storeCode, projectCode) {
  return this.findOneAndUpdate(
    { mobile_no: mobileNo },
    {
      store_code: storeCode,
      project_code: projectCode,
      last_updated: new Date()
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true
    }
  );
};

// Static method to clear cart
cartSchema.statics.clearCart = function (mobileNo) {
  return this.findOneAndUpdate(
    { mobile_no: mobileNo },
    {
      items: [],
      subtotal: 0,
      total_items: 0,
      total_quantity: 0,
      last_updated: new Date()
    },
    { new: true }
  );
};

// Instance method to validate cart items against current product data
cartSchema.methods.validateItems = async function () {
  const ProductMaster = require('./ProductMaster');
  const Offer = require('./Offer');
  const validationResults = {
    valid: true,
    invalidItems: [],
    updatedItems: [],
    totalValidItems: 0,
    totalInvalidItems: 0
  };

  // Active product_deal offers for this cart's store, keyed by p_code - lets
  // the price check below recognize a legitimately deal-priced item instead
  // of flagging it as stale just because it doesn't match ProductMaster's
  // catalog price (a deal price never will, by design). Eligibility mirrors
  // utils/orderService.js's applyDeals() exactly (active + date window +
  // store_codes + min_cart_value against the non-deal subtotal), so this
  // pre-checkout validation agrees with what order placement will actually
  // charge - a deal that's no longer eligible (e.g. the qualifying items
  // were removed) still correctly falls through to a real price-changed flag.
  const now = new Date();
  const dealOffers = await Offer.find({
    offer_type: 'product_deal',
    is_active: true,
    valid_from: { $lte: now },
    $or: [{ valid_until: null }, { valid_until: { $gte: now } }]
  });

  const dealPriceByPCode = new Map();
  for (const offer of dealOffers) {
    if (offer.store_codes?.length > 0 && !offer.store_codes.includes(this.store_code)) continue;
    for (const dp of offer.deal_products || []) {
      if (!dealPriceByPCode.has(dp.p_code)) {
        dealPriceByPCode.set(dp.p_code, { offer, dealProduct: dp });
      }
    }
  }

  const nonDealSubtotal = this.items
    .filter((item) => !dealPriceByPCode.has(item.p_code))
    .reduce((sum, item) => sum + item.total_price, 0);

  // Helper function to format product data for frontend
  const formatProductData = (product) => {
    return {
      p_code: product.p_code,
      product_name: product.product_name,
      product_description: product.product_description,
      package_size: product.package_size,
      package_unit: product.package_unit,
      product_mrp: product.product_mrp ? parseFloat(product.product_mrp.toString()) : 0,
      our_price: product.our_price ? parseFloat(product.our_price.toString()) : 0,
      brand_name: product.brand_name,
      store_code: product.store_code,
      pcode_status: product.pcode_status,
      dept_id: product.dept_id,
      category_id: product.category_id,
      sub_category_id: product.sub_category_id,
      store_quantity: product.store_quantity,
      max_quantity_allowed: product.max_quantity_allowed,
      pcode_img: product.pcode_img,
      barcode: product.barcode
    };
  };

  for (let i = 0; i < this.items.length; i++) {
    const cartItem = this.items[i];

    try {
      // Find current product data
      const currentProduct = await ProductMaster.findOne({
        p_code: cartItem.p_code,
        store_code: cartItem.store_code,
        pcode_status: 'Y'
      });

      if (!currentProduct) {
        // Product not found or inactive
        validationResults.valid = false;
        validationResults.invalidItems.push({
          index: i,
          action: 'remove', // Frontend action: remove from cart
          actionType: 'product_not_found',
          message: 'Product not found or inactive',
          p_code: cartItem.p_code,
          product_name: cartItem.product_name,
          available_quantity: 0,
          cartItem: cartItem,
          product: null, // No product data available
          suggestedAction: {
            type: 'remove',
            message: 'This product is no longer available. Please remove it from your cart.'
          }
        });
        validationResults.totalInvalidItems++;
        continue;
      }

      // Format current product data
      const currentProductData = formatProductData(currentProduct);
      let currentPrice = parseFloat(currentProduct.our_price?.toString() || '0');
      const currentStock = currentProduct.store_quantity || 0;
      const maxAllowed = currentProduct.max_quantity_allowed || null;
      const requestedQuantity = cartItem.quantity;

      // This item's stored price is the deal price of a still-eligible
      // product_deal - treat that as "current" instead of the catalog price
      // so every price check below (out-of-stock/insufficient-stock/
      // max-quantity reports, and the plain price-changed check further
      // down) agrees it hasn't actually changed.
      const dealEntry = dealPriceByPCode.get(cartItem.p_code);
      if (
        dealEntry &&
        Math.abs(cartItem.unit_price - dealEntry.dealProduct.deal_price) < 0.01 &&
        nonDealSubtotal >= dealEntry.offer.min_cart_value
      ) {
        // Snap to cartItem.unit_price itself (not dealProduct.deal_price) so
        // every downstream `currentPrice !== cartItem.unit_price` below is an
        // exact match rather than reintroducing a float-rounding mismatch.
        currentPrice = cartItem.unit_price;
      }

      // Track if item has issues
      let itemHasIssues = false;
      const itemIssues = [];

      // Check if price has changed
      if (currentPrice !== cartItem.unit_price) {
        itemHasIssues = true;
        itemIssues.push('price_changed');
      }

      // Check stock availability
      if (currentStock === 0) {
        validationResults.valid = false;
        validationResults.invalidItems.push({
          index: i,
          action: 'update_quantity',
          actionType: 'out_of_stock',
          message: 'Product is out of stock',
          p_code: cartItem.p_code,
          product_name: cartItem.product_name,
          available_quantity: 0,
          current_price: currentPrice,
          cartItem: cartItem,
          product: currentProductData,
          stock: {
            available: 0,
            requested: requestedQuantity,
            status: 'out_of_stock'
          },
          price: {
            old: cartItem.unit_price,
            new: currentPrice,
            changed: currentPrice !== cartItem.unit_price
          },
          suggestedAction: {
            type: 'update_quantity',
            message: 'This product is out of stock. Please remove it or wait for restock.',
            options: [
              { action: 'remove', label: 'Remove from cart' },
              { action: 'keep', label: 'Keep for later (will notify when available)' }
            ]
          }
        });
        validationResults.totalInvalidItems++;
        continue;
      }

      // Check if stock is insufficient
      if (currentStock < requestedQuantity) {
        validationResults.valid = false;
        itemHasIssues = true;
        itemIssues.push('insufficient_stock');

        validationResults.invalidItems.push({
          index: i,
          action: 'update_quantity',
          actionType: 'insufficient_stock',
          message: `Only ${currentStock} item(s) available. You requested ${requestedQuantity}.`,
          p_code: cartItem.p_code,
          product_name: cartItem.product_name,
          available_quantity: currentStock,
          current_price: currentPrice,
          cartItem: cartItem,
          product: currentProductData,
          stock: {
            available: currentStock,
            requested: requestedQuantity,
            status: 'insufficient',
            maxAvailable: currentStock
          },
          price: {
            old: cartItem.unit_price,
            new: currentPrice,
            changed: currentPrice !== cartItem.unit_price
          },
          suggestedAction: {
            type: 'update_quantity',
            message: `Only ${currentStock} item(s) available. Update quantity to ${currentStock}?`,
            newQuantity: currentStock,
            options: [
              { action: 'update', label: `Update to ${currentStock}`, quantity: currentStock },
              { action: 'remove', label: 'Remove from cart' }
            ]
          }
        });
        validationResults.totalInvalidItems++;
        continue;
      }

      // Check max quantity allowed
      if (maxAllowed && requestedQuantity > maxAllowed) {
        validationResults.valid = false;
        itemHasIssues = true;
        itemIssues.push('max_quantity_exceeded');

        validationResults.invalidItems.push({
          index: i,
          action: 'update_quantity',
          actionType: 'max_quantity_exceeded',
          message: `Maximum ${maxAllowed} item(s) allowed per order. You requested ${requestedQuantity}.`,
          p_code: cartItem.p_code,
          product_name: cartItem.product_name,
          available_quantity: maxAllowed, // Treat max allowed as available cap
          max_allowed: maxAllowed,
          current_price: currentPrice,
          cartItem: cartItem,
          product: currentProductData,
          stock: {
            available: currentStock,
            requested: requestedQuantity,
            status: 'available',
            maxAllowed: maxAllowed
          },
          price: {
            old: cartItem.unit_price,
            new: currentPrice,
            changed: currentPrice !== cartItem.unit_price
          },
          suggestedAction: {
            type: 'update_quantity',
            message: `Maximum ${maxAllowed} item(s) allowed. Update quantity to ${maxAllowed}?`,
            newQuantity: maxAllowed,
            options: [
              { action: 'update', label: `Update to ${maxAllowed}`, quantity: maxAllowed },
              { action: 'remove', label: 'Remove from cart' }
            ]
          }
        });
        validationResults.totalInvalidItems++;
        continue;
      }

      // If price changed but stock is fine, add to updatedItems
      if (currentPrice !== cartItem.unit_price) {
        validationResults.updatedItems.push({
          index: i,
          action: 'update_price', // Frontend action: update price
          actionType: 'price_changed',
          message: `Price updated from ₹${cartItem.unit_price} to ₹${currentPrice}`,
          p_code: cartItem.p_code,
          cartItem: cartItem,
          product: currentProductData,
          price: {
            old: cartItem.unit_price,
            new: currentPrice,
            difference: currentPrice - cartItem.unit_price,
            percentageChange: ((currentPrice - cartItem.unit_price) / cartItem.unit_price * 100).toFixed(2)
          },
          stock: {
            available: currentStock,
            requested: requestedQuantity,
            status: 'available'
          },
          suggestedAction: {
            type: 'update_price',
            message: `Price has changed. Update cart with new price ₹${currentPrice}?`,
            newTotalPrice: currentPrice * requestedQuantity,
            options: [
              { action: 'update', label: 'Update price', newPrice: currentPrice },
              { action: 'remove', label: 'Remove from cart' }
            ]
          }
        });
      }

      // Item is valid
      if (!itemHasIssues) {
        validationResults.totalValidItems++;
      }

    } catch (error) {
      validationResults.valid = false;
      validationResults.invalidItems.push({
        index: i,
        action: 'remove',
        actionType: 'validation_error',
        message: `Validation error: ${error.message}`,
        p_code: cartItem.p_code,
        cartItem: cartItem,
        product: null,
        error: error.message,
        suggestedAction: {
          type: 'remove',
          message: 'Unable to validate this product. Please remove it from your cart.'
        }
      });
      validationResults.totalInvalidItems++;
    }
  }

  return validationResults;
};

module.exports = require('./tenantModel')('Cart', cartSchema);
