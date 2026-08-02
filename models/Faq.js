const mongoose = require('mongoose');

// A single question/answer, grouped under a heading.
//
// Structured rather than a slice of the `faq` content page's HTML: the mobile
// FAQ screen searches across questions and answers and renders each one as an
// expandable row. Flat HTML would have cost both, so the page stays for clients
// that only need prose and this drives the app.
const faqSchema = new mongoose.Schema(
  {
    question: {
      type: String,
      required: [true, 'Question is required'],
      trim: true,
    },
    answer: {
      type: String,
      required: [true, 'Answer is required'],
      trim: true,
    },
    // Heading the question is listed under, e.g. "Orders & Delivery".
    // Free text rather than an enum so a tenant can organise its own way.
    category: {
      type: String,
      default: 'General',
      trim: true,
      index: true,
    },
    // Ascending display order within a category. Ties fall back to creation order.
    sequence: {
      type: Number,
      default: 0,
      index: true,
    },
    is_active: {
      type: Boolean,
      default: true,
      index: true,
    },
    // Empty/absent means every store in the tenant, which is the common case —
    // an FAQ is rarely store-specific, but a tenant with very different
    // formats per store can scope one.
    store_codes: {
      type: [String],
      default: undefined,
    },
  },
  { timestamps: true, collection: 'faqs' }
);

// The list endpoint always sorts this way; the index keeps it off a collscan
// as the set grows.
faqSchema.index({ is_active: 1, category: 1, sequence: 1 });

module.exports = require('./tenantModel')('Faq', faqSchema);
