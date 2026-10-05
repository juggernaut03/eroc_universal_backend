const express = require('express');
const router = express.Router();
const Store = require('../models/Store');
const Pincode = require('../models/Pincode');

/**
 * @route   POST /api/stores/by-pincode
 * @desc    Get the store(s) serving a pincode (includes both enabled and
 *          disabled stores)
 * @access  Public
 * @body    { "pincode": "421002" }
 * @response Returns every store assigned to this pincode, each with
 *           is_enabled indicating status ("Enabled" or "Disabled"). A
 *           pincode can be served by more than one store (Pincode.store_codes
 *           — see models/Pincode.js); when there's more than one, the client
 *           is expected to let the customer choose.
 */
router.post('/by-pincode', async (req, res, next) => {
  try {
    const { pincode } = req.body;

    // Validate pincode is provided
    if (!pincode) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a pincode'
      });
    }

    // Validate pincode format
    if (!/^\d{6}$/.test(pincode)) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid 6-digit pincode'
      });
    }

    // Resolve which store(s) this pincode is assigned to.
    const pincodeRecord = await Pincode.findOne({ pincode }).lean();

    if (!pincodeRecord || !pincodeRecord.store_codes || pincodeRecord.store_codes.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: 'No stores found for this pincode',
        pincode: pincode,
        data: []
      });
    }

    const stores = await Store.find({ store_code: { $in: pincodeRecord.store_codes } });

    if (!stores || stores.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: 'No stores found for this pincode',
        pincode: pincode,
        data: []
      });
    }

    // Format response data
    const storesData = stores.map(store => ({
      id: store._id,
      pincode: pincode,
      store_name: store.mobile_outlet_name,
      store_code: store.store_code,
      address: store.store_address,
      min_order_amount: store.min_order_amount,
      store_open_time: store.store_open_time,
      delivery_time: store.store_delivery_time,
      delivery_start_offset_days: store.delivery_start_offset_days ?? 0,
      offer: store.store_offer_name,
      location: {
        latitude: store.latitude,
        longitude: store.longitude
      },
      delivery_options: {
        home_delivery: store.home_delivery === 'yes',
        self_pickup: store.self_pickup === 'yes',
        packing_fee_enabled_for_pickup: store.packing_fee_enabled_for_pickup === true
      },
      contact: {
        phone: store.contact_number,
        email: store.email,
        whatsapp: store.whatsappnumber
      },
      message: store.store_message,
      is_enabled: store.is_enabled
    }));

    res.status(200).json({
      success: true,
      count: storesData.length,
      message: `Found ${storesData.length} store(s) for pincode ${pincode}`,
      pincode: pincode,
      data: storesData
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
