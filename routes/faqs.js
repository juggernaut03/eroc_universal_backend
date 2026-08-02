const express = require('express');
const router = express.Router();
const Faq = require('../models/Faq');

// Public FAQ feed for the mobile app and PWA.
//
// Returns questions already grouped by category and ordered, because every
// client renders them that way — doing it here means one implementation rather
// than one per client, and the ordering an admin sets is the ordering shoppers
// see everywhere.

/**
 * @route   GET /api/faqs
 * @desc    Active FAQs, grouped by category
 * @access  Public
 * @query   store_code (optional) — include FAQs scoped to that store
 */
router.get('/', async (req, res, next) => {
  try {
    const storeCode = String(req.query.store_code || '').trim();

    const query = { is_active: true };
    if (storeCode) {
      // Unscoped FAQs apply everywhere; scoped ones only to their stores.
      query.$or = [
        { store_codes: { $exists: false } },
        { store_codes: { $size: 0 } },
        { store_codes: storeCode },
      ];
    }

    // Sorted by `sequence` alone, NOT by category first: sorting on category
    // alphabetises the groups, which silently overrides the order an admin
    // arranged them in ("Account" ahead of "General"). Sequence is assigned
    // across the whole list, so ordering by it produces both the group order
    // and the order within each group.
    const faqs = await Faq.find(query)
      .select('question answer category sequence -_id')
      .sort({ sequence: 1, createdAt: 1 })
      .lean();

    // Preserve first-seen category order so `sequence` controls the grouping
    // too, rather than categories being alphabetised behind the admin's back.
    const groups = [];
    const byTitle = new Map();
    for (const faq of faqs) {
      const title = faq.category || 'General';
      if (!byTitle.has(title)) {
        const group = { title, faqs: [] };
        byTitle.set(title, group);
        groups.push(group);
      }
      byTitle.get(title).faqs.push({ question: faq.question, answer: faq.answer });
    }

    res.status(200).json({
      success: true,
      count: faqs.length,
      data: groups,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
