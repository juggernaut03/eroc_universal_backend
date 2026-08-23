const Order = require('../models/Order');
const Cart = require('../models/Cart');
const Store = require('../models/Store');
const Offer = require('../models/Offer');
const AddressBook = require('../models/AddressBook');
const DeliverySlot = require('../models/DeliverySlot');
const PaymentMode = require('../models/PaymentMode');
const ProductMaster = require('../models/ProductMaster');
const LoyaltyRedemption = require('../models/LoyaltyRedemption');

const razorpayService = require('./razorpayService');
const { previewRedemptionDiscount, markRedemptionUsed } = require('./loyaltyRedemption');
const { getTenantConnection } = require('../config/tenantContext');
const {
  calculateDistance,
  calculateDeliveryCharge,
  buildStoreDeliveryConfig,
  isValidCoordinate,
} = require('./distanceCalculation');

// Order placement.
//
// Extracted out of the route handler because none of this is HTTP concern, and
// because the previous inline version took the client's word on three things it
// must not: whether the cart was validated, what the delivery charge was, and
// whether the order had been paid for.
//
// Everything that determines what the customer is charged is now recomputed
// from the database on the server. The request body only selects *which*
// address / slot / payment mode / offer to use — never an amount.

// GST is INCLUDED in our_price, as it is on the shelf price it comes from.
//
// The total used to be `subtotal + delivery + subtotal * 0.18`, adding the tax
// a second time on top of a price that already carried it. That made every
// online payment impossible to complete: the app charges the cart total the
// shopper was shown, resolvePaymentStatus then compares the captured amount to
// this inflated figure and refuses the order — money taken, no order. On a
// ₹339 basket the two differed by ₹61.
//
// Tax is still recorded, but as the portion of the inclusive price that IS
// tax (`amount × rate / (1 + rate)`), which is what an invoice needs.
const TAX_RATE = 0.18; // 18% GST, included in the price

/// The GST already contained in a tax-inclusive [amount].
const includedTax = (amount) => round2((amount * TAX_RATE) / (1 + TAX_RATE));
const ORDER_NUMBER_RETRIES = 5;

// Payment modes whose name implies the money is collected up front. There is no
// is_online flag on the PaymentMode model, so this is name-based.
const ONLINE_MODE_PATTERN = /online|razorpay|upi|card|prepaid|net\s*bank/i;

class OrderError extends Error {
  constructor(message, statusCode = 400, details) {
    super(message);
    this.name = 'OrderError';
    this.statusCode = statusCode;
    if (details) {
      this.details = details;
    }
  }
}

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const toNumber = (value) => parseFloat(value?.toString() || '0') || 0;

/**
 * Re-price the cart from ProductMaster.
 *
 * The cart's stored unit_price is a client-visible cache that a caller can push
 * arbitrary values into via save-cart. Authoritative prices only ever come from
 * the product catalogue, read here at placement time.
 */
const repriceCart = async (cart) => {
  const items = [];
  const problems = [];

  for (const cartItem of cart.items) {
    const product = await ProductMaster.findOne({
      p_code: cartItem.p_code,
      store_code: cartItem.store_code,
      pcode_status: 'Y',
    }).lean();

    if (!product) {
      problems.push({
        p_code: cartItem.p_code,
        product_name: cartItem.product_name,
        reason: 'product_not_found',
        message: 'This product is no longer available.',
      });
      continue;
    }

    const unitPrice = toNumber(product.our_price);
    const stock = product.store_quantity || 0;
    const maxAllowed = product.max_quantity_allowed || null;

    if (stock <= 0) {
      problems.push({
        p_code: cartItem.p_code,
        product_name: product.product_name,
        reason: 'out_of_stock',
        available_quantity: 0,
        message: 'This product is out of stock.',
      });
      continue;
    }

    if (cartItem.quantity > stock) {
      problems.push({
        p_code: cartItem.p_code,
        product_name: product.product_name,
        reason: 'insufficient_stock',
        available_quantity: stock,
        requested_quantity: cartItem.quantity,
        message: `Only ${stock} left in stock.`,
      });
      continue;
    }

    if (maxAllowed && cartItem.quantity > maxAllowed) {
      problems.push({
        p_code: cartItem.p_code,
        product_name: product.product_name,
        reason: 'max_quantity_exceeded',
        available_quantity: maxAllowed,
        requested_quantity: cartItem.quantity,
        message: `Maximum ${maxAllowed} per order.`,
      });
      continue;
    }

    const base = typeof cartItem.toObject === 'function' ? cartItem.toObject() : { ...cartItem };

    items.push({
      ...base,
      product_name: product.product_name,
      mrp: toNumber(product.product_mrp) || undefined,
      unit_price: unitPrice,
      total_price: round2(unitPrice * cartItem.quantity),
    });
  }

  return { items, problems };
};

/**
 * Delivery charge, recomputed from the store and address coordinates.
 *
 * The client used to send its own delivery_charges value, which was written
 * straight onto the order. That field is now ignored entirely.
 */
const resolveDeliveryCharges = async (storeCode, address, orderAmount) => {
  const store = await Store.findOne({ store_code: storeCode }).lean();

  const storeLat = parseFloat(store?.latitude);
  const storeLon = parseFloat(store?.longitude);
  const addrLat = parseFloat(address?.latitude);
  const addrLon = parseFloat(address?.longitude);

  // Without both coordinate pairs there is nothing to compute from. Charge
  // nothing rather than falling back to a client-supplied number.
  if (!isValidCoordinate(storeLat, storeLon) || !isValidCoordinate(addrLat, addrLon)) {
    console.warn(
      `Delivery charge not computable for store ${storeCode} ` +
      `(store coords valid: ${isValidCoordinate(storeLat, storeLon)}, ` +
      `address coords valid: ${isValidCoordinate(addrLat, addrLon)}) — charging 0.`
    );
    return { charges: 0, distanceKm: 0 };
  }

  const distanceResult = await calculateDistance(addrLat, addrLon, storeLat, storeLon);
  const chargeResult = calculateDeliveryCharge(
    distanceResult.distance,
    orderAmount,
    buildStoreDeliveryConfig(store)
  );

  if (chargeResult.deliveryCharge === -1) {
    throw new OrderError(
      chargeResult.reason || 'Delivery is not available to this address.',
      400
    );
  }

  return {
    charges: round2(chargeResult.totalCharges || 0),
    distanceKm: round2(distanceResult.distance),
  };
};

/**
 * Apply product deals, using the offer's own stored deal prices.
 */
const applyDeals = (items, dealItems, dealOffers, storeCode) => {
  let orderItems = items;
  const applied = [];
  let savings = 0;

  if (!Array.isArray(dealItems) || dealItems.length === 0) {
    return { orderItems, applied, savings };
  }

  const now = new Date();
  const dealPCodes = dealItems.map((d) => d.p_code);
  const nonDealSubtotal = orderItems
    .filter((item) => !dealPCodes.includes(item.p_code))
    .reduce((sum, item) => sum + item.total_price, 0);

  for (const requested of dealItems) {
    const dealOffer = dealOffers.get(String(requested.offer_id));

    if (!dealOffer || dealOffer.offer_type !== 'product_deal' || !dealOffer.is_active) continue;
    if (dealOffer.valid_from > now) continue;
    if (dealOffer.valid_until && dealOffer.valid_until < now) continue;
    if (nonDealSubtotal < dealOffer.min_cart_value) continue;
    if (dealOffer.store_codes?.length > 0 && !dealOffer.store_codes.includes(storeCode)) continue;

    const dealProduct = (dealOffer.deal_products || []).find((dp) => dp.p_code === requested.p_code);
    if (!dealProduct) continue;

    const qty = Math.min(requested.quantity || 1, dealProduct.max_quantity);

    orderItems = orderItems.map((item) => {
      if (item.p_code !== requested.p_code) return item;

      // Only up to the deal's own max_quantity gets deal_price - a cart
      // quantity beyond that must fall back to the item's regular price for
      // the remainder, not get the deal price for every unit. This used to
      // apply dealProduct.deal_price to the item's *entire* quantity
      // regardless of qty, so e.g. a max_quantity:1 "free product" deal
      // added at quantity 5 was charged 5 x deal_price instead of
      // 1 x deal_price + 4 x regular price.
      const discountedQty = Math.min(item.quantity, qty);
      const regularQty = item.quantity - discountedQty;
      savings += (item.unit_price - dealProduct.deal_price) * discountedQty;

      return {
        ...item,
        // unit_price only cleanly represents one price per line - keep it as
        // the deal price when every unit qualifies (the common case), else
        // leave it at the regular price so it still means something; either
        // way total_price below is the authoritative blended charge.
        unit_price: regularQty === 0 ? dealProduct.deal_price : item.unit_price,
        total_price: round2(dealProduct.deal_price * discountedQty + item.unit_price * regularQty),
      };
    });

    applied.push({
      offer_id: dealOffer._id.toString(),
      offer_title: dealOffer.title,
      p_code: requested.p_code,
      product_name: dealProduct.product_name,
      deal_price: dealProduct.deal_price,
      original_price: dealProduct.original_price,
      quantity: qty,
      savings: round2((dealProduct.original_price - dealProduct.deal_price) * qty),
    });
  }

  return { orderItems, applied, savings: round2(savings) };
};

/**
 * Cart-level discount from an offer, re-checked against the server-side subtotal.
 */
const applyCartOffer = (offer, subtotal, storeCode) => {
  if (!offer) return { discountAmount: 0, appliedOffer: null };

  const now = new Date();
  const eligible =
    offer.is_active &&
    (offer.offer_type || 'cart_discount') === 'cart_discount' &&
    offer.valid_from <= now &&
    (!offer.valid_until || offer.valid_until >= now) &&
    subtotal >= offer.min_cart_value &&
    (!offer.store_codes?.length || offer.store_codes.includes(storeCode));

  if (!eligible) return { discountAmount: 0, appliedOffer: null };

  let discountAmount;
  if (offer.discount_type === 'percentage') {
    discountAmount = Math.round((subtotal * offer.discount_amount) / 100);
    if (offer.max_discount && discountAmount > offer.max_discount) {
      discountAmount = offer.max_discount;
    }
  } else {
    discountAmount = offer.discount_amount;
  }

  // Never let a discount exceed the goods value.
  discountAmount = Math.min(round2(discountAmount), round2(subtotal));

  return {
    discountAmount,
    appliedOffer: {
      offer_id: offer._id.toString(),
      title: offer.title,
      discount_type: offer.discount_type,
      discount_amount: discountAmount,
    },
  };
};

/**
 * Decide the payment status.
 *
 * Previously this was inferred from whatever the client put in payment_details
 * — posting {payment_status:'completed'} was enough to have an order recorded
 * as paid. Now an order is only marked paid when Razorpay's own signature
 * verifies against the tenant's key secret AND the captured amount matches the
 * total the server computed.
 */
const resolvePaymentStatus = async ({ paymentMode, paymentDetails, totalAmount, project }) => {
  const isOnlineMode = ONLINE_MODE_PATTERN.test(paymentMode.payment_mode_name || '');
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  } = paymentDetails || {};

  const hasRazorpayPayload = Boolean(razorpay_order_id && razorpay_payment_id && razorpay_signature);

  if (!hasRazorpayPayload) {
    if (isOnlineMode) {
      throw new OrderError(
        'This payment mode requires a completed online payment. ' +
        'razorpay_order_id, razorpay_payment_id and razorpay_signature are required.',
        402
      );
    }
    // Pay-on-delivery: nothing is collected yet.
    return { paymentStatus: 'pending', transactionId: '', verifiedPayment: null };
  }

  const isAuthentic = await razorpayService.verifySignature(
    { razorpay_order_id, razorpay_payment_id, razorpay_signature },
    project
  );

  if (!isAuthentic) {
    throw new OrderError('Payment verification failed. Order was not placed.', 402);
  }

  // Confirm against the gateway rather than the caller.
  let payment;
  try {
    payment = await razorpayService.fetchPayment(razorpay_payment_id, project);
  } catch (error) {
    console.error('Razorpay payment lookup failed during order placement:', error.message);
    throw new OrderError(
      'Could not confirm the payment with the gateway. Please try again.',
      502
    );
  }

  if (!payment || (payment.status !== 'captured' && payment.status !== 'authorized')) {
    throw new OrderError(
      `Payment is not complete (status: ${payment?.status || 'unknown'}).`,
      402
    );
  }

  // Razorpay works in paise.
  const expectedPaise = Math.round(totalAmount * 100);
  if (Math.abs(Number(payment.amount) - expectedPaise) > 1) {
    throw new OrderError(
      `Paid amount does not match the order total ` +
      `(paid ₹${Number(payment.amount) / 100}, expected ₹${totalAmount}).`,
      402
    );
  }

  return {
    paymentStatus: payment.status === 'captured' ? 'completed' : 'processing',
    transactionId: payment.id,
    verifiedPayment: {
      razorpay_order_id,
      razorpay_payment_id,
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      status: payment.status,
      captured: payment.captured,
    },
  };
};

const isTransactionUnsupported = (error) =>
  error?.code === 20 ||
  error?.codeName === 'IllegalOperation' ||
  /Transaction numbers are only allowed|transactions are not supported|replica set/i.test(
    error?.message || ''
  );

/**
 * Run the write phase atomically where the deployment supports it.
 *
 * Saving the order and emptying the cart were two independent writes: a crash
 * between them left a paid order with the items still sitting in the cart.
 * Single-node deployments cannot do transactions at all, so fall back rather
 * than refusing to place orders there.
 */
const runAtomically = async (work) => {
  let session;

  try {
    session = await getTenantConnection().startSession();
  } catch (error) {
    console.warn(`Could not start a session (${error.message}) — writing without a transaction.`);
    return work(null);
  }

  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } catch (error) {
    if (isTransactionUnsupported(error)) {
      console.warn('Transactions unavailable on this deployment — writing without one.');
      return work(null);
    }
    throw error;
  } finally {
    await session.endSession();
  }
};

/**
 * Place an order for the authenticated user.
 *
 * @param {object} params
 * @param {object} params.user    Authenticated user document (req.user)
 * @param {object} params.body    Request body
 * @param {object} params.project Tenant project doc (req.tenant.project)
 * @returns {Promise<object>}     The saved order
 */
const placeOrder = async ({ user, body, project }) => {
  const {
    store_code,
    delivery_slot_id,
    delivery_date,
    address_id,
    payment_mode_id,
    order_notes,
    payment_details,
    offer_id,
    deal_items,
    loyalty_redemption_id,
  } = body || {};

  // --- Required selectors (note: no amounts, and no cart_validated flag) ---
  if (!store_code || String(store_code).trim() === '') {
    throw new OrderError('store_code is required');
  }
  if (!delivery_slot_id) throw new OrderError('delivery_slot_id is required');
  if (!delivery_date) throw new OrderError('delivery_date is required');
  if (!address_id) throw new OrderError('address_id is required');
  if (!payment_mode_id) throw new OrderError('payment_mode_id is required');

  const storeCode = String(store_code).trim();
  const userMobile = user.mobile;

  // --- Cart ---
  const cart = await Cart.findByMobile(userMobile);
  if (!cart || cart.items.length === 0) {
    throw new OrderError('Cart is empty. Please add items to cart before placing order.');
  }

  // --- Selectors resolved against the DB ---
  const [deliverySlot, paymentMode, deliveryAddress] = await Promise.all([
    DeliverySlot.findOne({
      iddelivery_slot: delivery_slot_id,
      store_code: storeCode,
      is_active: 'yes',
    }),
    PaymentMode.findOne({ idpayment_mode: payment_mode_id, is_enabled: 'Yes' }),
    AddressBook.findById(address_id),
  ]);

  if (!deliverySlot) {
    throw new OrderError('Invalid delivery slot or slot not available for this store');
  }
  if (!paymentMode) {
    throw new OrderError('Invalid payment mode or payment mode not available');
  }
  if (!deliveryAddress) {
    throw new OrderError('Delivery address not found');
  }
  if (deliveryAddress.mobile_number !== userMobile) {
    throw new OrderError('You can only use your own addresses for delivery', 403);
  }

  // --- Loyalty reward voucher, if the customer picked one at checkout ---
  // Validated up front so an invalid/expired/already-used voucher fails
  // fast rather than silently charging full price - the customer's not
  // shown the loyalty discount in this response otherwise.
  let loyaltyRedemption = null;
  if (loyalty_redemption_id) {
    loyaltyRedemption = await LoyaltyRedemption.findOne({ _id: loyalty_redemption_id, mobile: userMobile });
    if (!loyaltyRedemption) {
      throw new OrderError('Reward voucher not found', 404);
    }
    if (loyaltyRedemption.status !== 'ACTIVE') {
      throw new OrderError('This reward voucher has already been used or is no longer active', 400);
    }
    if (loyaltyRedemption.expiresAt < new Date()) {
      throw new OrderError('This reward voucher has expired', 400);
    }
  }

  const deliveryDateObj = new Date(delivery_date);
  if (Number.isNaN(deliveryDateObj.getTime())) {
    throw new OrderError('delivery_date is not a valid date');
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (deliveryDateObj < today) {
    throw new OrderError('Delivery date cannot be in the past');
  }

  // --- Server-side cart validation (replaces the client's cart_validated flag) ---
  const { items: repricedItems, problems } = await repriceCart(cart);

  if (problems.length > 0) {
    throw new OrderError(
      'Some items in your cart are no longer available at the expected price or quantity. Please review your cart.',
      409,
      problems
    );
  }
  if (repricedItems.length === 0) {
    throw new OrderError('No orderable items in cart.');
  }

  // --- Deals and offers, resolved server-side ---
  const dealOffers = new Map();
  if (Array.isArray(deal_items) && deal_items.length > 0) {
    const offerIds = [...new Set(deal_items.map((d) => d.offer_id).filter(Boolean))];
    const offers = await Offer.find({ _id: { $in: offerIds } });
    offers.forEach((o) => dealOffers.set(o._id.toString(), o));
  }

  const { orderItems, applied: dealItemsApplied, savings: dealSavings } = applyDeals(
    repricedItems,
    deal_items,
    dealOffers,
    storeCode
  );

  const subtotal = round2(orderItems.reduce((sum, item) => sum + item.total_price, 0));

  const cartOffer = offer_id ? await Offer.findById(offer_id) : null;
  const { discountAmount, appliedOffer } = applyCartOffer(cartOffer, subtotal, storeCode);

  // --- Delivery charge, recomputed (client value ignored) ---
  const { charges: deliveryCharges, distanceKm } = await resolveDeliveryCharges(
    storeCode,
    deliveryAddress,
    subtotal
  );

  // --- Loyalty reward voucher discount, computed server-side against the
  // now-known subtotal/delivery charges - never trust a client-supplied
  // amount for this. Stacks with a cart offer (independent mechanisms); the
  // FREE_PRODUCT/SPECIAL_OFFER types return invalid:true and are fulfilled
  // manually, so they never affect the total here.
  let loyaltyDiscountAmount = 0;
  let appliedLoyaltyRedemption = null;
  if (loyaltyRedemption) {
    const preview = previewRedemptionDiscount(loyaltyRedemption, {
      orderSubtotal: round2(subtotal - discountAmount),
      deliveryCharges,
    });
    if (!preview.valid) {
      throw new OrderError(preview.reason || 'This reward voucher cannot be applied to this order', 400);
    }
    loyaltyDiscountAmount = preview.discountAmount;
    appliedLoyaltyRedemption = {
      redemption_id: loyaltyRedemption._id.toString(),
      reward_name: loyaltyRedemption.rewardSnapshot.name,
      discount_amount: loyaltyDiscountAmount,
    };
  }

  const totalDiscount = round2(discountAmount + loyaltyDiscountAmount);

  // Tax is inside `subtotal`, so it is reported, not added. Adding it here is
  // what made the payable total disagree with the amount the shopper was shown
  // and actually paid — see the note on TAX_RATE.
  const totalAmount = round2(subtotal + deliveryCharges - totalDiscount);
  const taxAmount = includedTax(subtotal - totalDiscount);

  // --- Payment, verified against the gateway ---
  const { paymentStatus, transactionId, verifiedPayment } = await resolvePaymentStatus({
    paymentMode,
    paymentDetails: payment_details,
    totalAmount,
    project,
  });

  const totalQuantity = orderItems.reduce((sum, item) => sum + item.quantity, 0);

  const buildOrder = (orderNumber) => ({
    order_number: orderNumber,
    mobile_no: userMobile,
    customer_info: {
      name: user.name || '',
      email: user.email || '',
    },
    store_code: storeCode,
    // Tenancy comes from the resolved tenant, not from the request body.
    project_code: project?.project_code || '',
    order_items: orderItems,
    delivery_info: {
      delivery_date: deliveryDateObj,
      delivery_slot_id: deliverySlot.iddelivery_slot,
      delivery_slot_from: deliverySlot.delivery_slot_from,
      delivery_slot_to: deliverySlot.delivery_slot_to,
      delivery_address: {
        full_name: deliveryAddress.full_name,
        mobile_number: deliveryAddress.mobile_number,
        email_id: deliveryAddress.email_id,
        line_1: deliveryAddress.delivery_addr_line_1,
        line_2: deliveryAddress.delivery_addr_line_2,
        city: deliveryAddress.delivery_addr_city,
        pincode: deliveryAddress.delivery_addr_pincode,
        latitude: deliveryAddress.latitude,
        longitude: deliveryAddress.longitude,
        area_id: deliveryAddress.area_id,
      },
    },
    payment_info: {
      payment_mode_id: paymentMode.idpayment_mode,
      payment_mode_name: paymentMode.payment_mode_name,
      payment_status: paymentStatus,
      transaction_id: transactionId,
      // Only the gateway-confirmed facts are persisted — never the raw
      // client-supplied payment_details blob.
      payment_details: verifiedPayment || {},
    },
    order_summary: {
      subtotal,
      delivery_charges: deliveryCharges,
      delivery_distance_km: distanceKm,
      tax_amount: taxAmount,
      discount_amount: totalDiscount,
      total_amount: totalAmount,
      total_items: orderItems.length,
      total_quantity: totalQuantity,
      applied_offer: appliedOffer || undefined,
      applied_loyalty_redemption: appliedLoyaltyRedemption || undefined,
      deal_items_applied: dealItemsApplied.length > 0 ? dealItemsApplied : undefined,
      deal_savings: dealSavings || undefined,
    },
    order_notes: order_notes || '',
    estimated_delivery_date: deliveryDateObj,
  });

  // --- Persist: order + cart clear, atomically ---
  // generateOrderNumber reads the last order and adds one, so two concurrent
  // orders can pick the same number. The unique index catches it; retry.
  let lastError;

  for (let attempt = 0; attempt < ORDER_NUMBER_RETRIES; attempt += 1) {
    try {
      /* eslint-disable no-await-in-loop */
      return await runAtomically(async (session) => {
        const orderNumber = await Order.generateOrderNumber();
        const order = new Order(buildOrder(orderNumber));

        const savedOrder = await order.save({ session });

        if (loyaltyRedemption) {
          await markRedemptionUsed(loyaltyRedemption, savedOrder._id, session);
        }

        await Cart.updateOne(
          { mobile_no: userMobile },
          {
            items: [],
            subtotal: 0,
            total_items: 0,
            total_quantity: 0,
            last_updated: new Date(),
          },
          { session }
        );

        return savedOrder;
      });
      /* eslint-enable no-await-in-loop */
    } catch (error) {
      const isDuplicateOrderNumber =
        error.code === 11000 &&
        (error.keyPattern?.order_number || /order_number/.test(error.message || ''));

      if (!isDuplicateOrderNumber) {
        throw error;
      }

      lastError = error;
      console.warn(`Order number collision (attempt ${attempt + 1}), retrying.`);
    }
  }

  throw new OrderError(
    'Could not allocate an order number. Please try again.',
    503,
    lastError?.message
  );
};

module.exports = {
  placeOrder,
  OrderError,
  // exported for tests
  repriceCart,
  applyCartOffer,
  resolveDeliveryCharges,
};
