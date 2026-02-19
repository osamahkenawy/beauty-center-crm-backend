import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

async function ensureTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS branches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      name_ar VARCHAR(255),
      code VARCHAR(50),
      address TEXT,
      address_ar TEXT,
      city VARCHAR(100),
      city_ar VARCHAR(100),
      state_province VARCHAR(100),
      country VARCHAR(100) DEFAULT 'UAE',
      postal_code VARCHAR(20),
      latitude DECIMAL(10, 8),
      longitude DECIMAL(11, 8),
      google_place_id VARCHAR(255),
      phone VARCHAR(50),
      email VARCHAR(255),
      manager_id INT,
      is_headquarters TINYINT(1) DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      timezone VARCHAR(50) DEFAULT 'Asia/Dubai',
      currency VARCHAR(10) DEFAULT 'AED',
      working_hours JSON,
      description TEXT,
      cover_image VARCHAR(500),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Add new columns if missing (for existing tables)
  const cols = [
    { name: 'tenant_id', sql: 'ALTER TABLE branches ADD COLUMN tenant_id INT AFTER id' },
    { name: 'latitude', sql: 'ALTER TABLE branches ADD COLUMN latitude DECIMAL(10,8) AFTER postal_code' },
    { name: 'longitude', sql: 'ALTER TABLE branches ADD COLUMN longitude DECIMAL(11,8) AFTER latitude' },
    { name: 'google_place_id', sql: 'ALTER TABLE branches ADD COLUMN google_place_id VARCHAR(255) AFTER longitude' },
    { name: 'address_ar', sql: 'ALTER TABLE branches ADD COLUMN address_ar TEXT AFTER address' },
    { name: 'city_ar', sql: 'ALTER TABLE branches ADD COLUMN city_ar VARCHAR(100) AFTER city' },
    { name: 'state_province', sql: 'ALTER TABLE branches ADD COLUMN state_province VARCHAR(100) AFTER city_ar' },
    { name: 'postal_code', sql: 'ALTER TABLE branches ADD COLUMN postal_code VARCHAR(20) AFTER state_province' },
    { name: 'working_hours', sql: 'ALTER TABLE branches ADD COLUMN working_hours JSON AFTER currency' },
    { name: 'description', sql: 'ALTER TABLE branches ADD COLUMN description TEXT AFTER working_hours' },
    { name: 'cover_image', sql: 'ALTER TABLE branches ADD COLUMN cover_image VARCHAR(500) AFTER description' },
  ];
  for (const col of cols) {
    try { await execute(col.sql); } catch (e) { /* column already exists */ }
  }
}

// GET all branches (tenant-scoped)
router.get('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const tenantId = req.tenantId;
    let sql = `
      SELECT b.*, s.full_name as manager_name
      FROM branches b 
      LEFT JOIN staff s ON b.manager_id = s.id
      WHERE 1=1
    `;
    const params = [];
    if (tenantId) { sql += ' AND b.tenant_id = ?'; params.push(tenantId); }

    const { active } = req.query;
    if (active !== undefined) { sql += ' AND b.is_active = ?'; params.push(active === 'true' ? 1 : 0); }

    sql += ' ORDER BY b.is_headquarters DESC, b.name';
    const branches = await query(sql, params);

    // Parse working_hours JSON and add staff counts
    for (const b of branches) {
      if (b.working_hours && typeof b.working_hours === 'string') {
        try { b.working_hours = JSON.parse(b.working_hours); } catch (e) {}
      }
      
      // Get staff count for this branch
      const [staffCount] = await query(
        'SELECT COUNT(*) as count FROM staff WHERE branch_id = ? AND tenant_id = ?',
        [b.id, tenantId]
      ).catch(() => [{ count: 0 }]);
      b.staff_count = staffCount?.count || 0;
    }

    res.json({ success: true, data: branches });
  } catch (error) {
    console.error('Get branches error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch branches' });
  }
});

// GET branch stats
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const tenantId = req.tenantId;
    let sql = `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) as inactive,
        SUM(CASE WHEN is_headquarters = 1 THEN 1 ELSE 0 END) as headquarters
      FROM branches WHERE 1=1
    `;
    const params = [];
    if (tenantId) { sql += ' AND tenant_id = ?'; params.push(tenantId); }
    const [stats] = await query(sql, params);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Get branch stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// GET single branch
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    let sql = `
      SELECT b.*, s.full_name as manager_name
      FROM branches b 
      LEFT JOIN staff s ON b.manager_id = s.id
      WHERE b.id = ?
    `;
    const params = [req.params.id];
    if (tenantId) { sql += ' AND b.tenant_id = ?'; params.push(tenantId); }

    const [branch] = await query(sql, params);
    if (!branch) return res.status(404).json({ success: false, message: 'Branch not found' });

    if (branch.working_hours && typeof branch.working_hours === 'string') {
      try { branch.working_hours = JSON.parse(branch.working_hours); } catch (e) {}
    }

    // Get service count for this branch
    const [serviceCount] = await query(
      'SELECT COUNT(*) as count FROM products WHERE branch_id = ? AND tenant_id = ?',
      [req.params.id, tenantId]
    ).catch(() => [{ count: 0 }]);
    branch.service_count = serviceCount?.count || 0;

    // Get staff count for this branch
    const [staffCount] = await query(
      'SELECT COUNT(*) as count FROM staff WHERE branch_id = ? AND tenant_id = ?',
      [req.params.id, tenantId]
    ).catch(() => [{ count: 0 }]);
    branch.staff_count = staffCount?.count || 0;

    res.json({ success: true, data: branch });
  } catch (error) {
    console.error('Get branch error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch branch' });
  }
});

// POST create branch
router.post('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const {
      name, name_ar, code, address, address_ar, city, city_ar, state_province, country,
      postal_code, latitude, longitude, google_place_id, phone, email, manager_id,
      is_headquarters, is_active, timezone, currency, working_hours, description
    } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'Branch name required' });

    const tenantId = req.tenantId;

    // If setting as headquarters, unset others
    if (is_headquarters) {
      await execute('UPDATE branches SET is_headquarters = 0 WHERE tenant_id = ?', [tenantId]);
    }

    const result = await execute(
      `INSERT INTO branches (
        tenant_id, name, name_ar, code, address, address_ar, city, city_ar, state_province, country,
        postal_code, latitude, longitude, google_place_id, phone, email, manager_id,
        is_headquarters, is_active, timezone, currency, working_hours, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId, name, name_ar || null, code || null, address || null, address_ar || null,
        city || null, city_ar || null, state_province || null, country || 'UAE',
        postal_code || null, latitude || null, longitude || null, google_place_id || null,
        phone || null, email || null, manager_id || null,
        is_headquarters ? 1 : 0, is_active !== false ? 1 : 0,
        timezone || 'Asia/Dubai', currency || 'AED',
        working_hours ? JSON.stringify(working_hours) : null,
        description || null
      ]
    );
    res.json({ success: true, message: 'Branch created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create branch error:', error);
    res.status(500).json({ success: false, message: 'Failed to create branch' });
  }
});

// PATCH update branch
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const fields = [
      'name', 'name_ar', 'code', 'address', 'address_ar', 'city', 'city_ar',
      'state_province', 'country', 'postal_code', 'latitude', 'longitude',
      'google_place_id', 'phone', 'email', 'manager_id', 'is_headquarters',
      'is_active', 'timezone', 'currency', 'working_hours', 'description'
    ];
    const updates = [];
    const params = [];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        let value = req.body[f];
        if (f === 'is_headquarters' || f === 'is_active') value = value ? 1 : 0;
        if (f === 'manager_id' && value === '') value = null;
        if (f === 'working_hours' && typeof value === 'object') value = JSON.stringify(value);
        params.push(value);
      }
    }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No updates' });

    // If setting as headquarters, unset others
    if (req.body.is_headquarters) {
      await execute('UPDATE branches SET is_headquarters = 0 WHERE tenant_id = ? AND id != ?', [tenantId, req.params.id]);
    }

    let sql = `UPDATE branches SET ${updates.join(', ')} WHERE id = ?`;
    params.push(req.params.id);
    if (tenantId) { sql += ' AND tenant_id = ?'; params.push(tenantId); }

    await execute(sql, params);
    res.json({ success: true, message: 'Branch updated' });
  } catch (error) {
    console.error('Update branch error:', error);
    res.status(500).json({ success: false, message: 'Failed to update branch' });
  }
});

// DELETE branch
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // Check if services are linked
    const [linked] = await query(
      'SELECT COUNT(*) as count FROM products WHERE branch_id = ?', [req.params.id]
    ).catch(() => [{ count: 0 }]);
    if (linked?.count > 0) {
      return res.status(400).json({ success: false, message: `Cannot delete: ${linked.count} services are linked to this branch. Reassign them first.` });
    }

    let sql = 'DELETE FROM branches WHERE id = ?';
    const params = [req.params.id];
    if (tenantId) { sql += ' AND tenant_id = ?'; params.push(tenantId); }

    await execute(sql, params);
    res.json({ success: true, message: 'Branch deleted' });
  } catch (error) {
    console.error('Delete branch error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete branch' });
  }
});

export default router;
