// Postal code rules shared by validation.
//
// Accepts the formats of the countries the platform serves:
//   India:    6-digit pincode    e.g. 492001
//   Malaysia: 5-digit postcode   e.g. 50400, 01000

const POSTCODE_REGEX = /^\d{5,6}$/;

const POSTCODE_MESSAGE = 'Please enter a valid postcode';

module.exports = { POSTCODE_REGEX, POSTCODE_MESSAGE };
