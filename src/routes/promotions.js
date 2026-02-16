import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

async function ensureTables() {
  await execute(`
    CREATE TABLE IF NOT EXISTS promotions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      branch_id INT,
      name VARCHAR(255) NOT NULL,
      name_ar VARCHAR(255),
      description TEXT,
      type ENUM('percentage','fixed','buy_x_get_y','happy_hour','referral','birthday','first_visit') DEFAULT 'percentage',
      discount_value DECIMAL(10,2) DEFAULT 0,
      min_spend DECIMAL(10,2) DEFAULT 0,
      applies_to ENUM('all_services','specific_services','specific_categories') DEFAULT 'all_services',
      service_ids JSON,
      category_ids JSON,
      start_date DATE,
      end_date DATE,
      valid_days JSON,
      valid_hours JSON,
      usage_limit INT DEFAULT 0,
      used_count INT DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_active (is_active),
      INDEX idx_dates (start_date, end_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS discount_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      promotion_id INT,
      code VARCHAR(50) NOT NULL,
      max_uses INT DEFAULT 0,
      used_count INT DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_code (code),
      INDEX idx_promo (promotion_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS discount_usage (
      id INT AUTO_INCREMENT PRIMARY KEY,
      discount_code_id INT,
      promotion_id INT,
      customer_id INT,
      appointment_id INT,
      invoice_id INT,
      discount_amount DECIMAL(10,2),
      used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_code (discount_code_id),
      INDEX idx_customer (customer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
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
        SUM(CASE WHEN is_active = 1 AND (end_date IS NULL OR end_date >= CURDATE()) THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN end_date < CURDATE() THEN 1 ELSE 0 END) as expired,
        SUM(used_count) as total_uses
      FROM promotions WHERE tenant_id = ?
    `, [t]);
    const [codeStats] = await query(`
      SELECT COUNT(*) as total_codes, SUM(used_count) as code_uses
      FROM discount_codes WHERE tenant_id = ?
    `, [t]);
    const [savings] = await query(`
      SELECT COALESCE(SUM(du.discount_amount), 0) as total_savings
      FROM discount_usage du
      LEFT JOIN discount_codes dc ON du.discount_code_id = dc.id
      WHERE dc.tenant_id = ?
    `, [t]);
    res.json({ success: true, data: { ...stats, ...codeStats, total_savings: savings?.total_savings || 0 } });
  } catch (error) {
    console.error('Promotion stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── List promotions ──
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { active, type, page = 1, limit = 50 } = req.query;
    let where = 'WHERE p.tenant_id = ?';
    const params = [t];
    if (active !== undefined) { where += ' AND p.is_active = ?'; params.push(active === 'true' ? 1 : 0); }
    if (type) { where += ' AND p.type = ?'; params.push(type); }

    const promos = await query(`
      SELECT p.*,
        (SELECT COUNT(*) FROM discount_codes WHERE promotion_id = p.id) as code_count,
        b.name as branch_name
      FROM promotions p
      LEFT JOIN branches b ON p.branch_id = b.id
      ${where}
      ORDER BY p.created_at DESC
    `, params);

    // Parse JSON fields
    for (const p of promos) {
      try { p.service_ids = typeof p.service_ids === 'string' ? JSON.parse(p.service_ids) : p.service_ids; } catch(e) { p.service_ids = []; }
      try { p.category_ids = typeof p.category_ids === 'string' ? JSON.parse(p.category_ids) : p.category_ids; } catch(e) { p.category_ids = []; }
      try { p.valid_days = typeof p.valid_days === 'string' ? JSON.parse(p.valid_days) : p.valid_days; } catch(e) { p.valid_days = []; }
      try { p.valid_hours = typeof p.valid_hours === 'string' ? JSON.parse(p.valid_hours) : p.valid_hours; } catch(e) { p.valid_hours = null; }
    }

    res.json({ success: true, data: promos });
  } catch (error) {
    console.error('List promotions error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Get single ──
router.get('/:id', async (req, res) => {
  try {
    await ensureTables();
    const [promo] = await query('SELECT * FROM promotions WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!promo) return res.status(404).json({ success: false, message: 'Promotion not found' });

    try { promo.service_ids = typeof promo.service_ids === 'string' ? JSON.parse(promo.service_ids) : promo.service_ids; } catch(e) {}
    try { promo.category_ids = typeof promo.category_ids === 'string' ? JSON.parse(promo.category_ids) : promo.category_ids; } catch(e) {}
    try { promo.valid_days = typeof promo.valid_days === 'string' ? JSON.parse(promo.valid_days) : promo.valid_days; } catch(e) {}
    try { promo.valid_hours = typeof promo.valid_hours === 'string' ? JSON.parse(promo.valid_hours) : promo.valid_hours; } catch(e) {}

    promo.codes = await query('SELECT * FROM discount_codes WHERE promotion_id = ?', [promo.id]);
    promo.usage = await query(`
      SELECT du.*, c.first_name, c.last_name
      FROM discount_usage du
      LEFT JOIN contacts c ON du.customer_id = c.id
      WHERE du.promotion_id = ?
      ORDER BY du.used_at DESC LIMIT 50
    `, [promo.id]);

    res.json({ success: true, data: promo });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Create ──
router.post('/', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { name, name_ar, description, type = 'percentage', discount_value, min_spend = 0, applies_to = 'all_services', service_ids = [], category_ids = [], start_date, end_date, valid_days, valid_hours, usage_limit = 0, branch_id, is_active = 1 } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'Name is required' });

    const result = await execute(`
      INSERT INTO promotions (tenant_id, branch_id, name, name_ar, description, type, discount_value, min_spend, applies_to, service_ids, category_ids, start_date, end_date, valid_days, valid_hours, usage_limit, is_active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [t, branch_id || null, name, name_ar || null, description || null, type, discount_value || 0, min_spend,
        applies_to, JSON.stringify(service_ids), JSON.stringify(category_ids),
        start_date || null, end_date || null, valid_days ? JSON.stringify(valid_days) : null,
        valid_hours ? JSON.stringify(valid_hours) : null, usage_limit, is_active]);

    res.status(201).json({ success: true, data: { id: result.insertId }, message: 'Promotion created' });
  } catch (error) {
    console.error('Create promotion error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Update ──
router.patch('/:id', async (req, res) => {
  try {
    const fields = ['name', 'name_ar', 'description', 'type', 'discount_value', 'min_spend', 'applies_to', 'start_date', 'end_date', 'usage_limit', 'branch_id', 'is_active'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (req.body.service_ids !== undefined) { updates.push('service_ids = ?'); params.push(JSON.stringify(req.body.service_ids)); }
    if (req.body.category_ids !== undefined) { updates.push('category_ids = ?'); params.push(JSON.stringify(req.body.category_ids)); }
    if (req.body.valid_days !== undefined) { updates.push('valid_days = ?'); params.push(JSON.stringify(req.body.valid_days)); }
    if (req.body.valid_hours !== undefined) { updates.push('valid_hours = ?'); params.push(JSON.stringify(req.body.valid_hours)); }
    if (!updates.length) return res.status(400).json({ success: false, message: 'No fields to update' });

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE promotions SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    res.json({ success: true, message: 'Promotion updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Delete ──
router.delete('/:id', async (req, res) => {
  try {
    await execute('DELETE FROM discount_codes WHERE promotion_id = ?', [req.params.id]);
    await execute('DELETE FROM promotions WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Promotion deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Generate discount code ──
router.post('/:id/codes', async (req, res) => {
  try {
    await ensureTables();
    const { code, max_uses = 0 } = req.body;

    const genCode = code || generateCode();
    // Ensure unique
    const [existing] = await query('SELECT id FROM discount_codes WHERE code = ? AND tenant_id = ?', [genCode, req.tenantId]);
    if (existing) return res.status(409).json({ success: false, message: 'Code already exists' });

    const result = await execute('INSERT INTO discount_codes (tenant_id, promotion_id, code, max_uses) VALUES (?,?,?,?)',
      [req.tenantId, req.params.id, genCode, max_uses]);

    res.status(201).json({ success: true, data: { id: result.insertId, code: genCode }, message: 'Discount code created' });
  } catch (error) {
    console.error('Create discount code error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Validate & apply discount code ──
router.post('/validate', async (req, res) => {
  try {
    await ensureTables();
    const { code, service_id, category_id, subtotal = 0, customer_id } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Code is required' });

    const [dc] = await query(`
      SELECT dc.*, p.* FROM discount_codes dc
      LEFT JOIN promotions p ON dc.promotion_id = p.id
      WHERE dc.code = ? AND dc.tenant_id = ? AND dc.is_active = 1
    `, [code, req.tenantId]);

    if (!dc) return res.status(404).json({ success: false, message: 'Invalid discount code' });

    // Check promo active
    if (!dc.is_active) return res.status(400).json({ success: false, message: 'Promotion is not active' });

    // Check dates
    const now = new Date();
    if (dc.start_date && new Date(dc.start_date) > now) return res.status(400).json({ success: false, message: 'Promotion has not started yet' });
    if (dc.end_date && new Date(dc.end_date) < now) return res.status(400).json({ success: false, message: 'Promotion has expired' });

    // Check usage limit
    if (dc.max_uses > 0 && dc.used_count >= dc.max_uses) return res.status(400).json({ success: false, message: 'Code usage limit reached' });

    // Check promo usage limit
    if (dc.usage_limit > 0 && dc.used_count >= dc.usage_limit) return res.status(400).json({ success: false, message: 'Promotion usage limit reached' });

    // Check minimum spend
    if (dc.min_spend > 0 && subtotal < dc.min_spend) return res.status(400).json({ success: false, message: `Minimum spend of ${dc.min_spend} required` });

    // Calculate discount
    let discountAmount = 0;
    if (dc.type === 'percentage') {
      discountAmount = subtotal * (dc.discount_value / 100);
    } else if (dc.type === 'fixed') {
      discountAmount = dc.discount_value;
    }

    res.json({
      success: true,
      data: {
        valid: true,
        promotion_id: dc.promotion_id,
        discount_code_id: dc.id,
        type: dc.type,
        discount_value: dc.discount_value,
        discount_amount: discountAmount,
        message: `${dc.type === 'percentage' ? dc.discount_value + '%' : dc.discount_value} off`
      }
    });
  } catch (error) {
    console.error('Validate code error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Apply discount (record usage) ──
router.post('/apply', async (req, res) => {
  try {
    await ensureTables();
    const { discount_code_id, promotion_id, customer_id, appointment_id, invoice_id, discount_amount } = req.body;

    await execute(`INSERT INTO discount_usage (discount_code_id, promotion_id, customer_id, appointment_id, invoice_id, discount_amount) VALUES (?,?,?,?,?,?)`,
      [discount_code_id || null, promotion_id || null, customer_id || null, appointment_id || null, invoice_id || null, discount_amount || 0]);

    // Increment counters
    if (discount_code_id) {
      await execute('UPDATE discount_codes SET used_count = used_count + 1 WHERE id = ?', [discount_code_id]);
    }
    if (promotion_id) {
      await execute('UPDATE promotions SET used_count = used_count + 1 WHERE id = ?', [promotion_id]);
    }

    res.json({ success: true, message: 'Discount applied' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export default router;
