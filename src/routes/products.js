import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// Ensure all tables exist
async function ensureTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      sku VARCHAR(50),
      unit_price DECIMAL(15, 2) NOT NULL DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'AED',
      price_type ENUM('fixed','from','free') DEFAULT 'fixed',
      duration INT DEFAULT 60,
      processing_time INT DEFAULT 0,
      finishing_time INT DEFAULT 0,
      category VARCHAR(100),
      category_id INT,
      branch_id INT,
      stock_quantity INT DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      online_booking TINYINT(1) DEFAULT 1,
      requires_resources TINYINT(1) DEFAULT 0,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_category (category),
      INDEX idx_category_id (category_id),
      INDEX idx_branch (branch_id),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Service-staff link table
  await execute(`
    CREATE TABLE IF NOT EXISTS service_staff (
      id INT AUTO_INCREMENT PRIMARY KEY,
      service_id INT NOT NULL,
      staff_id INT NOT NULL,
      tenant_id INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_service_staff (service_id, staff_id),
      INDEX idx_service (service_id),
      INDEX idx_staff (staff_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Service-resources link table
  await execute(`
    CREATE TABLE IF NOT EXISTS service_resources (
      id INT AUTO_INCREMENT PRIMARY KEY,
      service_id INT NOT NULL,
      resource_id INT NOT NULL,
      tenant_id INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_service_resource (service_id, resource_id),
      INDEX idx_service (service_id),
      INDEX idx_resource (resource_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Add columns if missing (for existing tables)
  const cols = [
    'ALTER TABLE products ADD COLUMN duration INT DEFAULT 60 AFTER currency',
    'ALTER TABLE products ADD COLUMN category_id INT AFTER category',
    'ALTER TABLE products ADD COLUMN branch_id INT AFTER category_id',
    "ALTER TABLE products ADD COLUMN price_type ENUM('fixed','from','free') DEFAULT 'fixed' AFTER currency",
    'ALTER TABLE products ADD COLUMN processing_time INT DEFAULT 0 AFTER duration',
    'ALTER TABLE products ADD COLUMN finishing_time INT DEFAULT 0 AFTER processing_time',
    'ALTER TABLE products ADD COLUMN online_booking TINYINT(1) DEFAULT 1 AFTER is_active',
    'ALTER TABLE products ADD COLUMN requires_resources TINYINT(1) DEFAULT 0 AFTER online_booking',
    'ALTER TABLE products ADD INDEX idx_branch (branch_id)',
  ];
  for (const sql of cols) {
    try { await execute(sql); } catch (e) {}
  }
}

// GET stats/summary — MUST be before /:id to avoid matching "stats" as an id
router.get('/stats/summary', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const tenantId = req.tenantId;
    let sql = `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) as inactive,
        COUNT(DISTINCT category_id) as categories,
        AVG(unit_price) as avg_price,
        AVG(duration) as avg_duration
      FROM products WHERE 1=1
    `;
    const params = [];
    if (tenantId) { sql += ' AND tenant_id = ?'; params.push(tenantId); }

    const [stats] = await query(sql, params);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// GET all products/services
router.get('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { category, category_id, branch_id, active, search } = req.query;
    const tenantId = req.tenantId;

    let sql = `
      SELECT p.*, 
        sc.name as category_name, sc.name_ar as category_name_ar, 
        sc.icon as category_icon, sc.color as category_color,
        br.name as branch_name
      FROM products p
      LEFT JOIN service_categories sc ON p.category_id = sc.id
      LEFT JOIN branches br ON p.branch_id = br.id
      WHERE 1=1
    `;
    const params = [];

    if (tenantId) { sql += ' AND p.tenant_id = ?'; params.push(tenantId); }
    if (category_id) { sql += ' AND p.category_id = ?'; params.push(category_id); }
    if (branch_id) { sql += ' AND p.branch_id = ?'; params.push(branch_id); }
    if (category) { sql += ' AND (p.category = ? OR sc.name = ?)'; params.push(category, category); }
    if (active !== undefined) { sql += ' AND p.is_active = ?'; params.push(active === 'true' ? 1 : 0); }
    if (search) { sql += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.description LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    sql += ' ORDER BY p.created_at DESC';

    const products = await query(sql, params);
    res.json({ success: true, data: products });
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch products' });
  }
});

// GET single product
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const tenantId = req.tenantId;
    let sql = `
      SELECT p.*, 
        sc.name as category_name, sc.icon as category_icon, sc.color as category_color,
        br.name as branch_name
      FROM products p
      LEFT JOIN service_categories sc ON p.category_id = sc.id
      LEFT JOIN branches br ON p.branch_id = br.id
      WHERE p.id = ?
    `;
    const params = [req.params.id];
    if (tenantId) { sql += ' AND p.tenant_id = ?'; params.push(tenantId); }

    const [product] = await query(sql, params);
    if (!product) return res.status(404).json({ success: false, message: 'Service not found' });

    // Fetch team members assigned to this service
    const team = await query('SELECT ss.*, s.full_name as staff_name FROM service_staff ss LEFT JOIN staff s ON ss.staff_id = s.id WHERE ss.service_id = ?', [req.params.id]);
    // Fetch resources assigned
    const resources = await query('SELECT sr.*, r.name as resource_name, r.type as resource_type FROM service_resources sr LEFT JOIN resources r ON sr.resource_id = r.id WHERE sr.service_id = ?', [req.params.id]);

    product.team = team;
    product.resources = resources;

    res.json({ success: true, data: product });
  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch service' });
  }
});

// POST create product/service
router.post('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { name, description, sku, unit_price, currency, price_type, duration, processing_time, finishing_time, category, category_id, branch_id, stock_quantity, is_active, online_booking, requires_resources } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Service name is required' });

    const tenantId = req.tenantId;
    const result = await execute(
      `INSERT INTO products (tenant_id, name, description, sku, unit_price, currency, price_type, duration, processing_time, finishing_time, category, category_id, branch_id, stock_quantity, is_active, online_booking, requires_resources, created_by) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, name, description || null, sku || null, unit_price || 0, currency || 'AED', price_type || 'fixed', duration || 60, processing_time || 0, finishing_time || 0, category || null, category_id || null, branch_id || null, stock_quantity || 0, is_active !== false ? 1 : 0, online_booking !== false ? 1 : 0, requires_resources ? 1 : 0, req.user?.id || null]
    );

    res.json({ success: true, message: 'Service created successfully', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({ success: false, message: 'Failed to create service' });
  }
});

// PATCH update product/service
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const fields = ['name', 'description', 'sku', 'unit_price', 'currency', 'price_type', 'duration', 'processing_time', 'finishing_time', 'category', 'category_id', 'branch_id', 'stock_quantity', 'is_active', 'online_booking', 'requires_resources'];
    const updates = [];
    const params = [];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        const boolFields = ['is_active', 'online_booking', 'requires_resources'];
        params.push(boolFields.includes(f) ? (req.body[f] ? 1 : 0) : req.body[f]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No fields to update' });

    let sql = `UPDATE products SET ${updates.join(', ')} WHERE id = ?`;
    params.push(req.params.id);

    const tenantId = req.tenantId;
    if (tenantId) { sql += ' AND tenant_id = ?'; params.push(tenantId); }

    await execute(sql, params);
    res.json({ success: true, message: 'Service updated successfully' });
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ success: false, message: 'Failed to update service' });
  }
});

// DELETE product/service
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    let sql = 'DELETE FROM products WHERE id = ?';
    const params = [req.params.id];
    if (tenantId) { sql += ' AND tenant_id = ?'; params.push(tenantId); }

    await execute(sql, params);
    // Clean up linked tables
    try { await execute('DELETE FROM service_staff WHERE service_id = ?', [req.params.id]); } catch (e) {}
    try { await execute('DELETE FROM service_resources WHERE service_id = ?', [req.params.id]); } catch (e) {}
    res.json({ success: true, message: 'Service deleted successfully' });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete service' });
  }
});

// ── Service-Staff Assignment ──

// GET /products/:id/team
router.get('/:id/team', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const team = await query(
      `SELECT ss.*, s.full_name as staff_name, s.role, s.email 
       FROM service_staff ss 
       LEFT JOIN staff s ON ss.staff_id = s.id 
       WHERE ss.service_id = ?`,
      [req.params.id]
    );
    res.json({ success: true, data: team });
  } catch (error) {
    console.error('Get service team error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch team' });
  }
});

// POST /products/:id/team — assign staff to service
router.post('/:id/team', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { staff_id } = req.body;
    if (!staff_id) return res.status(400).json({ success: false, message: 'staff_id required' });
    await execute(
      'INSERT IGNORE INTO service_staff (service_id, staff_id, tenant_id) VALUES (?, ?, ?)',
      [req.params.id, staff_id, req.tenantId]
    );
    res.json({ success: true, message: 'Staff assigned' });
  } catch (error) {
    console.error('Assign staff error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign staff' });
  }
});

// DELETE /products/:id/team/:staffId — remove staff from service
router.delete('/:id/team/:staffId', authMiddleware, async (req, res) => {
  try {
    await execute('DELETE FROM service_staff WHERE service_id = ? AND staff_id = ?', [req.params.id, req.params.staffId]);
    res.json({ success: true, message: 'Staff removed' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to remove staff' });
  }
});

// ── Service-Resource Assignment ──

// GET /products/:id/resources
router.get('/:id/resources', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const resources = await query(
      `SELECT sr.*, r.name as resource_name, r.type as resource_type, r.quantity 
       FROM service_resources sr 
       LEFT JOIN resources r ON sr.resource_id = r.id 
       WHERE sr.service_id = ?`,
      [req.params.id]
    );
    res.json({ success: true, data: resources });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch resources' });
  }
});

// POST /products/:id/resources — assign resource to service
router.post('/:id/resources', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { resource_id } = req.body;
    if (!resource_id) return res.status(400).json({ success: false, message: 'resource_id required' });
    await execute(
      'INSERT IGNORE INTO service_resources (service_id, resource_id, tenant_id) VALUES (?, ?, ?)',
      [req.params.id, resource_id, req.tenantId]
    );
    res.json({ success: true, message: 'Resource assigned' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to assign resource' });
  }
});

// DELETE /products/:id/resources/:resourceId
router.delete('/:id/resources/:resourceId', authMiddleware, async (req, res) => {
  try {
    await execute('DELETE FROM service_resources WHERE service_id = ? AND resource_id = ?', [req.params.id, req.params.resourceId]);
    res.json({ success: true, message: 'Resource removed' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to remove resource' });
  }
});export default router;
