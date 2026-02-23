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
import { query, execute } from '../lib/database.js';
import { authMiddleware, verifyToken } from '../middleware/auth.js';
import { sendNotificationEmail } from '../lib/email.js';

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
// 1. Sets status → in_progress, customer_showed = 1
// 2. Auto-creates a draft invoice if one doesn't exist yet
// 3. Sends a payment QR email to the customer
// ─────────────────────────────────────────────────────────────
router.post('/appointment/:id/checkin', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const apptId   = req.params.id;

    // Fetch full appointment with joins needed for invoice + email
    const [appt] = await query(
      `SELECT a.id, a.status, a.customer_id, a.service_id, a.staff_id,
              a.discount_amount, a.discount_type, a.original_price, a.final_price,
              p.unit_price, p.name AS service_name, p.currency,
              c.first_name AS customer_first_name, c.last_name AS customer_last_name,
              c.email AS customer_email,
              s.full_name AS staff_name
       FROM appointments a
       LEFT JOIN products p  ON a.service_id  = p.id
       LEFT JOIN contacts c  ON a.customer_id = c.id
       LEFT JOIN staff   s   ON a.staff_id    = s.id
       WHERE a.id = ? AND a.tenant_id = ?`,
      [apptId, tenantId]
    );

    if (!appt) return res.status(404).json({ success: false, message: 'Appointment not found' });

    if (appt.status === 'cancelled' || appt.status === 'no_show') {
      return res.status(400).json({ success: false, message: `Cannot check-in a ${appt.status} appointment` });
    }

    // 1. Update appointment status
    await execute(
      `UPDATE appointments SET customer_showed = 1, status = 'in_progress', updated_at = NOW()
       WHERE id = ? AND tenant_id = ?`,
      [apptId, tenantId]
    );

    // Auto-complete any other stale in_progress appointments for the same customer
    // (earlier appointments from the same day or previous days that were never closed)
    if (appt.customer_id) {
      await execute(
        `UPDATE appointments
         SET status = 'completed', updated_at = NOW()
         WHERE tenant_id = ?
           AND customer_id = ?
           AND id != ?
           AND status = 'in_progress'
           AND start_time < (SELECT start_time FROM appointments WHERE id = ?)`,
        [tenantId, appt.customer_id, apptId, apptId]
      ).catch(e => console.warn('Could not auto-complete stale appointments:', e.message));
    }

    // 2. Create invoice if not already present
    let invoiceId, invoiceNumber;
    const [existingInv] = await query(
      'SELECT id, invoice_number FROM invoices WHERE appointment_id = ? AND tenant_id = ?',
      [apptId, tenantId]
    );

    if (existingInv) {
      invoiceId     = existingInv.id;
      invoiceNumber = existingInv.invoice_number;
    } else {
      // Generate next invoice number
      const [lastInv] = await query(
        "SELECT invoice_number FROM invoices WHERE tenant_id = ? ORDER BY id DESC LIMIT 1",
        [tenantId]
      );
      const lastNum  = lastInv?.invoice_number ? parseInt(lastInv.invoice_number.replace(/\D/g, ''), 10) || 0 : 0;
      invoiceNumber  = `INV-${String(lastNum + 1).padStart(4, '0')}`;

      const basePrice  = parseFloat(appt.unit_price || appt.original_price || 0);
      const promoDisc  = parseFloat(appt.discount_amount || 0);
      const afterDisc  = Math.max(0, basePrice - promoDisc);
      const taxRate    = 5;
      const taxAmount  = afterDisc * (taxRate / 100);
      const total      = afterDisc + taxAmount;

      const invResult  = await execute(`
        INSERT INTO invoices
          (tenant_id, appointment_id, customer_id, staff_id,
           invoice_number, subtotal, discount_amount, discount_type,
           tax_rate, tax_amount, total, amount_paid, currency,
           status, payment_method, notes, created_by)
        VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?)
      `, [
        tenantId, apptId, appt.customer_id, appt.staff_id,
        invoiceNumber, basePrice, promoDisc, appt.discount_type || 'fixed',
        taxRate, taxAmount, total, 0, appt.currency || 'AED',
        'sent', null, null, req.user?.id || null,
      ]);
      invoiceId = invResult.insertId;

      // Add service line item
      await execute(`
        INSERT INTO invoice_items
          (invoice_id, item_type, item_id, name, quantity, unit_price, total)
        VALUES (?, 'service', ?, ?, 1, ?, ?)
      `, [invoiceId, appt.service_id, appt.service_name || 'Service',
          basePrice, basePrice]);
    }

    // 3. Send payment QR email to customer (fire-and-forget)
    if (appt.customer_email) {
      const customerName = `${appt.customer_first_name || ''} ${appt.customer_last_name || ''}`.trim() || 'Valued Client';
      const qrBuffer = await QRCode.toBuffer(`INVOICE:${invoiceNumber}`, {
        type: 'png', width: 200, margin: 2,
        color: { dark: '#1a1a2e', light: '#ffffff' },
      }).catch(() => null);

      sendNotificationEmail({
        to:      appt.customer_email,
        subject: `Your Invoice is Ready — ${invoiceNumber}`,
        title:   'Your Invoice is Ready 💳',
        body: `
          <p>Dear ${customerName},</p>
          <p>Your session has started and your invoice is ready. Show the QR code below at the counter to complete your payment.</p>
          <div style="background:#f8f9fa;padding:24px;border-radius:8px;margin:20px 0;text-align:center;">
            <p style="margin:0 0 6px;font-size:13px;color:#888;">Invoice ${invoiceNumber}</p>
            <p style="margin:0 0 16px;font-size:18px;font-weight:600;color:#333;">${appt.service_name || 'Service'}</p>
            ${qrBuffer ? `<img src="cid:inv_qr" alt="Payment QR Code"
              style="display:block;margin:0 auto 12px;width:160px;height:160px;border:4px solid #fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.12);" />
            <p style="font-size:12px;color:#aaa;margin:0;">Show this QR at checkout to pay</p>` : ''}
          </div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
            <tr><td style="padding:6px 0;color:#888;font-size:13px;width:90px;">Service</td><td style="padding:6px 0;font-weight:500;">${appt.service_name || '—'}</td></tr>
            <tr><td style="padding:6px 0;color:#888;font-size:13px;">Staff</td><td style="padding:6px 0;font-weight:500;">${appt.staff_name || 'Our team'}</td></tr>
            <tr><td style="padding:6px 0;color:#888;font-size:13px;">Invoice #</td><td style="padding:6px 0;font-weight:500;">${invoiceNumber}</td></tr>
          </table>
          <p style="color:#555;">Thank you for choosing us today!</p>
        `,
        tenantId,
        attachments: qrBuffer ? [{
          filename: 'invoice-qr.png',
          content:  qrBuffer,
          cid:      'inv_qr',
          encoding: 'base64',
        }] : [],
      }).catch(e => console.warn('Check-in invoice email failed:', e.message));
    }

    res.json({
      success: true,
      message: 'Client checked in successfully',
      appointment_id: apptId,
      invoice_number: invoiceNumber,
      invoice_id: invoiceId,
    });
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
