import express from 'express';
import crypto from 'crypto';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

async function ensureTables() {
  await execute(`
    CREATE TABLE IF NOT EXISTS gift_cards (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      code VARCHAR(20) NOT NULL,
      initial_value DECIMAL(12,2) NOT NULL,
      remaining_value DECIMAL(12,2) NOT NULL,
      currency VARCHAR(10) DEFAULT 'AED',
      issued_to_name VARCHAR(255),
      issued_to_email VARCHAR(255),
      issued_to_phone VARCHAR(50),
      issued_by INT,
      purchased_by INT,
      message TEXT,
      template VARCHAR(50) DEFAULT 'classic',
      status ENUM('active','redeemed','expired','void') DEFAULT 'active',
      expires_at DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_code (code),
      INDEX idx_status (status),
      UNIQUE KEY uq_code (tenant_id, code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS gift_card_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      gift_card_id INT NOT NULL,
      tenant_id INT NOT NULL,
      type ENUM('purchase','redeem','refund','void','adjustment') DEFAULT 'purchase',
      amount DECIMAL(12,2) NOT NULL,
      balance_after DECIMAL(12,2),
      invoice_id INT,
      notes TEXT,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_gift_card (gift_card_id),
      INDEX idx_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      code += chars[crypto.randomInt(chars.length)];
    }
    if (i < 3) code += '-';
  }
  return code;
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
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
        SUM(initial_value) as total_sold,
        SUM(remaining_value) as total_outstanding,
        SUM(initial_value - remaining_value) as total_redeemed
      FROM gift_cards WHERE tenant_id = ?
    `, [t]);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Gift card stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── List ──
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { status, search, page = 1, limit = 20 } = req.query;
    let where = 'WHERE tenant_id = ?';
    const params = [t];
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (search) { where += ' AND (code LIKE ? OR issued_to_name LIKE ? OR issued_to_email LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

    const [{ total }] = await query(`SELECT COUNT(*) as total FROM gift_cards ${where}`, [...params]);
    const pg = parseInt(page); const lm = parseInt(limit);
    const cards = await query(`SELECT * FROM gift_cards ${where} ORDER BY created_at DESC LIMIT ${lm} OFFSET ${(pg - 1) * lm}`, [...params]);

    res.json({ success: true, data: cards, pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) } });
  } catch (error) {
    console.error('List gift cards error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Get single ──
router.get('/:id', async (req, res) => {
  try {
    await ensureTables();
    const [card] = await query('SELECT * FROM gift_cards WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!card) return res.status(404).json({ success: false, message: 'Gift card not found' });

    const transactions = await query('SELECT * FROM gift_card_transactions WHERE gift_card_id = ? ORDER BY created_at DESC', [card.id]);
    card.transactions = transactions;

    res.json({ success: true, data: card });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Create (sell) gift card ──
router.post('/', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { initial_value, currency = 'AED', issued_to_name, issued_to_email, issued_to_phone, message, template = 'classic', validity_months = 12, notes } = req.body;

    if (!initial_value || initial_value <= 0) return res.status(400).json({ success: false, message: 'Valid amount required' });

    // Generate unique code
    let code;
    let attempts = 0;
    while (attempts < 10) {
      code = generateCode();
      const [exists] = await query('SELECT id FROM gift_cards WHERE code = ? AND tenant_id = ?', [code, t]);
      if (!exists) break;
      attempts++;
    }

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + parseInt(validity_months));
    const expiresStr = expiresAt.toISOString().split('T')[0];

    const result = await execute(`
      INSERT INTO gift_cards (tenant_id, code, initial_value, remaining_value, currency,
        issued_to_name, issued_to_email, issued_to_phone, message, template,
        issued_by, status, expires_at, notes)
      VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?,?)
    `, [t, code, initial_value, initial_value, currency, issued_to_name || null, issued_to_email || null, issued_to_phone || null, message || null, template, req.user?.id || null, 'active', expiresStr, notes || null]);

    // Record purchase transaction
    await execute(`
      INSERT INTO gift_card_transactions (gift_card_id, tenant_id, type, amount, balance_after, created_by)
      VALUES (?, ?, 'purchase', ?, ?, ?)
    `, [result.insertId, t, initial_value, initial_value, req.user?.id || null]);

    res.status(201).json({ success: true, data: { id: result.insertId, code, initial_value, expires_at: expiresStr }, message: 'Gift card created' });
  } catch (error) {
    console.error('Create gift card error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Redeem by code ──
router.post('/redeem', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { code, amount, invoice_id } = req.body;

    if (!code || !amount || amount <= 0) return res.status(400).json({ success: false, message: 'Code and valid amount required' });

    const [card] = await query("SELECT * FROM gift_cards WHERE code = ? AND tenant_id = ? AND status = 'active'", [code, t]);
    if (!card) return res.status(404).json({ success: false, message: 'Gift card not found or not active' });

    // Check expiry
    if (card.expires_at && new Date(card.expires_at) < new Date()) {
      await execute("UPDATE gift_cards SET status = 'expired' WHERE id = ?", [card.id]);
      return res.status(400).json({ success: false, message: 'Gift card has expired' });
    }

    if (amount > parseFloat(card.remaining_value)) {
      return res.status(400).json({ success: false, message: `Insufficient balance. Remaining: ${card.remaining_value}` });
    }

    const newBalance = parseFloat(card.remaining_value) - amount;
    const newStatus = newBalance <= 0 ? 'redeemed' : 'active';

    await execute('UPDATE gift_cards SET remaining_value = ?, status = ? WHERE id = ?', [newBalance, newStatus, card.id]);

    await execute(`
      INSERT INTO gift_card_transactions (gift_card_id, tenant_id, type, amount, balance_after, invoice_id, created_by)
      VALUES (?, ?, 'redeem', ?, ?, ?, ?)
    `, [card.id, t, amount, newBalance, invoice_id || null, req.user?.id || null]);

    res.json({ success: true, data: { remaining_value: newBalance, status: newStatus }, message: `Redeemed ${amount}. Remaining: ${newBalance}` });
  } catch (error) {
    console.error('Redeem gift card error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Check balance by code ──
router.get('/check/:code', async (req, res) => {
  try {
    await ensureTables();
    const [card] = await query('SELECT id, code, initial_value, remaining_value, status, expires_at FROM gift_cards WHERE code = ? AND tenant_id = ?', [req.params.code, req.tenantId]);
    if (!card) return res.status(404).json({ success: false, message: 'Gift card not found' });
    res.json({ success: true, data: card });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Void gift card ──
router.post('/:id/void', async (req, res) => {
  try {
    const [card] = await query('SELECT * FROM gift_cards WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!card) return res.status(404).json({ success: false, message: 'Gift card not found' });

    await execute("UPDATE gift_cards SET status = 'void' WHERE id = ?", [card.id]);
    await execute(`
      INSERT INTO gift_card_transactions (gift_card_id, tenant_id, type, amount, balance_after, notes, created_by)
      VALUES (?, ?, 'void', ?, 0, 'Card voided', ?)
    `, [card.id, req.tenantId, card.remaining_value, req.user?.id || null]);

    res.json({ success: true, message: 'Gift card voided' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
