import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

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
    const { status, customer_id, from_date, to_date, search, page = 1, limit = 20 } = req.query;
    let where = 'WHERE i.tenant_id = ?';
    const params = [t];

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
    const {
      branch_id, appointment_id, customer_id, staff_id,
      items = [], discount_amount: rawDiscount, discount_value, discount_type = 'fixed',
      tax_rate = 0, currency = 'AED', payment_method, notes, due_date, status = 'draft'
    } = req.body;
    // Accept both discount_amount and discount_value
    const discount_amount = parseFloat(rawDiscount ?? discount_value ?? 0);

    if (!customer_id) return res.status(400).json({ success: false, message: 'Customer is required' });
    if (!items.length) return res.status(400).json({ success: false, message: 'At least one item is required' });

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

    const result = await execute(`
      INSERT INTO invoices (tenant_id, appointment_id, customer_id, staff_id,
        invoice_number, subtotal, discount_amount, tax_rate, tax_amount,
        total, currency, status, created_by)
      VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?,?)
    `, [t, appointmentId, apt.customer_id, apt.staff_id, invoiceNumber, subtotal, disc, tax_rate, taxAmount, total, apt.currency || 'AED', 'draft', req.user?.id || null]);

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

    res.json({ success: true, message: 'Invoice updated' });
  } catch (error) {
    console.error('Update invoice error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Record payment ──
router.post('/:id/pay', async (req, res) => {
  try {
    const { amount, payment_method = 'cash' } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: 'Valid amount required' });

    const [inv] = await query('SELECT * FROM invoices WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found' });

    const newPaid = parseFloat(inv.amount_paid || 0) + parseFloat(amount);
    const newStatus = newPaid >= parseFloat(inv.total) ? 'paid' : 'partially_paid';

    await execute(`
      UPDATE invoices SET amount_paid = ?, status = ?, payment_method = ?, paid_at = IF(? = 'paid', NOW(), paid_at)
      WHERE id = ? AND tenant_id = ?
    `, [newPaid, newStatus, payment_method, newStatus, req.params.id, req.tenantId]);

    res.json({ success: true, data: { amount_paid: newPaid, status: newStatus }, message: `Payment of ${amount} recorded` });
  } catch (error) {
    console.error('Record payment error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
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
