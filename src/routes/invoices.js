import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { processAutoEarn, redeemLoyaltyForPayment } from './loyalty.js';
import { redeemGiftCard } from './gift-cards.js';
import { notifyInvoice, notifyPayment } from '../lib/notify.js';
import { sendNotificationEmail } from '../lib/email.js';
import { generateInvoicePDF, generateReceiptPDF, getTenantInfo } from '../lib/pdf.js';

const router = express.Router();

async function ensureTables() {
  await execute(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      branch_id INT,
      appointment_id INT,
      customer_id INT,
      staff_id INT,
      invoice_number VARCHAR(20),
      subtotal DECIMAL(12,2) DEFAULT 0,
      discount_amount DECIMAL(12,2) DEFAULT 0,
      discount_type ENUM('fixed','percentage') DEFAULT 'fixed',
      tax_rate DECIMAL(5,2) DEFAULT 0,
      tax_amount DECIMAL(12,2) DEFAULT 0,
      total DECIMAL(12,2) DEFAULT 0,
      amount_paid DECIMAL(12,2) DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'AED',
      status ENUM('draft','sent','paid','partially_paid','overdue','void') DEFAULT 'draft',
      payment_method VARCHAR(50),
      paid_at DATETIME,
      due_date DATE,
      notes TEXT,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_customer (customer_id),
      INDEX idx_status (status),
      INDEX idx_number (invoice_number),
      INDEX idx_appointment (appointment_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS invoice_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_id INT NOT NULL,
      item_type ENUM('service','product','package','gift_card','custom') DEFAULT 'service',
      item_id INT,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      quantity INT DEFAULT 1,
      unit_price DECIMAL(12,2) DEFAULT 0,
      discount DECIMAL(12,2) DEFAULT 0,
      total DECIMAL(12,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_invoice (invoice_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// Generate next invoice number for tenant
async function getNextInvoiceNumber(tenantId) {
  const [last] = await query(
    "SELECT invoice_number FROM invoices WHERE tenant_id = ? ORDER BY id DESC LIMIT 1",
    [tenantId]
  );
  if (!last || !last.invoice_number) return 'INV-0001';
  const num = parseInt(last.invoice_number.replace('INV-', '')) || 0;
  return `INV-${String(num + 1).padStart(4, '0')}`;
}

router.use(authMiddleware);

// ── Stats ──
router.get('/stats', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const [stats] = await query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END) as total_paid,
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_count,
        SUM(CASE WHEN status IN ('draft','sent') THEN total ELSE 0 END) as total_pending,
        SUM(CASE WHEN status IN ('draft','sent') THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN status = 'overdue' THEN total ELSE 0 END) as total_overdue,
        SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) as overdue_count,
        SUM(CASE WHEN status = 'void' THEN 1 ELSE 0 END) as void_count
      FROM invoices WHERE tenant_id = ?
    `, [t]);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Invoice stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── List invoices ──
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { status, customer_id, from_date, to_date, search, page = 1, limit = 20, staff_id } = req.query;
    let where = 'WHERE i.tenant_id = ?';
    const params = [t];

    // Check role-based access: can user view all invoices or only their own?
    const user = req.user;
    const rolePerms = user?.rolePermissions || {};
    const invoicePerms = rolePerms.invoices || {};
    
    // Check if user has view permission at all
    if (!invoicePerms.view && user?.role !== 'admin' && user?.is_owner !== 1 && user?.role !== 'manager') {
      return res.status(403).json({ success: false, message: 'You do not have permission to view invoices' });
    }
    
    // Check if user can view all invoices
    // If view_scope is 'all' or view_all is true, they can see all
    // If view_scope is 'own' or not set, they can only see their own
    const viewScope = invoicePerms.view_scope || 'own'; // Default to 'own' if not set
    const canViewAll = viewScope === 'all' || invoicePerms.view_all === true;
    
    // If user is admin/owner/manager, they can always view all
    const isAdmin = user?.role === 'admin' || user?.is_owner === 1 || user?.role === 'manager';
    
    // Debug logging (remove in production)
    if (process.env.NODE_ENV === 'development') {
      console.log('[Invoices Filter]', {
        userId: user.id,
        role: user.role,
        isAdmin,
        viewScope,
        canViewAll,
        invoicePerms,
        hasView: invoicePerms.view
      });
    }
    
    // Apply role-based filtering: if user can only view own, filter by their staff_id
    // Unless they explicitly requested a specific staff_id filter
    if (!isAdmin && !canViewAll && !staff_id) {
      // User can only view their own invoices (where they are the assigned staff)
      where += ' AND i.staff_id = ?';
      params.push(user.id);
      if (process.env.NODE_ENV === 'development') {
        console.log('[Invoices Filter] Filtering by staff_id:', user.id);
      }
    } else if (staff_id) {
      // Explicit staff_id filter from query params (admin/manager can filter by any staff)
      where += ' AND i.staff_id = ?';
      params.push(staff_id);
    }

    if (status) { where += ' AND i.status = ?'; params.push(status); }
    if (customer_id) { where += ' AND i.customer_id = ?'; params.push(customer_id); }
    if (from_date) { where += ' AND DATE(i.created_at) >= ?'; params.push(from_date); }
    if (to_date) { where += ' AND DATE(i.created_at) <= ?'; params.push(to_date); }
    if (search) {
      where += ' AND (i.invoice_number LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const [{ total }] = await query(`SELECT COUNT(*) as total FROM invoices i LEFT JOIN contacts c ON i.customer_id = c.id ${where}`, [...params]);

    const pg = parseInt(page); const lm = parseInt(limit);
    const offset = (pg - 1) * lm;

    const invoices = await query(`
      SELECT i.*,
        c.first_name as customer_first_name, c.last_name as customer_last_name,
        c.email as customer_email, c.phone as customer_phone,
        s.full_name as staff_name,
        b.name as branch_name
      FROM invoices i
      LEFT JOIN contacts c ON i.customer_id = c.id
      LEFT JOIN staff s ON i.staff_id = s.id
      LEFT JOIN branches b ON i.branch_id = b.id
      ${where}
      ORDER BY i.created_at DESC
      LIMIT ${lm} OFFSET ${offset}
    `, [...params]);

    res.json({ success: true, data: invoices, pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) } });
  } catch (error) {
    console.error('List invoices error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Generate PDF for invoice (must be before /:id route) ──
router.get('/:id/pdf', async (req, res) => {
  try {
    await ensureTables();
    const [invoice] = await query(`
      SELECT i.*,
        c.first_name as customer_first_name, c.last_name as customer_last_name,
        c.email as customer_email, c.phone as customer_phone,
        s.full_name as staff_name,
        b.name as branch_name
      FROM invoices i
      LEFT JOIN contacts c ON i.customer_id = c.id
      LEFT JOIN staff s ON i.staff_id = s.id
      LEFT JOIN branches b ON i.branch_id = b.id
      WHERE i.id = ? AND i.tenant_id = ?
    `, [req.params.id, req.tenantId]);

    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    // Get invoice items
    const items = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoice.id]);
    invoice.items = items;

    // Get tenant info
    const tenantInfo = await getTenantInfo(req.tenantId);

    // Generate PDF
    const pdfBuffer = await generateInvoicePDF(invoice, tenantInfo);

    // Set response headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.invoice_number}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);

    res.send(pdfBuffer);
  } catch (error) {
    console.error('Generate PDF error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate PDF', error: error.message });
  }
});

// ── Generate payment receipt PDF (must be before /:id route) ──
router.get('/:id/receipt-pdf', async (req, res) => {
  try {
    await ensureTables();
    const [invoice] = await query(`
      SELECT i.*,
        c.first_name as customer_first_name, c.last_name as customer_last_name,
        c.email as customer_email, c.phone as customer_phone,
        s.full_name as staff_name,
        b.name as branch_name
      FROM invoices i
      LEFT JOIN contacts c ON i.customer_id = c.id
      LEFT JOIN staff s ON i.staff_id = s.id
      LEFT JOIN branches b ON i.branch_id = b.id
      WHERE i.id = ? AND i.tenant_id = ?
    `, [req.params.id, req.tenantId]);

    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const items = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoice.id]);
    invoice.items = items;

    const tenantInfo = await getTenantInfo(req.tenantId);
    const receiptBuffer = await generateReceiptPDF(invoice, tenantInfo);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${invoice.invoice_number}.pdf"`);
    res.setHeader('Content-Length', receiptBuffer.length);

    res.send(receiptBuffer);
  } catch (error) {
    console.error('Generate receipt PDF error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate receipt PDF', error: error.message });
  }
});

// ── Get single invoice with items ──
router.get('/:id', async (req, res) => {
  try {
    await ensureTables();
    const [invoice] = await query(`
      SELECT i.*,
        c.first_name as customer_first_name, c.last_name as customer_last_name,
        c.email as customer_email, c.phone as customer_phone,
        s.full_name as staff_name,
        b.name as branch_name
      FROM invoices i
      LEFT JOIN contacts c ON i.customer_id = c.id
      LEFT JOIN staff s ON i.staff_id = s.id
      LEFT JOIN branches b ON i.branch_id = b.id
      WHERE i.id = ? AND i.tenant_id = ?
    `, [req.params.id, req.tenantId]);

    if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const items = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoice.id]);
    invoice.items = items;

    res.json({ success: true, data: invoice });
  } catch (error) {
    console.error('Get invoice error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Create invoice ──
router.post('/', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    // Get tenant currency as default
    let tenantCurrency = 'AED';
    try {
      const [tenant] = await query('SELECT currency, settings FROM tenants WHERE id = ?', [t]);
      if (tenant) {
        tenantCurrency = tenant.currency || 'AED';
        // Also check settings for default tax rate
        if (tenant.settings) {
          try {
            const settings = typeof tenant.settings === 'string' ? JSON.parse(tenant.settings) : tenant.settings;
            if (settings.default_tax_rate !== undefined && req.body.tax_rate === undefined) {
              req.body.tax_rate = parseFloat(settings.default_tax_rate) || 0;
            }
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* use default */ }

    const {
      branch_id, appointment_id, customer_id, staff_id,
      items = [], discount_amount: rawDiscount, discount_value, discount_type = 'fixed',
      tax_rate = 0, currency = tenantCurrency, payment_method, notes, due_date, status = 'draft'
    } = req.body;
    // Accept both discount_amount and discount_value
    const discount_amount = parseFloat(rawDiscount ?? discount_value ?? 0);

    if (!customer_id) return res.status(400).json({ success: false, message: 'Customer is required' });
    if (!items.length) return res.status(400).json({ success: false, message: 'At least one item is required' });

    // Validate item prices are non-negative
    for (const item of items) {
      if ((item.unit_price || 0) < 0) return res.status(400).json({ success: false, message: 'Item prices cannot be negative' });
      if ((item.quantity || 1) < 1) return res.status(400).json({ success: false, message: 'Item quantity must be at least 1' });
    }

    const invoiceNumber = await getNextInvoiceNumber(t);

    // Calculate totals
    let subtotal = 0;
    for (const item of items) {
      const itemTotal = (item.quantity || 1) * (item.unit_price || 0) - (item.discount || 0);
      subtotal += itemTotal;
    }

    let discountVal = 0;
    if (discount_type === 'percentage') {
      discountVal = subtotal * (discount_amount / 100);
    } else {
      discountVal = discount_amount;
    }

    const afterDiscount = subtotal - discountVal;
    const taxAmount = afterDiscount * (tax_rate / 100);
    const total = afterDiscount + taxAmount;

    const result = await execute(`
      INSERT INTO invoices (tenant_id, branch_id, appointment_id, customer_id, staff_id,
        invoice_number, subtotal, discount_amount, discount_type, tax_rate, tax_amount,
        total, currency, status, payment_method, due_date, notes, created_by)
      VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?)
    `, [
      t, branch_id || null, appointment_id || null, customer_id, staff_id || req.user?.id || null,
      invoiceNumber, subtotal, discountVal, discount_type, tax_rate, taxAmount,
      total, currency, status, payment_method || null, due_date || null, notes || null, req.user?.id || null
    ]);

    const invoiceId = result.insertId;

    // Insert items
    for (const item of items) {
      const itemTotal = (item.quantity || 1) * (item.unit_price || 0) - (item.discount || 0);
      const itemName = item.name || item.description || 'Item';
      const itemDesc = item.description || item.name || null;
      await execute(`
        INSERT INTO invoice_items (invoice_id, item_type, item_id, name, description, quantity, unit_price, discount, total)
        VALUES (?,?,?,?,?,?,?,?,?)
      `, [invoiceId, item.item_type || 'service', item.item_id || null, itemName, itemDesc, item.quantity || 1, item.unit_price || 0, item.discount || 0, itemTotal]);
    }

    // Push notification
    notifyInvoice(req.tenantId, `Invoice ${invoiceNumber} Created`, `Total: ${total.toFixed(2)} ${currency}`, { invoice_id: invoiceId, total }).catch(() => {});

    // Send email if status is 'sent' and customer has email
    if (status === 'sent' && customer_id) {
      try {
        const [customer] = await query('SELECT email, first_name, last_name FROM contacts WHERE id = ?', [customer_id]);
        if (customer && customer.email) {
          const [createdInvoice] = await query(`
            SELECT i.*,
              c.first_name as customer_first_name, c.last_name as customer_last_name,
              c.email as customer_email, c.phone as customer_phone,
              s.full_name as staff_name,
              b.name as branch_name
            FROM invoices i
            LEFT JOIN contacts c ON i.customer_id = c.id
            LEFT JOIN staff s ON i.staff_id = s.id
            LEFT JOIN branches b ON i.branch_id = b.id
            WHERE i.id = ? AND i.tenant_id = ?
          `, [invoiceId, req.tenantId]);

          const invoiceItems = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [invoiceId]);
          createdInvoice.items = invoiceItems;

          const tenantInfo = await getTenantInfo(req.tenantId);
          const pdfBuffer = await generateInvoicePDF(createdInvoice, tenantInfo);

          const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Valued Client';
          await sendNotificationEmail({
            to: customer.email,
            subject: `Invoice ${invoiceNumber} from ${currency} ${total.toFixed(2)}`,
            title: `Invoice ${invoiceNumber}`,
            body: `
              <p>Dear ${customerName},</p>
              <p>Your invoice has been generated:</p>
              <ul>
                <li><strong>Invoice Number:</strong> ${invoiceNumber}</li>
                <li><strong>Total Amount:</strong> ${currency} ${total.toFixed(2)}</li>
                ${due_date ? `<li><strong>Due Date:</strong> ${new Date(due_date).toLocaleDateString()}</li>` : ''}
              </ul>
              <p>Please complete your payment at your earliest convenience.</p>
              <p>Thank you for your business!</p>
            `,
            tenantId: req.tenantId,
            attachments: [{
              filename: `invoice-${invoiceNumber}.pdf`,
              content: pdfBuffer,
              contentType: 'application/pdf',
            }],
          }).catch(err => console.error('Failed to send invoice email:', err.message));
        }
      } catch (emailErr) {
        console.error('Error sending invoice email:', emailErr);
      }
    }

    res.status(201).json({ success: true, data: {
      id: invoiceId, invoice_number: invoiceNumber,
      subtotal, discount_amount: discountVal, discount_type, discount_value: discount_amount,
      tax_rate, tax_amount: taxAmount, total, status, currency
    }, message: 'Invoice created' });
  } catch (error) {
    console.error('Create invoice error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Create invoice from appointment ──
router.post('/from-appointment/:appointmentId', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { appointmentId } = req.params;

    // Get appointment with service details
    const [apt] = await query(`
      SELECT a.*, p.name as service_name, p.unit_price, p.currency,
        c.first_name, c.last_name
      FROM appointments a
      LEFT JOIN products p ON a.service_id = p.id
      LEFT JOIN contacts c ON a.customer_id = c.id
      WHERE a.id = ? AND a.tenant_id = ?
    `, [appointmentId, t]);

    if (!apt) return res.status(404).json({ success: false, message: 'Appointment not found' });

    // Check if invoice already exists for this appointment
    const [existing] = await query('SELECT id FROM invoices WHERE appointment_id = ? AND tenant_id = ?', [appointmentId, t]);
    if (existing) return res.status(409).json({ success: false, message: 'Invoice already exists for this appointment', data: { invoice_id: existing.id } });

    const invoiceNumber = await getNextInvoiceNumber(t);
    const subtotal = parseFloat(apt.unit_price || 0);
    const { tax_rate = 0, discount_amount = 0, discount_value = 0 } = req.body;
    const disc = parseFloat(discount_amount || discount_value || 0);
    const taxAmount = (subtotal - disc) * (tax_rate / 100);
    const total = subtotal - disc + taxAmount;

    // Get tenant currency as fallback
    let fallbackCurrency = 'AED';
    try {
      const [tenant] = await query('SELECT currency FROM tenants WHERE id = ?', [t]);
      if (tenant?.currency) fallbackCurrency = tenant.currency;
    } catch (e) { /* ignore */ }

    const result = await execute(`
      INSERT INTO invoices (tenant_id, appointment_id, customer_id, staff_id,
        invoice_number, subtotal, discount_amount, tax_rate, tax_amount,
        total, currency, status, created_by)
      VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?,?)
    `, [t, appointmentId, apt.customer_id, apt.staff_id, invoiceNumber, subtotal, disc, tax_rate, taxAmount, total, apt.currency || fallbackCurrency, 'draft', req.user?.id || null]);

    const invoiceId = result.insertId;

    // Add the service as an item
    await execute(`
      INSERT INTO invoice_items (invoice_id, item_type, item_id, name, quantity, unit_price, total)
      VALUES (?, 'service', ?, ?, 1, ?, ?)
    `, [invoiceId, apt.service_id, apt.service_name || 'Service', subtotal, subtotal]);

    res.status(201).json({ success: true, data: { id: invoiceId, invoice_number: invoiceNumber, total }, message: 'Invoice created from appointment' });
  } catch (error) {
    console.error('Create invoice from appointment error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Update invoice ──
router.patch('/:id', async (req, res) => {
  try {
    const fields = ['status', 'payment_method', 'notes', 'due_date', 'discount_amount', 'discount_type', 'tax_rate', 'amount_paid'];
    const updates = [];
    const params = [];

    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }

    // If marking as paid
    if (req.body.status === 'paid' && !req.body.paid_at) {
      updates.push('paid_at = NOW()');
    }
    if (req.body.paid_at) { updates.push('paid_at = ?'); params.push(req.body.paid_at); }

    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No fields to update' });

    // Recalculate totals if discount/tax changed
    if (req.body.discount_amount !== undefined || req.body.tax_rate !== undefined) {
      const [inv] = await query('SELECT subtotal, discount_amount, discount_type, tax_rate FROM invoices WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
      if (inv) {
        const sub = inv.subtotal;
        const discAmt = req.body.discount_amount !== undefined ? req.body.discount_amount : inv.discount_amount;
        const discType = req.body.discount_type || inv.discount_type;
        const txRate = req.body.tax_rate !== undefined ? req.body.tax_rate : inv.tax_rate;
        const disc = discType === 'percentage' ? sub * (discAmt / 100) : discAmt;
        const afterDisc = sub - disc;
        const tax = afterDisc * (txRate / 100);
        updates.push('tax_amount = ?', 'total = ?');
        params.push(tax, afterDisc + tax);
      }
    }

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE invoices SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);

    // Auto-earn loyalty points when marking as paid
    if (req.body.status === 'paid') {
      const [paidInv] = await query('SELECT customer_id, total FROM invoices WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
      if (paidInv?.customer_id && paidInv?.total > 0) {
        const loyaltyResult = await processAutoEarn(req.tenantId, paidInv.customer_id, parseFloat(paidInv.total), parseInt(req.params.id));
        if (loyaltyResult) {
          return res.json({ success: true, message: 'Invoice updated', loyalty: loyaltyResult });
        }
      }
    }

    res.json({ success: true, message: 'Invoice updated' });
  } catch (error) {
    console.error('Update invoice error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Record payment (supports split: discount code + loyalty points + other method) ──
router.post('/:id/pay', async (req, res) => {
  try {
    const { amount, payment_method = 'cash', gift_card_code, loyalty_amount, discount_code } = req.body;
    let totalAmount = parseFloat(amount || 0);
    const loyaltyAmt = parseFloat(loyalty_amount || 0);

    if (totalAmount <= 0) return res.status(400).json({ success: false, message: 'Valid amount required' });

    // Require gift card code when paying by gift card
    if (payment_method === 'gift_card' && !gift_card_code) {
      return res.status(400).json({ success: false, message: 'Gift card code is required for gift card payments' });
    }

    const [inv] = await query('SELECT * FROM invoices WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found' });
    if (inv.status === 'paid') return res.status(400).json({ success: false, message: 'Invoice is already fully paid' });
    if (inv.status === 'void') return res.status(400).json({ success: false, message: 'Cannot pay a voided invoice' });

    // Cap payment at balance due
    const currentBalance = Math.max(0, parseFloat(inv.total) - parseFloat(inv.amount_paid || 0));
    if (currentBalance <= 0) return res.status(400).json({ success: false, message: 'No balance due on this invoice' });
    totalAmount = Math.min(totalAmount, currentBalance);

    // ── Step 0: Validate & apply discount code (reduces effective amount) ──
    let discountResult = null;
    if (discount_code) {
      // Validate the code
      const [dc] = await query(`
        SELECT dc.id as code_id, dc.code, dc.max_uses, dc.used_count as code_used, dc.is_active as code_active,
               p.id as promo_id, p.name as promo_name, p.type, p.discount_value, p.min_spend,
               p.is_active as promo_active, p.start_date, p.end_date, p.usage_limit, p.used_count as promo_used
        FROM discount_codes dc
        LEFT JOIN promotions p ON dc.promotion_id = p.id
        WHERE dc.code = ? AND dc.tenant_id = ? AND dc.is_active = 1
      `, [discount_code, req.tenantId]);

      if (!dc) return res.status(400).json({ success: false, message: 'Invalid discount code' });
      if (!dc.promo_active) return res.status(400).json({ success: false, message: 'Promotion is not active' });

      const now = new Date();
      if (dc.start_date && new Date(dc.start_date) > now) return res.status(400).json({ success: false, message: 'Promotion has not started yet' });
      if (dc.end_date && new Date(dc.end_date) < now) return res.status(400).json({ success: false, message: 'Promotion has expired' });
      if (dc.max_uses > 0 && dc.code_used >= dc.max_uses) return res.status(400).json({ success: false, message: 'Discount code usage limit reached' });
      if (dc.min_spend > 0 && parseFloat(inv.total) < dc.min_spend) return res.status(400).json({ success: false, message: `Minimum spend of ${dc.min_spend} required` });

      // Calculate discount
      let discAmt = 0;
      const balance = parseFloat(inv.total) - parseFloat(inv.amount_paid || 0);
      if (dc.type === 'percentage') {
        discAmt = Math.min(balance, balance * (dc.discount_value / 100));
      } else {
        discAmt = Math.min(balance, parseFloat(dc.discount_value));
      }
      discAmt = parseFloat(discAmt.toFixed(2));

      if (discAmt > 0) {
        // Record usage
        await execute(`INSERT INTO discount_usage (discount_code_id, promotion_id, customer_id, invoice_id, discount_amount) VALUES (?,?,?,?,?)`,
          [dc.code_id, dc.promo_id, inv.customer_id || null, parseInt(req.params.id), discAmt]);
        await execute('UPDATE discount_codes SET used_count = used_count + 1 WHERE id = ?', [dc.code_id]);
        await execute('UPDATE promotions SET used_count = used_count + 1 WHERE id = ?', [dc.promo_id]);

        // Adjust invoice discount
        await execute(`UPDATE invoices SET discount_amount = discount_amount + ? WHERE id = ? AND tenant_id = ?`,
          [discAmt, req.params.id, req.tenantId]);

        // Recalculate total after discount
        const [updated] = await query('SELECT total, amount_paid FROM invoices WHERE id = ?', [req.params.id]);
        const newTotal = parseFloat(updated.total) - discAmt;
        await execute('UPDATE invoices SET total = ? WHERE id = ? AND tenant_id = ?', [newTotal, req.params.id, req.tenantId]);

        // Adjust payment amount to the new balance
        const newBalance = newTotal - parseFloat(updated.amount_paid || 0);
        totalAmount = Math.min(totalAmount, newBalance);

        discountResult = {
          code: dc.code,
          promo_name: dc.promo_name,
          type: dc.type,
          discount_value: dc.discount_value,
          discount_amount: discAmt,
          message: `${dc.promo_name}: ${dc.type === 'percentage' ? dc.discount_value + '%' : dc.discount_value} off (−${discAmt})`
        };
      }
    }

    // ── Step 1: Process loyalty points deduction (if any) ──
    let loyaltyRedeemResult = null;
    if (loyaltyAmt > 0) {
      if (!inv.customer_id) {
        return res.status(400).json({ success: false, message: 'Invoice must have a customer to redeem loyalty points' });
      }
      if (loyaltyAmt > totalAmount) {
        return res.status(400).json({ success: false, message: 'Loyalty amount cannot exceed total payment amount' });
      }
      loyaltyRedeemResult = await redeemLoyaltyForPayment(
        req.tenantId, inv.customer_id, loyaltyAmt, parseInt(req.params.id)
      );
      if (!loyaltyRedeemResult.success) {
        return res.status(400).json({ success: false, message: loyaltyRedeemResult.message });
      }
    }

    // ── Step 2: Process gift card (for the non-loyalty portion) ──
    let giftCardResult = null;
    const remainingAfterLoyalty = totalAmount - loyaltyAmt;
    if (payment_method === 'gift_card' && gift_card_code && remainingAfterLoyalty > 0) {
      giftCardResult = await redeemGiftCard(req.tenantId, gift_card_code, remainingAfterLoyalty, {
        invoice_id: parseInt(req.params.id),
        created_by: req.user?.id
      });
      if (!giftCardResult.success) {
        return res.status(400).json({ success: false, message: giftCardResult.message });
      }
    }

    // ── Step 3: Update invoice ──
    // Re-read invoice if discount was applied (total may have changed)
    let currentInv = inv;
    if (discountResult) {
      const [refreshed] = await query('SELECT * FROM invoices WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
      if (refreshed) currentInv = refreshed;
    }
    const newPaid = parseFloat(currentInv.amount_paid || 0) + totalAmount;
    const newStatus = newPaid >= parseFloat(currentInv.total) ? 'paid' : 'partially_paid';
    const recordedMethod = loyaltyAmt > 0 && loyaltyAmt < totalAmount
      ? `loyalty_points+${payment_method}`
      : loyaltyAmt >= totalAmount ? 'loyalty_points' : payment_method;

    await execute(`
      UPDATE invoices SET amount_paid = ?, status = ?, payment_method = ?, paid_at = IF(? = 'paid', NOW(), paid_at)
      WHERE id = ? AND tenant_id = ?
    `, [newPaid, newStatus, recordedMethod, newStatus, req.params.id, req.tenantId]);

    // ── Step 4: Auto-earn loyalty when fully paid (skip if any part used points) ──
    let loyaltyResult = null;
    if (newStatus === 'paid' && inv.customer_id && inv.total > 0 && loyaltyAmt <= 0) {
      loyaltyResult = await processAutoEarn(req.tenantId, inv.customer_id, parseFloat(inv.total), parseInt(req.params.id));
    }

    // Build response message
    const parts = [];
    if (discountResult) parts.push(discountResult.message);
    if (loyaltyAmt > 0 && remainingAfterLoyalty > 0) {
      parts.push(`Split: ${loyaltyAmt} pts + ${remainingAfterLoyalty} ${payment_method}`);
    } else if (loyaltyAmt >= totalAmount) {
      parts.push(`Paid ${totalAmount} via loyalty points`);
    } else if (totalAmount > 0) {
      parts.push(`Paid ${totalAmount} via ${payment_method}`);
    }
    if (loyaltyRedeemResult) parts.push(loyaltyRedeemResult.message);
    if (giftCardResult) parts.push(`Gift card: ${giftCardResult.message}`);
    if (loyaltyResult) parts.push(`+${loyaltyResult.points_earned} loyalty points earned`);

    // Push notification for payment
    notifyPayment(
      req.tenantId,
      newStatus === 'paid' ? `Invoice ${inv.invoice_number} Fully Paid` : `Payment Received — ${inv.invoice_number}`,
      `${totalAmount.toFixed(2)} via ${payment_method}`,
      { invoice_id: inv.id, amount: totalAmount, method: payment_method }
    ).catch(() => {});

    // Send payment confirmation email
    if (inv.customer_id) {
      try {
        const [customer] = await query('SELECT email, first_name, last_name FROM contacts WHERE id = ?', [inv.customer_id]);
        if (customer && customer.email) {
          const [invoiceWithMeta] = await query(`
            SELECT i.*,
              c.first_name as customer_first_name, c.last_name as customer_last_name,
              c.email as customer_email, c.phone as customer_phone,
              s.full_name as staff_name,
              b.name as branch_name
            FROM invoices i
            LEFT JOIN contacts c ON i.customer_id = c.id
            LEFT JOIN staff s ON i.staff_id = s.id
            LEFT JOIN branches b ON i.branch_id = b.id
            WHERE i.id = ? AND i.tenant_id = ?
          `, [req.params.id, req.tenantId]);

          const paidItems = await query('SELECT * FROM invoice_items WHERE invoice_id = ?', [req.params.id]);
          invoiceWithMeta.items = paidItems;

          const tenantInfo = await getTenantInfo(req.tenantId);
          const receiptPdf = await generateReceiptPDF(invoiceWithMeta, tenantInfo);

          const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Valued Client';
          const paymentParts = [];
          if (loyaltyAmt > 0) paymentParts.push(`${loyaltyAmt} loyalty points`);
          if (remainingAfterLoyalty > 0) paymentParts.push(`${remainingAfterLoyalty} via ${payment_method}`);
          
          await sendNotificationEmail({
            to: customer.email,
            subject: newStatus === 'paid' 
              ? `Payment Confirmation — Invoice ${inv.invoice_number}`
              : `Partial Payment Received — Invoice ${inv.invoice_number}`,
            title: newStatus === 'paid' 
              ? `Payment Confirmed — Invoice ${inv.invoice_number}`
              : `Partial Payment Received`,
            body: `
              <p>Dear ${customerName},</p>
              <p>${newStatus === 'paid' ? 'Thank you! Your payment has been received and your invoice is now fully paid.' : 'We have received a partial payment on your invoice.'}</p>
              <ul>
                <li><strong>Invoice Number:</strong> ${inv.invoice_number}</li>
                <li><strong>Amount Paid:</strong> ${inv.currency} ${totalAmount.toFixed(2)}</li>
                <li><strong>Payment Method:</strong> ${paymentParts.join(' + ') || payment_method}</li>
                <li><strong>Total Paid:</strong> ${inv.currency} ${newPaid.toFixed(2)} of ${inv.currency} ${parseFloat(currentInv.total).toFixed(2)}</li>
                ${newStatus === 'paid' ? '<li><strong>Status:</strong> Fully Paid ✅</li>' : `<li><strong>Remaining Balance:</strong> ${inv.currency} ${(parseFloat(currentInv.total) - newPaid).toFixed(2)}</li>`}
              </ul>
              ${loyaltyResult ? `<p><strong>Bonus:</strong> You earned ${loyaltyResult.points_earned} loyalty points!</p>` : ''}
              <p>Thank you for your payment!</p>
            `,
            tenantId: req.tenantId,
            attachments: [{
              filename: `receipt-${inv.invoice_number}.pdf`,
              content: receiptPdf,
              contentType: 'application/pdf',
            }],
          }).catch(err => console.error('Failed to send payment email:', err.message));
        }
      } catch (emailErr) {
        console.error('Error sending payment email:', emailErr);
      }
    }

    res.json({ 
      success: true, 
      data: { amount_paid: newPaid, status: newStatus }, 
      message: parts.join(' · '),
      loyalty: loyaltyResult,
      loyalty_redeem: loyaltyRedeemResult,
      gift_card: giftCardResult,
      discount: discountResult
    });
  } catch (error) {
    console.error('Record payment error:', error);
    res.status(500).json({ success: false, message: error.message || 'Server error' });
  }
});

// ── Void invoice ──
router.post('/:id/void', async (req, res) => {
  try {
    await execute("UPDATE invoices SET status = 'void' WHERE id = ? AND tenant_id = ?", [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Invoice voided' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Delete (only draft) ──
router.delete('/:id', async (req, res) => {
  try {
    const [inv] = await query("SELECT status FROM invoices WHERE id = ? AND tenant_id = ?", [req.params.id, req.tenantId]);
    if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found' });
    if (inv.status !== 'draft') return res.status(400).json({ success: false, message: 'Only draft invoices can be deleted' });

    await execute('DELETE FROM invoice_items WHERE invoice_id = ?', [req.params.id]);
    await execute('DELETE FROM invoices WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Invoice deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
