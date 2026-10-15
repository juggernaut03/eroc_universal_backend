// Mobile number rules shared by validation and SMS.
//
// Accepts the local formats of the countries the platform serves:
//   India:    10 digits starting 6-9          e.g. 9876543210
//   Malaysia: 01x followed by 7-8 more digits  e.g. 0123456789, 01123456789

const MOBILE_REGEX = /^(?:[6-9]\d{9}|01\d{8,9})$/;

const MOBILE_MESSAGE = 'Please enter a valid mobile number';

/**
 * Convert a local mobile number to international format without "+",
 * as SMS gateways expect it.
 * @param {string} mobile Local mobile number
 * @returns {string} e.g. 60123456789 or 919876543210
 */
const toInternational = (mobile) => {
  if (/^01\d{8,9}$/.test(mobile)) return `60${mobile.slice(1)}`;
  if (/^91[6-9]\d{9}$/.test(mobile)) return mobile;
  return `91${mobile}`;
};

module.exports = { MOBILE_REGEX, MOBILE_MESSAGE, toInternational };
