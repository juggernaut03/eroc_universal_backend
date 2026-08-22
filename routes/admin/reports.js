const express = require('express');
const router = express.Router();
const Order = require('../../models/Order');
const { checkPermission } = require('../../middleware/checkPermission');
const { NON_REVENUE_STATUSES } = require('../../constants/orderStatus');

/**
 * @route   GET /api/admin/reports/procurement
 * @desc    Procurement report — total quantity of each product ordered on a
 *          given day, across every order, for restocking. Matches the
 *          legacy panel's export columns: Sr No. / P-Code / Product Name /
 *          Pack Size / Ordered Qty / Total Required Qty.
 * @access  Admin — its own 'reports' permission section (Admin Permissions
 *          in the panel), independent of 'orders'.
 * @query   date=YYYY-MM-DD (defaults to today)
 */
router.get('/procurement', checkPermission('reports', 'view'), async (req, res) => {
  try {
    const date = (req.query.date || '').trim() || new Date().toISOString().slice(0, 10);

    const startOfDay = new Date(date);
    if (Number.isNaN(startOfDay.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid date' });
    }
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    // Cancelled orders need nothing procured for them.
    const orders = await Order.find({
      order_placed_at: { $gte: startOfDay, $lt: endOfDay },
      order_status: { $nin: NON_REVENUE_STATUSES },
    })
      .select('order_items order_status')
      .lean();

    // Sum ordered quantity per product across every order placed that day.
    const byPCode = new Map();
    for (const order of orders) {
      for (const item of order.order_items || []) {
        if (!item.p_code) continue;
        const existing = byPCode.get(item.p_code);
        if (existing) {
          existing.ordered_qty += item.quantity || 0;
        } else {
          byPCode.set(item.p_code, {
            p_code: item.p_code,
            product_name: item.product_name || '',
            package_size: item.package_size || 0,
            package_unit: item.package_unit || '',
            ordered_qty: item.quantity || 0,
          });
        }
      }
    }

    const rows = Array.from(byPCode.values())
      .sort((a, b) => a.product_name.localeCompare(b.product_name))
      .map((row, index) => ({
        sr_no: index + 1,
        p_code: row.p_code,
        product_name: row.product_name,
        pack_size: [row.package_size || null, row.package_unit || null].filter(Boolean).join(' ') || '—',
        ordered_qty: row.ordered_qty,
        // Ordered Qty × pack size, in the same unit the pack is sold in —
        // e.g. 2 × 250 Gm = 500 Gm.
        total_required_qty: row.package_size
          ? `${row.package_size * row.ordered_qty} ${row.package_unit || ''}`.trim()
          : '—',
      }));

    res.status(200).json({
      success: true,
      date,
      order_count: orders.length,
      product_count: rows.length,
      data: rows,
    });
  } catch (error) {
    console.error('Procurement report error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate procurement report',
      message: error.message,
    });
  }
});

module.exports = router;
