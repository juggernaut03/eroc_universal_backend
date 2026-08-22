const express = require('express');
const router = express.Router();
const AddressBook = require('../models/AddressBook');
const { protect } = require('../middleware/auth');
const { resolveAddressCoordinates, validatePincodeDistance } = require('../utils/geocoding');

/**
 * @route   POST /api/addresses/add-address
 * @desc    Add a new address
 * @access  Private (requires JWT token)
 * @body    { "store_code": "AVB", "project_code": "PROJ001", "full_name": "John Doe", "mobile_number": "9876543210", "email_id": "john@example.com", "delivery_addr_line_1": "123 Main St", "delivery_addr_line_2": "Apt 4B", "delivery_addr_city": "Mumbai", "delivery_addr_pincode": "400001", "is_default": "No", "latitude": "19.0760", "longitude": "72.8777", "area_id": "Downtown" }
 * @header  Authorization: Bearer <jwt_token>
 */
router.post('/add-address', protect, async (req, res, next) => {
  try {
    const {
      store_code,
      project_code,
      full_name,
      mobile_number,
      email_id,
      delivery_addr_line_1,
      delivery_addr_line_2,
      delivery_addr_city,
      delivery_addr_pincode,
      is_default,
      latitude,
      longitude,
      area_id
    } = req.body;

    // Validate required fields
    // store_code is accepted but not required — addresses are per-customer

    // Get mobile number from JWT token instead of request body
    const userMobile = req.user.mobile;
    
    if (!full_name || full_name.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'full_name is required'
      });
    }
    
    // email is optional for delivery addresses (mobile app does not collect it)
    
    if (!delivery_addr_line_1 || delivery_addr_line_1.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'delivery_addr_line_1 is required'
      });
    }
    
    if (!delivery_addr_city || delivery_addr_city.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'delivery_addr_city is required'
      });
    }
    
    if (!delivery_addr_pincode || delivery_addr_pincode.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'delivery_addr_pincode is required'
      });
    }
    
    // Generate next address book ID using counter (starts from 1 and increments)
    const nextId = await AddressBook.generateNextId();
    
    // If this is set as default, make all other addresses for this user non-default
    if (is_default === 'Yes') {
      await AddressBook.updateMany(
        { mobile_number: userMobile },
        { is_default: 'No' }
      );
    }

    // Resolve and validate coordinates
    const resolved = await resolveAddressCoordinates({
      latitude,
      longitude,
      delivery_addr_line_1,
      delivery_addr_city,
      delivery_addr_pincode,
    });

    if (!resolved) {
      return res.status(400).json({
        success: false,
        error: 'Valid delivery location is required. Please confirm your location on the map.',
      });
    }

    // Nominatim's Indian postcode centroids are too coarse to hard-block on —
    // MyNeedMart's own registered store coordinates measured 17.8km from
    // their own pincode's geocoded centroid, so every real address in that
    // pincode was being rejected (12 attempts, 0 saved, before this fix).
    // The helper's own doc says "warn", so warn: log it and let the save
    // through rather than failing the request on a third-party geocoder's
    // imprecision.
    const pinCheck = await validatePincodeDistance(
      resolved.latitude,
      resolved.longitude,
      delivery_addr_pincode.trim()
    );
    if (!pinCheck.ok) {
      console.warn(`[address-crud] add-address: ${pinCheck.warning}`);
    }

    // Create new address
    const newAddress = new AddressBook({
      idaddress_book: nextId,
      full_name: full_name.trim(),
      mobile_number: userMobile,
      email_id: (email_id || '').trim().toLowerCase(),
      delivery_addr_line_1: delivery_addr_line_1.trim(),
      delivery_addr_line_2: delivery_addr_line_2 ? delivery_addr_line_2.trim() : '',
      delivery_addr_city: delivery_addr_city.trim(),
      delivery_addr_pincode: delivery_addr_pincode.trim(),
      is_default: is_default || 'No',
      latitude: String(resolved.latitude),
      longitude: String(resolved.longitude),
      area_id: area_id ? area_id.trim() : ''
    });
    
    const savedAddress = await newAddress.save();
    
    // Format response data
    const addressData = {
      id: savedAddress._id,
      idaddress_book: savedAddress.idaddress_book,
      full_name: savedAddress.full_name,
      mobile_number: savedAddress.mobile_number,
      email_id: savedAddress.email_id,
      delivery_addr_line_1: savedAddress.delivery_addr_line_1,
      delivery_addr_line_2: savedAddress.delivery_addr_line_2,
      delivery_addr_city: savedAddress.delivery_addr_city,
      delivery_addr_pincode: savedAddress.delivery_addr_pincode,
      is_default: savedAddress.is_default,
      latitude: savedAddress.latitude,
      longitude: savedAddress.longitude,
      area_id: savedAddress.area_id
    };
    
    res.status(201).json({
      success: true,
      message: 'Address added successfully',
      store_code: (store_code || '').trim(),
      project_code: project_code,
      data: addressData
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PUT /api/addresses/update-address/:id
 * @desc    Update an existing address
 * @access  Private (requires JWT token)
 * @body    { "store_code": "AVB", "project_code": "PROJ001", "full_name": "John Doe Updated", ... }
 * @header  Authorization: Bearer <jwt_token>
 */
router.put('/update-address/:id', protect, async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      store_code,
      project_code,
      full_name,
      mobile_number,
      email_id,
      delivery_addr_line_1,
      delivery_addr_line_2,
      delivery_addr_city,
      delivery_addr_pincode,
      is_default,
      latitude,
      longitude,
      area_id
    } = req.body;

    // Validate required fields
    // store_code is accepted but not required — addresses are per-customer

    // Get mobile number from JWT token
    const userMobile = req.user.mobile;
    
    // Find the address to update
    const address = await AddressBook.findById(id);

    if (!address) {
      return res.status(404).json({
        success: false,
        error: 'Address not found'
      });
    }

    // Check if the address belongs to the authenticated user
    if (address.mobile_number !== userMobile) {
      return res.status(403).json({
        success: false,
        error: 'You can only update your own addresses'
      });
    }

    // If this is set as default, make all other addresses for this user non-default
    if (is_default === 'Yes') {
      await AddressBook.updateMany(
        { mobile_number: userMobile, _id: { $ne: id } },
        { is_default: 'No' }
      );
    }
    
    const line1 = delivery_addr_line_1 || address.delivery_addr_line_1;
    const city = delivery_addr_city || address.delivery_addr_city;
    const pincode = delivery_addr_pincode || address.delivery_addr_pincode;
    const latInput = latitude !== undefined ? latitude : address.latitude;
    const lonInput = longitude !== undefined ? longitude : address.longitude;

    const resolved = await resolveAddressCoordinates({
      latitude: latInput,
      longitude: lonInput,
      delivery_addr_line_1: line1,
      delivery_addr_city: city,
      delivery_addr_pincode: pincode,
    });

    if (!resolved) {
      return res.status(400).json({
        success: false,
        error: 'Valid delivery location is required. Please confirm your location on the map.',
      });
    }

    // See the matching comment in add-address above: warn, don't reject.
    const pinCheck = await validatePincodeDistance(
      resolved.latitude,
      resolved.longitude,
      pincode
    );
    if (!pinCheck.ok) {
      console.warn(`[address-crud] update-address: ${pinCheck.warning}`);
    }

    // Update address fields
    const updateData = {};
    if (full_name) updateData.full_name = full_name.trim();
    if (email_id) updateData.email_id = email_id.trim().toLowerCase();
    if (delivery_addr_line_1) updateData.delivery_addr_line_1 = delivery_addr_line_1.trim();
    if (delivery_addr_line_2 !== undefined) updateData.delivery_addr_line_2 = delivery_addr_line_2.trim();
    if (delivery_addr_city) updateData.delivery_addr_city = delivery_addr_city.trim();
    if (delivery_addr_pincode) updateData.delivery_addr_pincode = delivery_addr_pincode.trim();
    if (is_default) updateData.is_default = is_default;
    updateData.latitude = String(resolved.latitude);
    updateData.longitude = String(resolved.longitude);
    if (area_id !== undefined) updateData.area_id = area_id.trim();
    
    const updatedAddress = await AddressBook.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );
    
    // Format response data
    const addressData = {
      id: updatedAddress._id,
      idaddress_book: updatedAddress.idaddress_book,
      full_name: updatedAddress.full_name,
      mobile_number: updatedAddress.mobile_number,
      email_id: updatedAddress.email_id,
      delivery_addr_line_1: updatedAddress.delivery_addr_line_1,
      delivery_addr_line_2: updatedAddress.delivery_addr_line_2,
      delivery_addr_city: updatedAddress.delivery_addr_city,
      delivery_addr_pincode: updatedAddress.delivery_addr_pincode,
      is_default: updatedAddress.is_default,
      latitude: updatedAddress.latitude,
      longitude: updatedAddress.longitude,
      area_id: updatedAddress.area_id
    };
    
    res.status(200).json({
      success: true,
      message: 'Address updated successfully',
      store_code: (store_code || '').trim(),
      project_code: project_code,
      data: addressData
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   DELETE /api/addresses/delete-address/:id
 * @desc    Delete an address
 * @access  Private (requires JWT token)
 * @body    { "store_code": "AVB", "project_code": "PROJ001" }
 * @header  Authorization: Bearer <jwt_token>
 */
router.delete('/delete-address/:id', protect, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { store_code, project_code } = req.body;

    // Validate required fields
    // store_code is accepted but not required — addresses are per-customer

    // Get mobile number from JWT token
    const userMobile = req.user.mobile;
    
    // Find the address to delete
    const address = await AddressBook.findById(id);

    if (!address) {
      return res.status(404).json({
        success: false,
        error: 'Address not found'
      });
    }

    // Check if the address belongs to the authenticated user
    if (address.mobile_number !== userMobile) {
      return res.status(403).json({
        success: false,
        error: 'You can only delete your own addresses'
      });
    }

    // Delete the address
    await AddressBook.findByIdAndDelete(id);
    
    res.status(200).json({
      success: true,
      message: 'Address deleted successfully',
      store_code: (store_code || '').trim(),
      project_code: project_code,
      deleted_address_id: address.idaddress_book
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/addresses/get-addresses
 * @desc    Get addresses for the authenticated user
 * @access  Private (requires JWT token)
 * @body    { "store_code": "AVB", "project_code": "PROJ001" }
 * @header  Authorization: Bearer <jwt_token>
 */
router.post('/get-addresses', protect, async (req, res, next) => {
  try {
    const { store_code, project_code } = req.body;

    // Validate required fields
    // store_code is accepted but not required — addresses are per-customer

    // Get mobile number from JWT token
    const userMobile = req.user.mobile;
    
    // Find addresses by mobile number from JWT token
    const addresses = await AddressBook.findByMobileNumber(userMobile);

    if (!addresses || addresses.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: `No addresses found for mobile number: ${userMobile}`,
        store_code: (store_code || '').trim(),
        project_code: project_code,
        mobile_number: userMobile,
        data: []
      });
    }
    
    // Format response data
    const addressesData = addresses.map(address => ({
      id: address._id,
      idaddress_book: address.idaddress_book,
      full_name: address.full_name,
      mobile_number: address.mobile_number,
      email_id: address.email_id,
      delivery_addr_line_1: address.delivery_addr_line_1,
      delivery_addr_line_2: address.delivery_addr_line_2,
      delivery_addr_city: address.delivery_addr_city,
      delivery_addr_pincode: address.delivery_addr_pincode,
      is_default: address.is_default,
      latitude: address.latitude,
      longitude: address.longitude,
      area_id: address.area_id
    }));
    
    res.status(200).json({
      success: true,
      count: addressesData.length,
      message: `Found ${addressesData.length} address(es) for mobile number: ${userMobile}`,
      store_code: (store_code || '').trim(),
      project_code: project_code,
      mobile_number: userMobile,
      data: addressesData
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/address-crud/init-counter
 * @desc    Initialize address book counter to start from 1
 * @access  Private (requires JWT token)
 * @header  Authorization: Bearer <jwt_token>
 */
router.post('/init-counter', protect, async (req, res, next) => {
  try {
    const Counter = require('../models/Counter');

    // Initialize counter to start from 1
    const currentValue = await Counter.initializeCounter('address_book_id', 1);

    res.status(200).json({
      success: true,
      message: 'Address book counter initialized',
      counter_name: 'address_book_id',
      current_value: currentValue,
      next_id_will_be: currentValue + 1
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/address-crud/reset-counter
 * @desc    Reset address book counter to 0 (for testing)
 * @access  Private (requires JWT token)
 * @header  Authorization: Bearer <jwt_token>
 */
router.post('/reset-counter', protect, async (req, res, next) => {
  try {
    const Counter = require('../models/Counter');

    // Reset counter to 0
    const currentValue = await Counter.resetCounter('address_book_id', 0);

    res.status(200).json({
      success: true,
      message: 'Address book counter reset to 0',
      counter_name: 'address_book_id',
      current_value: currentValue,
      next_id_will_be: currentValue + 1
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/addresses
 * @desc    Get all addresses
 * @access  Public
 */
router.get('/', async (req, res, next) => {
  try {
    const addresses = await AddressBook.findAllSorted();
    
    if (!addresses || addresses.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        message: 'No addresses found',
        data: []
      });
    }
    
    // Format response data
    const addressesData = addresses.map(address => ({
      id: address._id,
      idaddress_book: address.idaddress_book,
      full_name: address.full_name,
      mobile_number: address.mobile_number,
      email_id: address.email_id,
      delivery_addr_line_1: address.delivery_addr_line_1,
      delivery_addr_line_2: address.delivery_addr_line_2,
      delivery_addr_city: address.delivery_addr_city,
      delivery_addr_pincode: address.delivery_addr_pincode,
      is_default: address.is_default,
      latitude: address.latitude,
      longitude: address.longitude,
      area_id: address.area_id
    }));
    
    res.status(200).json({
      success: true,
      count: addressesData.length,
      message: `Found ${addressesData.length} address(es)`,
      data: addressesData
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
