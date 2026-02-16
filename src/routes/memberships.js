import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

async function ensureTables() {
  await execute(`
    CREATE TABLE IF NOT EXISTS membership_plans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      name_ar VARCHAR(255),
      description TEXT,
      price DECIMAL(10,2) NOT NULL,
      currency VARCHAR(10) DEFAULT 'AED',
      billing_period ENUM('weekly','monthly','quarterly','yearly') DEFAULT 'monthly',
      sessions_included INT DEFAULT 0,
      discount_percent DECIMAL(5,2) DEFAULT 0,
      included_services JSON,
      features JSON,
      color VARCHAR(10) DEFAULT '#6c5ce7',
      is_active TINYINT(1) DEFAULT 1,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS customer_memberships (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      customer_id INT NOT NULL,
      plan_id INT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE,
      next_billing_date DATE,
      sessions_remaining INT DEFAULT 0,
      status ENUM('active','paused','cancelled','expired') DEFAULT 'active',
      auto_renew TINYINT(1) DEFAULT 1,
      cancelled_at DATETIME,
      cancel_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_customer (customer_id),
      INDEX idx_plan (plan_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

router.use(authMiddleware);

// ── Stats ──
router.get('/stats', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const [planStats] = await query(`
      SELECT COUNT(*) as total_plans, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_plans
      FROM membership_plans WHERE tenant_id = ?
    `, [t]);
    const [memberStats] = await query(`
      SELECT
        COUNT(*) as total_members,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_members,
        SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused_members,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled_members
      FROM customer_memberships WHERE tenant_id = ?
    `, [t]);
    const [revenue] = await query(`
      SELECT COALESCE(SUM(mp.price), 0) as total_revenue
      FROM customer_memberships cm
      LEFT JOIN membership_plans mp ON cm.plan_id = mp.id
      WHERE cm.tenant_id = ? AND cm.status = 'active'
    `, [t]);
    res.json({ success: true, data: { ...planStats, ...memberStats, monthly_revenue: revenue?.total_revenue || 0 } });
  } catch (error) {
    console.error('Membership stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── List plans ──
router.get('/plans', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { active } = req.query;
    let where = 'WHERE tenant_id = ?';
    const params = [t];
    if (active !== undefined) { where += ' AND is_active = ?'; params.push(active === 'true' ? 1 : 0); }

    const plans = await query(`
      SELECT mp.*,
        (SELECT COUNT(*) FROM customer_memberships WHERE plan_id = mp.id AND status = 'active') as active_members
      FROM membership_plans mp
      ${where}
      ORDER BY sort_order, created_at
    `, params);

    // Parse JSON fields
    for (const plan of plans) {
      try { plan.included_services = typeof plan.included_services === 'string' ? JSON.parse(plan.included_services) : plan.included_services; } catch(e) { plan.included_services = []; }
      try { plan.features = typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features; } catch(e) { plan.features = []; }
    }

    res.json({ success: true, data: plans });
  } catch (error) {
    console.error('List membership plans error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Get single plan ──
router.get('/plans/:id', async (req, res) => {
  try {
    await ensureTables();
    const [plan] = await query('SELECT * FROM membership_plans WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
    try { plan.included_services = typeof plan.included_services === 'string' ? JSON.parse(plan.included_services) : plan.included_services; } catch(e) { plan.included_services = []; }
    try { plan.features = typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features; } catch(e) { plan.features = []; }

    const members = await query(`
      SELECT cm.*, c.first_name, c.last_name, c.phone, c.email
      FROM customer_memberships cm
      LEFT JOIN contacts c ON cm.customer_id = c.id
      WHERE cm.plan_id = ? AND cm.tenant_id = ?
      ORDER BY cm.created_at DESC
    `, [plan.id, req.tenantId]);
    plan.members = members;

    res.json({ success: true, data: plan });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Create plan ──
router.post('/plans', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { name, name_ar, description, price, currency = 'AED', billing_period = 'monthly', sessions_included = 0, discount_percent = 0, included_services = [], features = [], color = '#6c5ce7', is_active = 1 } = req.body;

    if (!name || !price) return res.status(400).json({ success: false, message: 'Name and price are required' });

    const result = await execute(`
      INSERT INTO membership_plans (tenant_id, name, name_ar, description, price, currency, billing_period, sessions_included, discount_percent, included_services, features, color, is_active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [t, name, name_ar || null, description || null, price, currency, billing_period, sessions_included, discount_percent,
        JSON.stringify(included_services), JSON.stringify(features), color, is_active]);

    res.status(201).json({ success: true, data: { id: result.insertId }, message: 'Membership plan created' });
  } catch (error) {
    console.error('Create membership plan error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Update plan ──
router.patch('/plans/:id', async (req, res) => {
  try {
    const fields = ['name', 'name_ar', 'description', 'price', 'currency', 'billing_period', 'sessions_included', 'discount_percent', 'color', 'is_active', 'sort_order'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (req.body.included_services !== undefined) { updates.push('included_services = ?'); params.push(JSON.stringify(req.body.included_services)); }
    if (req.body.features !== undefined) { updates.push('features = ?'); params.push(JSON.stringify(req.body.features)); }
    if (!updates.length) return res.status(400).json({ success: false, message: 'No fields to update' });

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE membership_plans SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    res.json({ success: true, message: 'Plan updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Delete plan ──
router.delete('/plans/:id', async (req, res) => {
  try {
    const [active] = await query("SELECT COUNT(*) as c FROM customer_memberships WHERE plan_id = ? AND status = 'active'", [req.params.id]);
    if (active?.c > 0) return res.status(400).json({ success: false, message: 'Cannot delete: active members on this plan' });
    await execute('DELETE FROM membership_plans WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Plan deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Subscribe customer ──
router.post('/subscribe', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { customer_id, plan_id, auto_renew = true } = req.body;
    if (!customer_id || !plan_id) return res.status(400).json({ success: false, message: 'Customer and plan are required' });

    const [plan] = await query("SELECT * FROM membership_plans WHERE id = ? AND tenant_id = ? AND is_active = 1", [plan_id, t]);
    if (!plan) return res.status(404).json({ success: false, message: 'Plan not found or inactive' });

    // Check if customer already has active membership for this plan
    const [existing] = await query("SELECT id FROM customer_memberships WHERE customer_id = ? AND plan_id = ? AND status = 'active' AND tenant_id = ?", [customer_id, plan_id, t]);
    if (existing) return res.status(409).json({ success: false, message: 'Customer already has an active membership for this plan' });

    const startDate = new Date();
    const endDate = new Date();
    const nextBilling = new Date();
    switch (plan.billing_period) {
      case 'weekly': endDate.setDate(endDate.getDate() + 7); nextBilling.setDate(nextBilling.getDate() + 7); break;
      case 'monthly': endDate.setMonth(endDate.getMonth() + 1); nextBilling.setMonth(nextBilling.getMonth() + 1); break;
      case 'quarterly': endDate.setMonth(endDate.getMonth() + 3); nextBilling.setMonth(nextBilling.getMonth() + 3); break;
      case 'yearly': endDate.setFullYear(endDate.getFullYear() + 1); nextBilling.setFullYear(nextBilling.getFullYear() + 1); break;
    }

    const result = await execute(`
      INSERT INTO customer_memberships (tenant_id, customer_id, plan_id, start_date, end_date, next_billing_date, sessions_remaining, auto_renew)
      VALUES (?,?,?,?,?,?,?,?)
    `, [t, customer_id, plan_id, startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0], nextBilling.toISOString().split('T')[0], plan.sessions_included, auto_renew ? 1 : 0]);

    res.status(201).json({ success: true, data: { id: result.insertId }, message: 'Customer subscribed' });
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Cancel membership ──
router.post('/cancel/:membershipId', async (req, res) => {
  try {
    const { reason } = req.body;
    const [mem] = await query("SELECT * FROM customer_memberships WHERE id = ? AND tenant_id = ?", [req.params.membershipId, req.tenantId]);
    if (!mem) return res.status(404).json({ success: false, message: 'Membership not found' });

    await execute("UPDATE customer_memberships SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = ? WHERE id = ?", [reason || null, mem.id]);
    res.json({ success: true, message: 'Membership cancelled' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Pause / Resume ──
router.post('/pause/:membershipId', async (req, res) => {
  try {
    const [mem] = await query("SELECT * FROM customer_memberships WHERE id = ? AND tenant_id = ?", [req.params.membershipId, req.tenantId]);
    if (!mem) return res.status(404).json({ success: false, message: 'Membership not found' });
    const newStatus = mem.status === 'paused' ? 'active' : 'paused';
    await execute("UPDATE customer_memberships SET status = ? WHERE id = ?", [newStatus, mem.id]);
    res.json({ success: true, data: { status: newStatus }, message: `Membership ${newStatus}` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── List members ──
router.get('/members', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { status, plan_id, page = 1, limit = 20 } = req.query;
    let where = 'WHERE cm.tenant_id = ?';
    const params = [t];
    if (status) { where += ' AND cm.status = ?'; params.push(status); }
    if (plan_id) { where += ' AND cm.plan_id = ?'; params.push(plan_id); }

    const pg = parseInt(page); const lm = parseInt(limit);
    const [{ total }] = await query(`SELECT COUNT(*) as total FROM customer_memberships cm ${where}`, [...params]);

    const members = await query(`
      SELECT cm.*, mp.name as plan_name, mp.price, mp.billing_period, mp.color,
        c.first_name, c.last_name, c.phone, c.email
      FROM customer_memberships cm
      LEFT JOIN membership_plans mp ON cm.plan_id = mp.id
      LEFT JOIN contacts c ON cm.customer_id = c.id
      ${where}
      ORDER BY cm.created_at DESC
      LIMIT ${lm} OFFSET ${(pg - 1) * lm}
    `, [...params]);

    res.json({ success: true, data: members, pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) } });
  } catch (error) {
    console.error('List members error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Customer memberships ──
router.get('/customer/:customerId', async (req, res) => {
  try {
    await ensureTables();
    const memberships = await query(`
      SELECT cm.*, mp.name as plan_name, mp.price, mp.billing_period, mp.discount_percent, mp.color
      FROM customer_memberships cm
      LEFT JOIN membership_plans mp ON cm.plan_id = mp.id
      WHERE cm.customer_id = ? AND cm.tenant_id = ?
      ORDER BY cm.start_date DESC
    `, [req.params.customerId, req.tenantId]);
    res.json({ success: true, data: memberships });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
