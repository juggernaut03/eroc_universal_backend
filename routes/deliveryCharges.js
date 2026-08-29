const express = require('express');
const router = express.Router();
const Store = require('../models/Store');
const { calculateDistance, calculateDeliveryCharge, buildStoreDeliveryConfig, isValidCoordinate } = require('../utils/distanceCalculation');

// @route   POST /api/delivery-charges/calculate
// @desc    Calculate delivery distance and charges. Accepts an optional
//          fulfillment_type: 'pickup' mode, which needs no coordinates and
//          returns only the store's packing fee (mirrors the pickup branch
//          in utils/orderService.js's placeOrder, so the pre-order estimate
//          shown at checkout agrees with what placeOrder actually charges).
// @access  Public
router.post('/calculate', async (req, res) => {
  try {
    const {
      store_code,
      fulfillment_type,
      address_latitude,
      address_longitude,
      address_pincode,
      order_amount = 0
    } = req.body;

    // Validate required fields
    if (!store_code) {
      return res.status(400).json({
        success: false,
        error: 'store_code is required'
      });
    }

    const isPickup = (fulfillment_type || 'delivery').toString().trim().toLowerCase() === 'pickup';

    if (isPickup) {
      const pickupStore = await Store.findOne({ store_code: store_code.trim() }).lean();
      if (!pickupStore) {
        return res.status(404).json({ success: false, error: `Store not found: ${store_code}` });
      }
      if (pickupStore.self_pickup !== 'yes') {
        return res.status(200).json({
          success: true,
          data: {
            delivery_available: false,
            fulfillment_type: 'pickup',
            distance_km: 0,
            delivery_charge: 0,
            distance_charge: 0,
            handling_fee: 0,
            package_fee: 0,
            packing_fee: 0,
            packing_fee_enabled: false,
            total_charges: 0,
            free_delivery: false,
            reason: 'Self pickup is not available at this store',
          },
        });
      }
      const packingFeeEnabled = pickupStore.packing_fee_enabled_for_pickup === true;
      const packingFee = packingFeeEnabled ? Math.max(0, Number(pickupStore.package_fee) || 0) : 0;
      return res.status(200).json({
        success: true,
        data: {
          delivery_available: true,
          fulfillment_type: 'pickup',
          distance_km: 0,
          delivery_charge: packingFee,
          distance_charge: 0,
          handling_fee: 0,
          package_fee: 0,
          packing_fee: packingFee,
          packing_fee_enabled: packingFeeEnabled,
          total_charges: packingFee,
          free_delivery: false,
          reason: packingFeeEnabled
            ? 'Packing fee applies to self-pickup orders'
            : 'No packing fee for self-pickup orders',
        },
      });
    }

    const addrLat = parseFloat(address_latitude);
    const addrLon = parseFloat(address_longitude);

    if (!isValidCoordinate(addrLat, addrLon)) {
      return res.status(400).json({
        success: false,
        error: 'Valid address coordinates (address_latitude, address_longitude) are required'
      });
    }

    // A store has one row per serviceable pincode (pincodestoremasters),
    // each independently configurable in the admin panel under Outlet >
    // Delivery Fees — base charge, per-km rate, handling/package fees and
    // max delivery radius can all differ by pincode. Prefer the row
    // registered for the delivery address's own pincode; store_code alone
    // is ambiguous across rows and Mongo returns whichever one it finds
    // first, which silently ignored whatever the admin configured for
    // every other pincode.
    let store = null;
    if (address_pincode) {
      store = await Store.findOne({
        store_code: store_code.trim(),
        pincode: address_pincode.trim()
      }).lean();
    }
    if (!store) {
      store = await Store.findOne({ store_code: store_code.trim() }).lean();
    }

    if (!store) {
      return res.status(404).json({
        success: false,
        error: `Store not found: ${store_code}`
      });
    }

    const storeLat = parseFloat(store.latitude);
    const storeLon = parseFloat(store.longitude);

    if (!isValidCoordinate(storeLat, storeLon)) {
      return res.status(400).json({
        success: false,
        error: 'Store does not have valid coordinates configured'
      });
    }

    // Calculate distance (OSRM road distance with Haversine fallback)
    const distanceResult = await calculateDistance(addrLat, addrLon, storeLat, storeLon);

    const storeConfig = buildStoreDeliveryConfig(store);

    // Calculate delivery charge
    const chargeResult = calculateDeliveryCharge(
      distanceResult.distance,
      parseFloat(order_amount) || 0,
      storeConfig
    );

    const feeBreakdown = {
      distance_charge: chargeResult.distanceCharge || 0,
      handling_fee: chargeResult.handlingFee || 0,
      package_fee: chargeResult.packageFee || 0,
      total_charges: chargeResult.totalCharges || 0,
    };

    // Check if delivery is not available (beyond max radius)
    if (chargeResult.deliveryCharge === -1) {
      return res.status(200).json({
        success: true,
        data: {
          delivery_available: false,
          distance_km: parseFloat(distanceResult.distance.toFixed(1)),
          duration_minutes: parseFloat(distanceResult.duration.toFixed(0)),
          is_road_distance: distanceResult.isRoadDistance,
          delivery_charge: 0,
          ...feeBreakdown,
          free_delivery: false,
          reason: chargeResult.reason
        }
      });
    }

    res.status(200).json({
      success: true,
      data: {
        delivery_available: true,
        distance_km: parseFloat(distanceResult.distance.toFixed(1)),
        duration_minutes: parseFloat(distanceResult.duration.toFixed(0)),
        is_road_distance: distanceResult.isRoadDistance,
        delivery_charge: chargeResult.totalCharges,
        ...feeBreakdown,
        free_delivery: chargeResult.freeDeliveryEligible,
        reason: chargeResult.reason,
        store_coordinates: {
          latitude: storeLat,
          longitude: storeLon
        }
      }
    });
  } catch (error) {
    console.error('Delivery charges calculation error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to calculate delivery charges',
      message: error.message
    });
  }
});

module.exports = router;
