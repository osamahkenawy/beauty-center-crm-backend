/**
 * Barcode & QR Code route
 * 
 * GET  /barcodes/product/:id          → Code128 barcode PNG for product
 * GET  /barcodes/product/:id/qr       → QR code PNG for product
 * GET  /barcodes/giftcard/:id/qr      → QR code PNG for gift card (encodes the redeemable code)
 * GET  /barcodes/appointment/:id/qr   → QR code PNG for appointment check-in
 * GET  /barcodes/lookup?code=XXX      → Universal lookup: barcode/SKU/gift-card code → returns entity info
 * POST /barcodes/scan                 → Record a scan event (for analytics / hardware scanner webhook)
 */

import express from 'express';
import bwipjs from 'bwip-js';
import QRCode from 'qrcode';
import { query } from '../lib/database.js';
import { authMiddleware, verifyToken } from '../middleware/auth.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Image endpoints also accept ?token= query param because
// browser <img src="..."> cannot send Authorization headers.
// ─────────────────────────────────────────────────────────────
async function imageAuthMiddleware(req, res, next) {
  // Inject query token into Authorization header if provided
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  return authMiddleware(req, res, next);
}

// Image routes use imageAuthMiddleware; API routes use plain authMiddleware
// We'll apply at the route level below.

// ─────────────────────────────────────────────────────────────
// Helper: generate Code128 barcode PNG buffer
// ─────────────────────────────────────────────────────────────
async function generateBarcode128(text, opts = {}) {
  return bwipjs.toBuffer({
    bcid:        'code128',
    text:        String(text),
    scale:       3,
    height:      12,          // mm
    width:       opts.width || 60,
    includetext: true,
    textxalign:  'center',
    textyoffset: 2,
    backgroundcolor: 'ffffff',
    barcolor: '000000',
    textsize: 10,
    ...opts,
  });
}

// ─────────────────────────────────────────────────────────────
// Helper: generate QR code PNG buffer
// ─────────────────────────────────────────────────────────────
async function generateQR(text, opts = {}) {
  return QRCode.toBuffer(String(text), {
    type:          'png',
    width:         opts.size || 280,
    margin:        2,
    errorCorrectionLevel: 'M',
    color: {
      dark:  '#000000',
      light: '#ffffff',
    },
    ...opts,
  });
}

// ─────────────────────────────────────────────────────────────
// Helper: send image response
// ─────────────────────────────────────────────────────────────
function sendImage(res, buffer, filename, mime = 'image/png') {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(buffer);
}

// ─────────────────────────────────────────────────────────────
// GET /barcodes/product/:id
// Returns a Code128 barcode PNG for the product's barcode field.
// Falls back to SKU if no barcode is set.
// ─────────────────────────────────────────────────────────────
router.get('/product/:id', imageAuthMiddleware, async (req, res) => {
  try {
    const [product] = await query(
      'SELECT id, name, sku, barcode FROM inventory WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantId]
    );
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const code = product.barcode || product.sku;
    if (!code) return res.status(400).json({ success: false, message: 'Product has no barcode or SKU' });

    const buffer = await generateBarcode128(code);
    sendImage(res, buffer, `barcode-product-${product.id}.png`);
  } catch (err) {
    console.error('Barcode generate error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /barcodes/product/:id/qr
// Returns a QR code PNG for the product.
// QR payload: "PRODUCT:{id}:{sku_or_barcode}"
// ─────────────────────────────────────────────────────────────
router.get('/product/:id/qr', imageAuthMiddleware, async (req, res) => {
  try {
    const [product] = await query(
      'SELECT id, name, sku, barcode FROM inventory WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantId]
    );
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const code = product.barcode || product.sku || String(product.id);
    const payload = `PRODUCT:${product.id}:${code}`;
    const buffer = await generateQR(payload);
    sendImage(res, buffer, `qr-product-${product.id}.png`);
  } catch (err) {
    console.error('QR generate error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /barcodes/giftcard/:id/qr
// Returns a QR code PNG encoding the gift card's redeemable code.
// QR payload: "GIFTCARD:{code}"
// Scanning this at POS auto-fills the gift card code for redemption.
// ─────────────────────────────────────────────────────────────
router.get('/giftcard/:id/qr', imageAuthMiddleware, async (req, res) => {
  try {
    const [card] = await query(
      'SELECT id, code, initial_value, remaining_value, status FROM gift_cards WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantId]
    );
    if (!card) return res.status(404).json({ success: false, message: 'Gift card not found' });

    const payload = `GIFTCARD:${card.code}`;
    const buffer = await generateQR(payload);
    sendImage(res, buffer, `qr-giftcard-${card.id}.png`);
  } catch (err) {
    console.error('QR gift card error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /barcodes/appointment/:id/qr
// Returns a QR code PNG for appointment check-in.
// QR payload: "APPOINTMENT:{id}"
// Scanning this updates appointment status to "checked_in".
// ─────────────────────────────────────────────────────────────
router.get('/appointment/:id/qr', imageAuthMiddleware, async (req, res) => {
  try {
    const rows = await query(
      `SELECT a.id, a.start_time, a.status,
              c.first_name as client_first, c.last_name as client_last,
              p.name as service_name,
              s.full_name as staff_name
       FROM appointments a
       LEFT JOIN contacts c ON a.customer_id = c.id
       LEFT JOIN products p ON a.service_id = p.id
       LEFT JOIN staff s ON a.staff_id = s.id
       WHERE a.id = ? AND a.tenant_id = ?`,
      [req.params.id, req.tenantId]
    );
    const appt = rows[0];
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found' });

    const payload = `APPOINTMENT:${appt.id}`;
    const buffer = await generateQR(payload);
    sendImage(res, buffer, `qr-appointment-${appt.id}.png`);
  } catch (err) {
    console.error('QR appointment error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /barcodes/lookup?code=XXX
// Universal lookup — resolves a scanned code to an entity.
// Checks:
//   1. Structured QR payload (PRODUCT:id:code / GIFTCARD:code / APPOINTMENT:id)
//   2. inventory.barcode
//   3. inventory.sku
//   4. gift_cards.code
// Returns: { success, type: 'product'|'giftcard'|'appointment', data }
// ─────────────────────────────────────────────────────────────
router.get('/lookup', authMiddleware, async (req, res) => {
  try {
    const { code } = req.query;
    if (!code || !code.trim()) {
      return res.status(400).json({ success: false, message: 'code query param is required' });
    }
    const raw = code.trim();
    const upper = raw.toUpperCase();

    // ── 1. Structured QR payload ──────────────────────────────
    if (upper.startsWith('PRODUCT:')) {
      // PRODUCT:{id}:{code}
      const parts = raw.split(':');
      const pid = parseInt(parts[1], 10);
      if (pid) {
        const [p] = await query(
          `SELECT id, name, name_ar, sku, barcode, category, brand,
                  retail_price, cost_price, stock_quantity, unit,
                  low_stock_threshold, image_url, description, is_active
           FROM inventory WHERE id = ? AND tenant_id = ?`,
          [pid, req.tenantId]
        );
        if (p) return res.json({ success: true, type: 'product', data: p });
      }
    }

    if (upper.startsWith('GIFTCARD:')) {
      const gcCode = raw.substring('GIFTCARD:'.length).trim();
      const [card] = await query(
        `SELECT id, code, initial_value, remaining_value, currency,
                status, expires_at, issued_to_name, issued_to_email
         FROM gift_cards WHERE code = ? AND tenant_id = ?`,
        [gcCode, req.tenantId]
      );
      if (card) return res.json({ success: true, type: 'giftcard', data: card });
    }

    if (upper.startsWith('APPOINTMENT:')) {
      const aid = parseInt(raw.split(':')[1], 10);
      if (aid) {
        const rows = await query(
          `SELECT a.id, a.start_time, a.end_time, a.status, a.notes,
                  c.first_name as client_first, c.last_name as client_last,
                  c.phone as client_phone,
                  p.name as service_name,
                  s.full_name as staff_name
           FROM appointments a
           LEFT JOIN contacts c ON a.customer_id = c.id
           LEFT JOIN products p ON a.service_id = p.id
           LEFT JOIN staff s ON a.staff_id = s.id
           WHERE a.id = ? AND a.tenant_id = ?`,
          [aid, req.tenantId]
        );
        if (rows[0]) return res.json({ success: true, type: 'appointment', data: rows[0] });
      }
    }

    if (upper.startsWith('INVOICE:')) {
      const invNum = raw.substring('INVOICE:'.length).trim().toUpperCase();
      if (invNum) {
        const [inv] = await query(
          `SELECT i.id, i.invoice_number, i.status, i.total, i.amount_paid, i.currency,
                  i.customer_id, i.staff_id,
                  c.first_name as customer_first_name, c.last_name as customer_last_name,
                  c.email as customer_email, c.phone as customer_phone
           FROM invoices i
           LEFT JOIN contacts c ON i.customer_id = c.id
           WHERE i.invoice_number = ? AND i.tenant_id = ?`,
          [invNum, req.tenantId]
        );
        if (inv) return res.json({ success: true, type: 'invoice', data: inv });
      }
    }

    // ── 2. inventory.barcode exact match ─────────────────────
    const [byBarcode] = await query(
      `SELECT id, name, name_ar, sku, barcode, category, brand,
              retail_price, cost_price, stock_quantity, unit,
              low_stock_threshold, image_url, description, is_active
       FROM inventory WHERE barcode = ? AND tenant_id = ?`,
      [raw, req.tenantId]
    );
    if (byBarcode) return res.json({ success: true, type: 'product', data: byBarcode });

    // ── 3. inventory.sku exact match ─────────────────────────
    const [bySku] = await query(
      `SELECT id, name, name_ar, sku, barcode, category, brand,
              retail_price, cost_price, stock_quantity, unit,
              low_stock_threshold, image_url, description, is_active
       FROM inventory WHERE sku = ? AND tenant_id = ?`,
      [raw, req.tenantId]
    );
    if (bySku) return res.json({ success: true, type: 'product', data: bySku });

    // ── 4. gift_cards.code exact match ───────────────────────
    const [byGcCode] = await query(
      `SELECT id, code, initial_value, remaining_value, currency,
              status, expires_at, issued_to_name, issued_to_email
       FROM gift_cards WHERE code = ? AND tenant_id = ?`,
      [raw, req.tenantId]
    );
    if (byGcCode) return res.json({ success: true, type: 'giftcard', data: byGcCode });

    // ── Nothing found ─────────────────────────────────────────
    return res.status(404).json({ success: false, message: `No entity found for code: ${raw}` });
  } catch (err) {
    console.error('Barcode lookup error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /barcodes/appointment/:id/checkin
// Check-in an appointment via QR scan.
// Updates status to 'confirmed' (or marks customer_showed=1).
// ─────────────────────────────────────────────────────────────
router.post('/appointment/:id/checkin', authMiddleware, async (req, res) => {
  try {
    const [appt] = await query(
      'SELECT id, status FROM appointments WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantId]
    );
    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found' });

    if (appt.status === 'cancelled' || appt.status === 'no_show') {
      return res.status(400).json({ success: false, message: `Cannot check-in a ${appt.status} appointment` });
    }

    await query(
      `UPDATE appointments SET customer_showed = 1, status = 'in_progress', updated_at = NOW()
       WHERE id = ? AND tenant_id = ?`,
      [req.params.id, req.tenantId]
    );

    res.json({ success: true, message: 'Client checked in successfully', appointment_id: appt.id });
  } catch (err) {
    console.error('Check-in error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /barcodes/product/:id/label
// Returns a printable label PNG: barcode + product name + price
// ─────────────────────────────────────────────────────────────
router.get('/product/:id/label', imageAuthMiddleware, async (req, res) => {
  try {
    const [product] = await query(
      'SELECT id, name, sku, barcode, retail_price FROM inventory WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantId]
    );
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    const code = product.barcode || product.sku;
    if (!code) return res.status(400).json({ success: false, message: 'Product has no barcode or SKU' });

    // Taller label: includes text + barcode
    const buffer = await bwipjs.toBuffer({
      bcid:        'code128',
      text:        code,
      scale:       3,
      height:      20,
      width:       80,
      includetext: true,
      textxalign:  'center',
      paddingwidth: 10,
      paddingheight: 5,
      backgroundcolor: 'ffffff',
      barcolor: '000000',
    });
    sendImage(res, buffer, `label-product-${product.id}.png`);
  } catch (err) {
    console.error('Label generate error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
