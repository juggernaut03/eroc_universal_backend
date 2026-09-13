const express = require('express');
const multer = require('multer');
const router = express.Router();
const DigitalCartItem = require('../../models/DigitalCartItem');
const DigitalCartSettings = require('../../models/DigitalCartSettings');
const { getTenantDb } = require('../../config/database');
const { checkPermission } = require('../../middleware/checkPermission');
const { parseDigitalCartCsv } = require('../../utils/digitalCartCsv');
const { buildGroups } = require('../../utils/digitalCartGroups');

const HEX_COLOR = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const SETTINGS_TEXT_FIELDS = ['header_title', 'tagline', 'footer_note', 'logo_url', 'home_heading', 'info_sub_text', 'valid_till_text', 'about_url'];
const SETTINGS_COLOR_FIELDS = ['primary_color', 'accent_color', 'background_color', 'card_color', 'text_color'];
const SETTINGS_BOOL_FIELDS = ['show_discount_percent', 'show_product_code', 'show_search', 'show_last_updated', 'show_logo', 'show_bottom_nav'];
const SETTINGS_NUMBER_FIELDS = [{ name: 'card_radius', min: 0, max: 40 }];
// Per-offer-group tile overrides — slugs match the website's offer groups
// Groups are dynamic (one per distinct Offer value in the sheet), so
// override keys are validated by shape, not against a fixed list
const GROUP_STYLE_KEY = /^[a-z0-9_]{1,60}$/;
const GROUP_STYLE_MAX_KEYS = 200;
const GROUP_STYLE_FIELDS = ['color', 'label', 'line1', 'line2', 'ribbon'];
const GROUP_STYLE_URL_FIELDS = ['banner_image_url'];

// CSV stays in memory — it is parsed and discarded, only rows are stored
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isCsv = /\.csv$/i.test(file.originalname || '') ||
      ['text/csv', 'application/vnd.ms-excel', 'text/plain'].includes(file.mimetype);
    if (!isCsv) {
      return cb(new Error('Only .csv files are allowed'));
    }
    cb(null, true);
  }
});

// @route   GET /api/admin/digital-cart
// @desc    List all digital cart items (current published sheet)
// @access  Admin (digitalCart:view)
router.get('/', checkPermission('digitalCart', 'view'), async (req, res) => {
  try {
    const items = await DigitalCartItem.find({}).sort({ position: 1 });
    const latest = items.reduce(
      (acc, item) => (!acc || item.updatedAt > acc.updatedAt ? item : acc),
      null
    );

    res.status(200).json({
      success: true,
      data: items,
      meta: {
        total: items.length,
        active: items.filter((i) => i.is_active).length,
        source_file: latest ? latest.source_file : null,
        last_uploaded_at: latest ? latest.createdAt : null
      }
    });
  } catch (error) {
    console.error('Get digital cart error:', error);
    res.status(500).json({ success: false, message: 'Error fetching digital cart items', error: error.message });
  }
});

// @route   POST /api/admin/digital-cart/upload
// @desc    Upload offer sheet CSV — replaces ALL existing items for this project
// @access  Admin (digitalCart:create)
router.post(
  '/upload',
  checkPermission('digitalCart', 'create'),
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No CSV file uploaded (field name: "file")' });
      }

      // Resolved explicitly rather than via the ambient DigitalCartItem
      // import: for a large enough multipart upload, Node's
      // AsyncLocalStorage context (which the ambient tenant-model proxy
      // depends on) does not reliably survive multer/busboy's file-stream
      // parsing — past some size the request-scoped tenant context is lost
      // and the proxy silently falls back to the default tenant DB instead
      // of erroring. For a deleteMany({})+insertMany this is not just a
      // wrong result, it can wipe and overwrite the DEFAULT tenant's real
      // digital cart with another tenant's sheet. req.tenant is a plain
      // property set before multer ever runs, so it's unaffected — resolve
      // the model from it directly instead of trusting ALS this far in.
      const DigitalCartItemTenant = getTenantDb(req.tenant.project.db_name).models.DigitalCartItem;

      const { items, error } = parseDigitalCartCsv(req.file.buffer.toString('utf8'));
      if (error) {
        return res.status(400).json({ success: false, message: error });
      }

      const sourceFile = req.file.originalname || 'upload.csv';
      const docs = items.map((item) => ({ ...item, source_file: sourceFile }));

      await DigitalCartItemTenant.deleteMany({});
      await DigitalCartItemTenant.insertMany(docs);

      res.status(201).json({
        success: true,
        message: `Digital cart updated: ${docs.length} products imported from ${sourceFile}`,
        data: { imported: docs.length, source_file: sourceFile }
      });
    } catch (error) {
      console.error('Upload digital cart CSV error:', error);
      res.status(500).json({ success: false, message: 'Error importing CSV', error: error.message });
    }
  }
);

// @route   GET /api/admin/digital-cart/settings
// @desc    UI settings for the public digital cart site (defaults if unset)
// @access  Admin (digitalCart:view)
router.get('/settings', checkPermission('digitalCart', 'view'), async (req, res) => {
  try {
    const [settings, items] = await Promise.all([
      DigitalCartSettings.findOne({}),
      DigitalCartItem.find({}).sort({ position: 1 }).select('offer_text')
    ]);
    const data = settings || new DigitalCartSettings().toObject();
    res.status(200).json({
      success: true,
      data,
      // Offer groups present in the currently uploaded sheet, with their
      // effective style + derived defaults (panel placeholders) — nothing
      // about group visuals is hardcoded client-side
      groups: buildGroups(items, data.group_styles)
    });
  } catch (error) {
    console.error('Get digital cart settings error:', error);
    res.status(500).json({ success: false, message: 'Error fetching settings', error: error.message });
  }
});

// @route   PUT /api/admin/digital-cart/settings
// @desc    Update UI settings (whitelisted fields, hex-validated colors)
// @access  Admin (digitalCart:edit)
router.put('/settings', checkPermission('digitalCart', 'edit'), async (req, res) => {
  try {
    const updates = {};

    for (const field of SETTINGS_TEXT_FIELDS) {
      if (typeof req.body[field] === 'string') {
        updates[field] = req.body[field].trim();
      }
    }

    for (const field of SETTINGS_COLOR_FIELDS) {
      if (typeof req.body[field] === 'string') {
        const value = req.body[field].trim();
        if (value && !HEX_COLOR.test(value)) {
          return res.status(400).json({ success: false, message: `${field} must be a hex color like #RRGGBB (or empty)` });
        }
        updates[field] = value;
      }
    }

    for (const field of SETTINGS_BOOL_FIELDS) {
      if (typeof req.body[field] === 'boolean') {
        updates[field] = req.body[field];
      }
    }

    if (req.body.group_styles && typeof req.body.group_styles === 'object') {
      const clean = {};
      for (const key of Object.keys(req.body.group_styles).slice(0, GROUP_STYLE_MAX_KEYS)) {
        if (!GROUP_STYLE_KEY.test(key)) continue;
        const entry = req.body.group_styles[key];
        if (!entry || typeof entry !== 'object') continue;
        const cleanEntry = {};
        for (const field of GROUP_STYLE_FIELDS) {
          if (typeof entry[field] === 'string') {
            cleanEntry[field] = entry[field].trim().slice(0, 60);
          }
        }
        for (const field of GROUP_STYLE_URL_FIELDS) {
          if (typeof entry[field] === 'string') {
            cleanEntry[field] = entry[field].trim().slice(0, 500);
          }
        }
        if (cleanEntry.color && !HEX_COLOR.test(cleanEntry.color)) {
          return res.status(400).json({ success: false, message: `group_styles.${key}.color must be a hex color like #RRGGBB (or empty)` });
        }
        clean[key] = cleanEntry;
      }
      updates.group_styles = clean;
    }

    for (const { name, min, max } of SETTINGS_NUMBER_FIELDS) {
      if (req.body[name] !== undefined) {
        const value = Number(req.body[name]);
        if (!Number.isFinite(value) || value < min || value > max) {
          return res.status(400).json({ success: false, message: `${name} must be a number between ${min} and ${max}` });
        }
        updates[name] = value;
      }
    }

    const settings = await DigitalCartSettings.findOneAndUpdate(
      {},
      { $set: updates },
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true }
    );

    res.status(200).json({
      success: true,
      message: 'Digital cart UI settings saved',
      data: settings
    });
  } catch (error) {
    console.error('Update digital cart settings error:', error);
    res.status(500).json({ success: false, message: 'Error saving settings', error: error.message });
  }
});

// @route   PATCH /api/admin/digital-cart/:id/toggle
// @desc    Toggle a single item's visibility on the public site
// @access  Admin (digitalCart:edit)
router.patch('/:id/toggle', checkPermission('digitalCart', 'edit'), async (req, res) => {
  try {
    const item = await DigitalCartItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }

    item.is_active = !item.is_active;
    await item.save();

    res.status(200).json({
      success: true,
      message: `Item ${item.is_active ? 'shown' : 'hidden'}`,
      data: item
    });
  } catch (error) {
    console.error('Toggle digital cart item error:', error);
    res.status(500).json({ success: false, message: 'Error toggling item', error: error.message });
  }
});

// @route   PATCH /api/admin/digital-cart/:id/image
// @desc    Set/clear a single item's product image
// @access  Admin (digitalCart:edit)
router.patch('/:id/image', checkPermission('digitalCart', 'edit'), async (req, res) => {
  try {
    if (typeof req.body.image_url !== 'string') {
      return res.status(400).json({ success: false, message: 'image_url (string) is required — empty string clears the image' });
    }
    const item = await DigitalCartItem.findByIdAndUpdate(
      req.params.id,
      { $set: { image_url: req.body.image_url.trim().slice(0, 500) } },
      { new: true }
    );
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }
    res.status(200).json({ success: true, message: 'Product image updated', data: item });
  } catch (error) {
    console.error('Update digital cart item image error:', error);
    res.status(500).json({ success: false, message: 'Error updating image', error: error.message });
  }
});

// @route   DELETE /api/admin/digital-cart/:id
// @desc    Delete a single item
// @access  Admin (digitalCart:delete)
router.delete('/:id', checkPermission('digitalCart', 'delete'), async (req, res) => {
  try {
    const item = await DigitalCartItem.findByIdAndDelete(req.params.id);
    if (!item) {
      return res.status(404).json({ success: false, message: 'Item not found' });
    }
    res.status(200).json({ success: true, message: 'Item deleted' });
  } catch (error) {
    console.error('Delete digital cart item error:', error);
    res.status(500).json({ success: false, message: 'Error deleting item', error: error.message });
  }
});

// @route   DELETE /api/admin/digital-cart
// @desc    Clear the whole digital cart for this project
// @access  Admin (digitalCart:delete)
router.delete('/', checkPermission('digitalCart', 'delete'), async (req, res) => {
  try {
    const result = await DigitalCartItem.deleteMany({});
    res.status(200).json({
      success: true,
      message: `Digital cart cleared (${result.deletedCount} items removed)`
    });
  } catch (error) {
    console.error('Clear digital cart error:', error);
    res.status(500).json({ success: false, message: 'Error clearing digital cart', error: error.message });
  }
});

module.exports = router;
