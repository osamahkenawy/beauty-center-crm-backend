import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { redeemGiftCard } from './gift-cards.js';
import { notifyPOS } from '../lib/notify.js';

const router = express.Router();
router.use(authMiddleware);

// ── Ensure table ──
async function ensureTable(tenantId) {
  await execute(`
    CREATE TABLE IF NOT EXISTS pos_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      branch_id INT,
      staff_id INT,
      customer_id INT,
      transaction_number VARCHAR(30),
      type ENUM('sale','refund','void') DEFAULT 'sale',
      items JSON,
      subtotal DECIMAL(10,2) DEFAULT 0,
      discount_amount DECIMAL(10,2) DEFAULT 0,
      discount_type ENUM('fixed','percentage') DEFAULT 'fixed',
      tax_rate DECIMAL(5,2) DEFAULT 0,
      tax_amount DECIMAL(10,2) DEFAULT 0,
      tip DECIMAL(10,2) DEFAULT 0,
      total DECIMAL(10,2) DEFAULT 0,
      amount_paid DECIMAL(10,2) DEFAULT 0,
      change_given DECIMAL(10,2) DEFAULT 0,
      payment_method ENUM('cash','card','bank_transfer','gift_card','split','other') DEFAULT 'cash',
      payment_details JSON,
      invoice_id INT,
      appointment_id INT,
      status ENUM('completed','refunded','voided') DEFAULT 'completed',
      notes TEXT,
      receipt_printed TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_branch (branch_id),
      INDEX idx_customer (customer_id),
      INDEX idx_date (created_at)
    )
  `);

  // Daily cash drawer table
  await execute(`
    CREATE TABLE IF NOT EXISTS cash_drawer (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      branch_id INT,
      staff_id INT NOT NULL,
      opening_amount DECIMAL(10,2) DEFAULT 0,
      closing_amount DECIMAL(10,2),
      expected_amount DECIMAL(10,2),
      difference DECIMAL(10,2),
      cash_in DECIMAL(10,2) DEFAULT 0,
      cash_out DECIMAL(10,2) DEFAULT 0,
      status ENUM('open','closed') DEFAULT 'open',
      opened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME,
      notes TEXT,
      INDEX idx_tenant (tenant_id),
      INDEX idx_branch (branch_id)
    )
  `);
}

// Auto-generate transaction number
async function nextTransactionNumber(tenantId) {
  const [row] = await query(
    'SELECT COUNT(*) as cnt FROM pos_transactions WHERE tenant_id = ?',
    [tenantId]
  );
  const num = (row?.cnt || 0) + 1;
  return `TXN-${String(num).padStart(5, '0')}`;
}

// ════════════════════════════════════════
// POS Checkout (main sale endpoint)
// ════════════════════════════════════════
router.post('/checkout', async (req, res) => {
  try {
    await ensureTable(req.tenantId);
    const tenantId = req.tenantId;
    const {
      branch_id, customer_id, items = [], 
      discount_amount = 0, discount_type = 'fixed',
      tax_rate = 5, tip = 0,
      payment_method = 'cash', payment_details = null,
      gift_card_code,
      amount_paid = 0, appointment_id = null, notes = ''
    } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one item required' });
    }

    // Require gift card code when paying by gift card
    if (payment_method === 'gift_card' && !gift_card_code) {
      return res.status(400).json({ success: false, message: 'Gift card code is required for gift card payments' });
    }

    // Calculate totals
    let subtotal = 0;
    const processedItems = items.map(item => {
      const lineTotal = (parseFloat(item.price) || 0) * (parseInt(item.quantity) || 1);
      subtotal += lineTotal;
      return {
        type: item.type || 'service', // service, product, custom
        id: item.id || null,
        name: item.name,
        quantity: item.quantity || 1,
        price: parseFloat(item.price) || 0,
        total: lineTotal
      };
    });

    subtotal += parseFloat(tip) || 0;

    const discountAmt = discount_type === 'percentage'
      ? subtotal * (parseFloat(discount_amount) / 100)
      : parseFloat(discount_amount) || 0;

    const afterDiscount = subtotal - discountAmt;
    const taxAmt = afterDiscount * (parseFloat(tax_rate) / 100);
    const total = afterDiscount + taxAmt;
    const paidAmount = parseFloat(amount_paid) || total;
    const changeGiven = Math.max(0, paidAmount - total);

    const txnNumber = await nextTransactionNumber(tenantId);

    const result = await execute(`
      INSERT INTO pos_transactions 
      (tenant_id, branch_id, staff_id, customer_id, transaction_number, type,
       items, subtotal, discount_amount, discount_type, tax_rate, tax_amount,
       tip, total, amount_paid, change_given, payment_method, payment_details,
       invoice_id, appointment_id, notes)
      VALUES (?, ?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      tenantId, branch_id || null, req.user.id, customer_id || null,
      txnNumber, JSON.stringify(processedItems),
      subtotal.toFixed(2), discountAmt.toFixed(2), discount_type,
      tax_rate, taxAmt.toFixed(2), (parseFloat(tip) || 0).toFixed(2),
      total.toFixed(2), paidAmount.toFixed(2), changeGiven.toFixed(2),
      payment_method, payment_details ? JSON.stringify(payment_details) : null,
      null, appointment_id || null, notes || null
    ]);

    // If paying with gift card, redeem now
    let giftCardResult = null;
    if (payment_method === 'gift_card' && gift_card_code) {
      giftCardResult = await redeemGiftCard(tenantId, gift_card_code, parseFloat(total.toFixed(2)), {
        created_by: req.user?.id
      });
      if (!giftCardResult.success) {
        // Rollback: void the POS transaction
        await execute("UPDATE pos_transactions SET status = 'voided' WHERE id = ?", [result.insertId]);
        return res.status(400).json({ success: false, message: giftCardResult.message });
      }
    }

    // Push notification
    notifyPOS(req.tenantId, `POS Sale — ${txnNumber}`, `Total: ${total.toFixed(2)} via ${payment_method}`, { pos_id: result.insertId, total: parseFloat(total.toFixed(2)), payment_method }).catch(() => {});

    res.status(201).json({
      success: true,
      message: 'Sale completed',
      data: {
        id: result.insertId,
        transaction_number: txnNumber,
        subtotal: parseFloat(subtotal.toFixed(2)),
        discount: parseFloat(discountAmt.toFixed(2)),
        tax: parseFloat(taxAmt.toFixed(2)),
        tip: parseFloat(tip) || 0,
        total: parseFloat(total.toFixed(2)),
        amount_paid: parseFloat(paidAmount.toFixed(2)),
        change: parseFloat(changeGiven.toFixed(2)),
        payment_method,
        items: processedItems,
        gift_card: giftCardResult
      }
    });
  } catch (error) {
    console.error('POS checkout error:', error);
    res.status(500).json({ success: false, message: 'Checkout failed' });
  }
});

// ════════════════════════════════════════
// List transactions
// ════════════════════════════════════════
router.get('/transactions', async (req, res) => {
  try {
    await ensureTable(req.tenantId);
    const { branch_id, staff_id, customer_id, type, status, from_date, to_date, page = 1, limit = 20 } = req.query;
    const tenantId = req.tenantId;

    let where = 'WHERE t.tenant_id = ?';
    const params = [tenantId];

    if (branch_id) { where += ' AND t.branch_id = ?'; params.push(branch_id); }
    if (staff_id) { where += ' AND t.staff_id = ?'; params.push(staff_id); }
    if (customer_id) { where += ' AND t.customer_id = ?'; params.push(customer_id); }
    if (type) { where += ' AND t.type = ?'; params.push(type); }
    if (status) { where += ' AND t.status = ?'; params.push(status); }
    if (from_date) { where += ' AND DATE(t.created_at) >= ?'; params.push(from_date); }
    if (to_date) { where += ' AND DATE(t.created_at) <= ?'; params.push(to_date); }

    const [countRow] = await query(
      `SELECT COUNT(*) as cnt FROM pos_transactions t ${where}`, params
    );
    const total = countRow?.cnt || 0;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const rows = await query(`
      SELECT t.*, 
             s.full_name as staff_name,
             c.first_name as customer_first_name, c.last_name as customer_last_name,
             b.name as branch_name
      FROM pos_transactions t
      LEFT JOIN staff s ON t.staff_id = s.id
      LEFT JOIN contacts c ON t.customer_id = c.id
      LEFT JOIN branches b ON t.branch_id = b.id
      ${where}
      ORDER BY t.created_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${offset}
    `, params);

    // Parse JSON items
    const data = rows.map(r => ({
      ...r,
      items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items,
      payment_details: typeof r.payment_details === 'string' ? JSON.parse(r.payment_details) : r.payment_details
    }));

    res.json({
      success: true,
      data,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (error) {
    console.error('POS list error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
  }
});

// ════════════════════════════════════════
// Get single transaction
// ════════════════════════════════════════
router.get('/transactions/:id', async (req, res) => {
  try {
    await ensureTable(req.tenantId);
    const [txn] = await query(`
      SELECT t.*, 
             s.full_name as staff_name,
             c.first_name as customer_first_name, c.last_name as customer_last_name,
             b.name as branch_name
      FROM pos_transactions t
      LEFT JOIN staff s ON t.staff_id = s.id
      LEFT JOIN contacts c ON t.customer_id = c.id
      LEFT JOIN branches b ON t.branch_id = b.id
      WHERE t.id = ? AND t.tenant_id = ?
    `, [req.params.id, req.tenantId]);

    if (!txn) return res.status(404).json({ success: false, message: 'Transaction not found' });

    txn.items = typeof txn.items === 'string' ? JSON.parse(txn.items) : txn.items;
    txn.payment_details = typeof txn.payment_details === 'string' ? JSON.parse(txn.payment_details) : txn.payment_details;

    res.json({ success: true, data: txn });
  } catch (error) {
    console.error('POS get error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch transaction' });
  }
});

// ════════════════════════════════════════
// Refund
// ════════════════════════════════════════
router.post('/refund/:id', async (req, res) => {
  try {
    await ensureTable(req.tenantId);
    const [txn] = await query(
      'SELECT * FROM pos_transactions WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantId]
    );
    if (!txn) return res.status(404).json({ success: false, message: 'Transaction not found' });
    if (txn.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Can only refund completed transactions' });
    }

    const { amount, reason = '' } = req.body;
    const refundAmount = parseFloat(amount) || parseFloat(txn.total);

    // Create refund transaction
    const txnNumber = await nextTransactionNumber(req.tenantId);
    const result = await execute(`
      INSERT INTO pos_transactions 
      (tenant_id, branch_id, staff_id, customer_id, transaction_number, type,
       items, subtotal, total, amount_paid, payment_method, notes, status)
      VALUES (?, ?, ?, ?, ?, 'refund', ?, ?, ?, ?, ?, ?, 'completed')
    `, [
      req.tenantId, txn.branch_id, req.user.id, txn.customer_id,
      txnNumber, txn.items,
      (-refundAmount).toFixed(2), (-refundAmount).toFixed(2), (-refundAmount).toFixed(2),
      txn.payment_method, `Refund for ${txn.transaction_number}. ${reason}`.trim()
    ]);

    // Mark original as refunded
    await execute(
      'UPDATE pos_transactions SET status = ? WHERE id = ?',
      ['refunded', req.params.id]
    );

    res.json({
      success: true,
      message: 'Refund processed',
      data: {
        id: result.insertId,
        transaction_number: txnNumber,
        refund_amount: refundAmount,
        original_transaction: txn.transaction_number
      }
    });
  } catch (error) {
    console.error('POS refund error:', error);
    res.status(500).json({ success: false, message: 'Refund failed' });
  }
});

// ════════════════════════════════════════
// POS Stats / Daily Summary
// ════════════════════════════════════════
router.get('/stats', async (req, res) => {
  try {
    await ensureTable(req.tenantId);
    const tenantId = req.tenantId;
    const { date, branch_id } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    let branchFilter = '';
    const params = [tenantId, targetDate, tenantId, targetDate, tenantId, targetDate, tenantId, targetDate, tenantId, targetDate];
    if (branch_id) {
      branchFilter = ' AND branch_id = ?';
    }

    // Multiple stats queries
    const [todaySales] = await query(`
      SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as revenue
      FROM pos_transactions WHERE tenant_id = ? AND DATE(created_at) = ? AND type = 'sale' AND status = 'completed'${branchFilter}
    `, branch_id ? [tenantId, targetDate, branch_id] : [tenantId, targetDate]);

    const [todayRefunds] = await query(`
      SELECT COUNT(*) as count, COALESCE(SUM(ABS(total)), 0) as amount
      FROM pos_transactions WHERE tenant_id = ? AND DATE(created_at) = ? AND type = 'refund'${branchFilter}
    `, branch_id ? [tenantId, targetDate, branch_id] : [tenantId, targetDate]);

    const [todayTips] = await query(`
      SELECT COALESCE(SUM(tip), 0) as total_tips
      FROM pos_transactions WHERE tenant_id = ? AND DATE(created_at) = ? AND type = 'sale' AND status = 'completed'${branchFilter}
    `, branch_id ? [tenantId, targetDate, branch_id] : [tenantId, targetDate]);

    // By payment method
    const byMethod = await query(`
      SELECT payment_method, COUNT(*) as count, COALESCE(SUM(total), 0) as amount
      FROM pos_transactions WHERE tenant_id = ? AND DATE(created_at) = ? AND type = 'sale' AND status = 'completed'${branchFilter}
      GROUP BY payment_method
    `, branch_id ? [tenantId, targetDate, branch_id] : [tenantId, targetDate]);

    // Overall stats
    const [allTime] = await query(`
      SELECT COUNT(*) as total_transactions, COALESCE(SUM(total), 0) as total_revenue
      FROM pos_transactions WHERE tenant_id = ? AND type = 'sale' AND status = 'completed'${branchFilter}
    `, branch_id ? [tenantId, branch_id] : [tenantId]);

    res.json({
      success: true,
      data: {
        date: targetDate,
        today: {
          sales_count: todaySales?.count || 0,
          revenue: parseFloat(todaySales?.revenue || 0),
          refunds_count: todayRefunds?.count || 0,
          refunds_amount: parseFloat(todayRefunds?.amount || 0),
          net_revenue: parseFloat(todaySales?.revenue || 0) - parseFloat(todayRefunds?.amount || 0),
          tips: parseFloat(todayTips?.total_tips || 0),
        },
        by_payment_method: byMethod.map(m => ({
          method: m.payment_method,
          count: m.count,
          amount: parseFloat(m.amount)
        })),
        all_time: {
          total_transactions: allTime?.total_transactions || 0,
          total_revenue: parseFloat(allTime?.total_revenue || 0)
        }
      }
    });
  } catch (error) {
    console.error('POS stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ════════════════════════════════════════
// Cash Drawer
// ════════════════════════════════════════
router.post('/cash-drawer/open', async (req, res) => {
  try {
    await ensureTable(req.tenantId);
    const { opening_amount = 0, branch_id } = req.body;

    // Check if already open
    const [existing] = await query(
      'SELECT id FROM cash_drawer WHERE tenant_id = ? AND staff_id = ? AND status = ?',
      [req.tenantId, req.user.id, 'open']
    );
    if (existing) {
      return res.status(400).json({ success: false, message: 'Cash drawer already open' });
    }

    const result = await execute(`
      INSERT INTO cash_drawer (tenant_id, branch_id, staff_id, opening_amount)
      VALUES (?, ?, ?, ?)
    `, [req.tenantId, branch_id || null, req.user.id, opening_amount]);

    res.json({ success: true, message: 'Cash drawer opened', data: { id: result.insertId } });
  } catch (error) {
    console.error('Cash drawer open error:', error);
    res.status(500).json({ success: false, message: 'Failed to open cash drawer' });
  }
});

router.post('/cash-drawer/close', async (req, res) => {
  try {
    await ensureTable(req.tenantId);
    const { closing_amount = 0, notes = '' } = req.body;

    const [drawer] = await query(
      'SELECT * FROM cash_drawer WHERE tenant_id = ? AND staff_id = ? AND status = ?',
      [req.tenantId, req.user.id, 'open']
    );
    if (!drawer) {
      return res.status(400).json({ success: false, message: 'No open cash drawer found' });
    }

    // Calculate expected
    const [cashSales] = await query(`
      SELECT COALESCE(SUM(amount_paid), 0) as total
      FROM pos_transactions 
      WHERE tenant_id = ? AND payment_method = 'cash' AND type = 'sale' AND status = 'completed'
      AND created_at >= ?
    `, [req.tenantId, drawer.opened_at]);

    const [cashRefunds] = await query(`
      SELECT COALESCE(SUM(ABS(amount_paid)), 0) as total
      FROM pos_transactions 
      WHERE tenant_id = ? AND payment_method = 'cash' AND type = 'refund'
      AND created_at >= ?
    `, [req.tenantId, drawer.opened_at]);

    const expectedAmount = parseFloat(drawer.opening_amount) + parseFloat(cashSales?.total || 0) - parseFloat(cashRefunds?.total || 0);
    const difference = parseFloat(closing_amount) - expectedAmount;

    await execute(`
      UPDATE cash_drawer SET closing_amount = ?, expected_amount = ?, difference = ?,
      cash_in = ?, cash_out = ?, status = 'closed', closed_at = NOW(), notes = ?
      WHERE id = ?
    `, [closing_amount, expectedAmount.toFixed(2), difference.toFixed(2),
        (cashSales?.total || 0), (cashRefunds?.total || 0), notes, drawer.id]);

    res.json({
      success: true,
      message: 'Cash drawer closed',
      data: {
        opening_amount: parseFloat(drawer.opening_amount),
        closing_amount: parseFloat(closing_amount),
        expected_amount: expectedAmount,
        difference,
        cash_in: parseFloat(cashSales?.total || 0),
        cash_out: parseFloat(cashRefunds?.total || 0)
      }
    });
  } catch (error) {
    console.error('Cash drawer close error:', error);
    res.status(500).json({ success: false, message: 'Failed to close cash drawer' });
  }
});

router.get('/cash-drawer/current', async (req, res) => {
  try {
    await ensureTable(req.tenantId);
    const [drawer] = await query(
      'SELECT * FROM cash_drawer WHERE tenant_id = ? AND staff_id = ? AND status = ? ORDER BY opened_at DESC LIMIT 1',
      [req.tenantId, req.user.id, 'open']
    );
    res.json({ success: true, data: drawer || null });
  } catch (error) {
    console.error('Cash drawer current error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch cash drawer' });
  }
});

export default router;
