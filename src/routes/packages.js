import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

async function ensureTables() {
  await execute(`
    CREATE TABLE IF NOT EXISTS packages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      branch_id INT,
      name VARCHAR(255) NOT NULL,
      name_ar VARCHAR(255),
      description TEXT,
      price DECIMAL(10,2) NOT NULL,
      currency VARCHAR(10) DEFAULT 'AED',
      validity_days INT DEFAULT 365,
      max_uses INT DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      image_url VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS package_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      package_id INT NOT NULL,
      service_id INT NOT NULL,
      quantity INT DEFAULT 1,
      INDEX idx_package (package_id),
      INDEX idx_service (service_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS customer_packages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      customer_id INT NOT NULL,
      package_id INT NOT NULL,
      purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATE,
      status ENUM('active','expired','completed','cancelled') DEFAULT 'active',
      invoice_id INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_customer (customer_id),
      INDEX idx_package (package_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS customer_package_usage (
      id INT AUTO_INCREMENT PRIMARY KEY,
      customer_package_id INT NOT NULL,
      service_id INT NOT NULL,
      appointment_id INT,
      used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cp (customer_package_id),
      INDEX idx_service (service_id)
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
        COUNT(*) as total_packages,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_packages
      FROM packages WHERE tenant_id = ?
    `, [t]);
    const [sold] = await query(`
      SELECT
        COUNT(*) as total_sold,
        SUM(CASE WHEN cp.status = 'active' THEN 1 ELSE 0 END) as active_subscriptions,
        COALESCE(SUM(p.price), 0) as total_revenue
      FROM customer_packages cp
      LEFT JOIN packages p ON cp.package_id = p.id
      WHERE cp.tenant_id = ?
    `, [t]);
    res.json({ success: true, data: { ...stats, ...sold } });
  } catch (error) {
    console.error('Package stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── List packages ──
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { active, branch_id, page = 1, limit = 50 } = req.query;
    let where = 'WHERE p.tenant_id = ?';
    const params = [t];
    if (active !== undefined) { where += ' AND p.is_active = ?'; params.push(active === 'true' ? 1 : 0); }
    if (branch_id) { where += ' AND (p.branch_id = ? OR p.branch_id IS NULL)'; params.push(branch_id); }

    const packages = await query(`
      SELECT p.*,
        (SELECT COUNT(*) FROM package_items WHERE package_id = p.id) as item_count,
        (SELECT COUNT(*) FROM customer_packages WHERE package_id = p.id AND status = 'active') as active_buyers,
        b.name as branch_name
      FROM packages p
      LEFT JOIN branches b ON p.branch_id = b.id
      ${where}
      ORDER BY p.created_at DESC
    `, params);

    // Get items for each package
    for (const pkg of packages) {
      pkg.items = await query(`
        SELECT pi.*, pr.name as service_name, pr.duration, pr.unit_price
        FROM package_items pi
        LEFT JOIN products pr ON pi.service_id = pr.id
        WHERE pi.package_id = ?
      `, [pkg.id]);
    }

    res.json({ success: true, data: packages });
  } catch (error) {
    console.error('List packages error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Get single ──
router.get('/:id', async (req, res) => {
  try {
    await ensureTables();
    const [pkg] = await query('SELECT * FROM packages WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' });

    pkg.items = await query(`
      SELECT pi.*, pr.name as service_name, pr.duration, pr.unit_price
      FROM package_items pi
      LEFT JOIN products pr ON pi.service_id = pr.id
      WHERE pi.package_id = ?
    `, [pkg.id]);

    pkg.buyers = await query(`
      SELECT cp.*, c.first_name, c.last_name, c.phone,
        (SELECT COUNT(*) FROM customer_package_usage WHERE customer_package_id = cp.id) as used_sessions
      FROM customer_packages cp
      LEFT JOIN contacts c ON cp.customer_id = c.id
      WHERE cp.package_id = ? AND cp.tenant_id = ?
      ORDER BY cp.purchased_at DESC
    `, [pkg.id, req.tenantId]);

    res.json({ success: true, data: pkg });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Create package ──
router.post('/', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { name, name_ar, description, price, currency = 'AED', validity_days = 365, max_uses = 0, branch_id, is_active = 1, items = [], image_url } = req.body;

    if (!name || !price) return res.status(400).json({ success: false, message: 'Name and price are required' });

    const result = await execute(`
      INSERT INTO packages (tenant_id, branch_id, name, name_ar, description, price, currency, validity_days, max_uses, is_active, image_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `, [t, branch_id || null, name, name_ar || null, description || null, price, currency, validity_days, max_uses, is_active, image_url || null]);

    const pkgId = result.insertId;

    // Insert package items
    for (const item of items) {
      if (item.service_id) {
        await execute('INSERT INTO package_items (package_id, service_id, quantity) VALUES (?,?,?)',
          [pkgId, item.service_id, item.quantity || 1]);
      }
    }

    res.status(201).json({ success: true, data: { id: pkgId }, message: 'Package created' });
  } catch (error) {
    console.error('Create package error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Update package ──
router.patch('/:id', async (req, res) => {
  try {
    const fields = ['name', 'name_ar', 'description', 'price', 'currency', 'validity_days', 'max_uses', 'branch_id', 'is_active', 'image_url'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (!updates.length && !req.body.items) return res.status(400).json({ success: false, message: 'No fields to update' });

    if (updates.length) {
      params.push(req.params.id, req.tenantId);
      await execute(`UPDATE packages SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    }

    // Replace items if provided
    if (req.body.items) {
      await execute('DELETE FROM package_items WHERE package_id = ?', [req.params.id]);
      for (const item of req.body.items) {
        if (item.service_id) {
          await execute('INSERT INTO package_items (package_id, service_id, quantity) VALUES (?,?,?)',
            [req.params.id, item.service_id, item.quantity || 1]);
        }
      }
    }

    res.json({ success: true, message: 'Package updated' });
  } catch (error) {
    console.error('Update package error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Delete package ──
router.delete('/:id', async (req, res) => {
  try {
    const [active] = await query("SELECT COUNT(*) as c FROM customer_packages WHERE package_id = ? AND status = 'active'", [req.params.id]);
    if (active?.c > 0) return res.status(400).json({ success: false, message: 'Cannot delete: active customers on this package' });

    await execute('DELETE FROM package_items WHERE package_id = ?', [req.params.id]);
    await execute('DELETE FROM packages WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Package deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Sell package to customer ──
router.post('/:id/sell', async (req, res) => {
  try {
    await ensureTables();
    const { customer_id, invoice_id } = req.body;
    if (!customer_id) return res.status(400).json({ success: false, message: 'Customer is required' });

    const [pkg] = await query('SELECT * FROM packages WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!pkg) return res.status(404).json({ success: false, message: 'Package not found' });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (pkg.validity_days || 365));

    const result = await execute(`
      INSERT INTO customer_packages (tenant_id, customer_id, package_id, expires_at, invoice_id)
      VALUES (?,?,?,?,?)
    `, [req.tenantId, customer_id, pkg.id, expiresAt.toISOString().split('T')[0], invoice_id || null]);

    res.status(201).json({ success: true, data: { id: result.insertId }, message: 'Package sold to customer' });
  } catch (error) {
    console.error('Sell package error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Record package usage ──
router.post('/usage', async (req, res) => {
  try {
    await ensureTables();
    const { customer_package_id, service_id, appointment_id } = req.body;
    if (!customer_package_id || !service_id) return res.status(400).json({ success: false, message: 'Customer package and service are required' });

    // Verify package is active
    const [cp] = await query("SELECT cp.*, p.max_uses FROM customer_packages cp LEFT JOIN packages p ON cp.package_id = p.id WHERE cp.id = ? AND cp.status = 'active'", [customer_package_id]);
    if (!cp) return res.status(404).json({ success: false, message: 'Active customer package not found' });

    // Check if expired
    if (cp.expires_at && new Date(cp.expires_at) < new Date()) {
      await execute("UPDATE customer_packages SET status = 'expired' WHERE id = ?", [customer_package_id]);
      return res.status(400).json({ success: false, message: 'Package has expired' });
    }

    // Check max uses
    if (cp.max_uses > 0) {
      const [{ used }] = await query('SELECT COUNT(*) as used FROM customer_package_usage WHERE customer_package_id = ?', [customer_package_id]);
      if (used >= cp.max_uses) {
        await execute("UPDATE customer_packages SET status = 'completed' WHERE id = ?", [customer_package_id]);
        return res.status(400).json({ success: false, message: 'Package usage limit reached' });
      }
    }

    await execute('INSERT INTO customer_package_usage (customer_package_id, service_id, appointment_id) VALUES (?,?,?)',
      [customer_package_id, service_id, appointment_id || null]);

    res.json({ success: true, message: 'Package usage recorded' });
  } catch (error) {
    console.error('Package usage error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Customer packages ──
router.get('/customer/:customerId', async (req, res) => {
  try {
    await ensureTables();
    const packages = await query(`
      SELECT cp.*, p.name as package_name, p.price, p.max_uses,
        (SELECT COUNT(*) FROM customer_package_usage WHERE customer_package_id = cp.id) as used_sessions
      FROM customer_packages cp
      LEFT JOIN packages p ON cp.package_id = p.id
      WHERE cp.customer_id = ? AND cp.tenant_id = ?
      ORDER BY cp.purchased_at DESC
    `, [req.params.customerId, req.tenantId]);
    res.json({ success: true, data: packages });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
