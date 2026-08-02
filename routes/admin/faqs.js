const express = require('express');
const router = express.Router();
const Faq = require('../../models/Faq');
const { checkPermission } = require('../../middleware/checkPermission');

// FAQs ride on the dynamicSection permission group, like content pages and the
// other merchandised content an admin edits.
const view = checkPermission('dynamicSection', 'view');
const create = checkPermission('dynamicSection', 'create');
const edit = checkPermission('dynamicSection', 'edit');
const remove = checkPermission('dynamicSection', 'delete');

const clean = (value) => (value === undefined || value === null ? '' : String(value).trim());

// Shared validation. Returns an error message, or null when acceptable.
const validate = ({ question, answer }) => {
  if (!clean(question)) return 'Question is required';
  if (!clean(answer)) return 'Answer is required';
  return null;
};

// @route   GET /api/admin/faqs
// @desc    Every FAQ, including inactive ones
// @access  Admin
router.get('/', view, async (req, res) => {
  try {
    const faqs = await Faq.find({}).sort({ category: 1, sequence: 1, createdAt: 1 });
    res.status(200).json({ success: true, count: faqs.length, data: faqs });
  } catch (error) {
    console.error('List FAQs error:', error);
    res.status(500).json({ success: false, message: 'Error fetching FAQs', error: error.message });
  }
});

// @route   POST /api/admin/faqs
// @desc    Create an FAQ
// @access  Admin
router.post('/', create, async (req, res) => {
  try {
    const problem = validate(req.body);
    if (problem) return res.status(400).json({ success: false, message: problem });

    const faq = await Faq.create({
      question: clean(req.body.question),
      answer: clean(req.body.answer),
      category: clean(req.body.category) || 'General',
      sequence: Number(req.body.sequence) || 0,
      is_active: req.body.is_active !== false,
      store_codes: Array.isArray(req.body.store_codes) && req.body.store_codes.length
        ? req.body.store_codes.map(clean).filter(Boolean)
        : undefined,
    });

    res.status(201).json({ success: true, message: 'FAQ created', data: faq });
  } catch (error) {
    console.error('Create FAQ error:', error);
    res.status(500).json({ success: false, message: 'Error creating FAQ', error: error.message });
  }
});

// @route   PUT /api/admin/faqs/:id
// @desc    Update an FAQ
// @access  Admin
router.put('/:id', edit, async (req, res) => {
  try {
    const problem = validate({
      question: req.body.question ?? 'x',
      answer: req.body.answer ?? 'x',
    });
    if (problem) return res.status(400).json({ success: false, message: problem });

    // Only the fields actually supplied are written, so a partial edit from the
    // panel cannot blank out a field it never showed.
    const update = {};
    if (req.body.question !== undefined) update.question = clean(req.body.question);
    if (req.body.answer !== undefined) update.answer = clean(req.body.answer);
    if (req.body.category !== undefined) update.category = clean(req.body.category) || 'General';
    if (req.body.sequence !== undefined) update.sequence = Number(req.body.sequence) || 0;
    if (req.body.is_active !== undefined) update.is_active = req.body.is_active !== false;
    if (req.body.store_codes !== undefined) {
      update.store_codes = Array.isArray(req.body.store_codes) && req.body.store_codes.length
        ? req.body.store_codes.map(clean).filter(Boolean)
        : undefined;
    }

    const faq = await Faq.findByIdAndUpdate(req.params.id, { $set: update }, {
      new: true, runValidators: true,
    });
    if (!faq) return res.status(404).json({ success: false, message: 'FAQ not found' });

    res.status(200).json({ success: true, message: 'FAQ updated', data: faq });
  } catch (error) {
    console.error('Update FAQ error:', error);
    res.status(500).json({ success: false, message: 'Error updating FAQ', error: error.message });
  }
});

// @route   PUT /api/admin/faqs/reorder
// @desc    Set the sequence of several FAQs at once
// @access  Admin
router.put('/bulk/reorder', edit, async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ success: false, message: 'items array is required' });
    }

    await Promise.all(items.map((item) =>
      Faq.updateOne({ _id: item.id }, { $set: { sequence: Number(item.sequence) || 0 } })
    ));

    res.status(200).json({ success: true, message: `Reordered ${items.length} FAQ(s)` });
  } catch (error) {
    console.error('Reorder FAQs error:', error);
    res.status(500).json({ success: false, message: 'Error reordering FAQs', error: error.message });
  }
});

// @route   DELETE /api/admin/faqs/:id
// @desc    Delete an FAQ
// @access  Admin
router.delete('/:id', remove, async (req, res) => {
  try {
    const faq = await Faq.findByIdAndDelete(req.params.id);
    if (!faq) return res.status(404).json({ success: false, message: 'FAQ not found' });
    res.status(200).json({ success: true, message: 'FAQ deleted' });
  } catch (error) {
    console.error('Delete FAQ error:', error);
    res.status(500).json({ success: false, message: 'Error deleting FAQ', error: error.message });
  }
});

module.exports = router;
