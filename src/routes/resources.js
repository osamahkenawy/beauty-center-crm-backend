import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

async function ensureTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS resources (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      branch_id INT,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(50) DEFAULT 'room',
      description TEXT,
      capacity INT DEFAULT 1,
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_branch (branch_id),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS service_resources (
      id INT AUTO_INCREMENT PRIMARY KEY,
      service_id INT NOT NULL,
      resource_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_service_resource (service_id, resource_id),
      INDEX idx_service (service_id),
      INDEX idx_resource (resource_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS service_staff (
      id INT AUTO_INCREMENT PRIMARY KEY,
      service_id INT NOT NULL,
      staff_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_service_staff (service_id, staff_id),
      INDEX idx_service (service_id),
      INDEX idx_staff (staff_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// ── Resources CRUD ──

router.get('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const tenantId = req.tenantId;
    const { branch_id, type, active } = req.query;

    let sql = `
      SELECT r.*, b.name as branch_name
      FROM resources r
      LEFT JOIN branches b ON r.branch_id = b.id
      WHERE 1=1
    `;
    const params = [];
    if (tenantId) { sql += ' AND r.tenant_id = ?'; params.push(tenantId); }
    if (branch_id) { sql += ' AND r.branch_id = ?'; params.push(branch_id); }
    if (type) { sql += ' AND r.type = ?'; params.push(type); }
    if (active !== undefined) { sql += ' AND r.is_active = ?'; params.push(active === 'true' ? 1 : 0); }
    sql += ' ORDER BY r.branch_id, r.name';

    const resources = await query(sql, params);
    res.json({ success: true, data: resources });
  } catch (error) {
    console.error('Get resources error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch resources' });
  }
});

router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    let sql = 'SELECT r.*, b.name as branch_name FROM resources r LEFT JOIN branches b ON r.branch_id = b.id WHERE r.id = ?';
    const params = [req.params.id];
    if (tenantId) { sql += ' AND r.tenant_id = ?'; params.push(tenantId); }
    const [resource] = await query(sql, params);
    if (!resource) return res.status(404).json({ success: false, message: 'Resource not found' });
    res.json({ success: true, data: resource });
  } catch (error) {
    console.error('Get resource error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch resource' });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { name, type, branch_id, description, capacity, is_active } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Resource name is required' });

    const tenantId = req.tenantId;
    const result = await execute(
      `INSERT INTO resources (tenant_id, branch_id, name, type, description, capacity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, branch_id || null, name, type || 'room', description || null, capacity || 1, is_active !== false ? 1 : 0]
    );
    res.json({ success: true, message: 'Resource created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create resource error:', error);
    res.status(500).json({ success: false, message: 'Failed to create resource' });
  }
});

router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const fields = ['name', 'type', 'branch_id', 'description', 'capacity', 'is_active'];
    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(f === 'is_active' ? (req.body[f] ? 1 : 0) : req.body[f]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No fields to update' });
    let sql = `UPDATE resources SET ${updates.join(', ')} WHERE id = ?`;
    params.push(req.params.id);
    const tenantId = req.tenantId;
    if (tenantId) { sql += ' AND tenant_id = ?'; params.push(tenantId); }
    await execute(sql, params);
    res.json({ success: true, message: 'Resource updated' });
  } catch (error) {
    console.error('Update resource error:', error);
    res.status(500).json({ success: false, message: 'Failed to update resource' });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    let sql = 'DELETE FROM resources WHERE id = ?';
    const params = [req.params.id];
    if (tenantId) { sql += ' AND tenant_id = ?'; params.push(tenantId); }
    await execute(sql, params);
    // Clean up service_resources
    await execute('DELETE FROM service_resources WHERE resource_id = ?', [req.params.id]);
    res.json({ success: true, message: 'Resource deleted' });
  } catch (error) {
    console.error('Delete resource error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete resource' });
  }
});

// ── Service-Staff assignment ──

router.get('/service/:serviceId/team', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const staff = await query(`
      SELECT s.id, s.full_name, s.email, s.role, s.phone,
        CASE WHEN ss.id IS NOT NULL THEN 1 ELSE 0 END as assigned
      FROM staff s
      LEFT JOIN service_staff ss ON s.id = ss.staff_id AND ss.service_id = ?
      WHERE s.is_active = 1
      ORDER BY s.full_name
    `, [req.params.serviceId]);
    res.json({ success: true, data: staff });
  } catch (error) {
    console.error('Get service team error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch team' });
  }
});

router.post('/service/:serviceId/team', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { staff_ids } = req.body; // array of staff IDs
    if (!Array.isArray(staff_ids)) return res.status(400).json({ success: false, message: 'staff_ids array required' });
    
    // Remove existing assignments
    await execute('DELETE FROM service_staff WHERE service_id = ?', [req.params.serviceId]);
    
    // Insert new assignments
    if (staff_ids.length > 0) {
      const values = staff_ids.map(id => `(${parseInt(req.params.serviceId)}, ${parseInt(id)})`).join(',');
      await execute(`INSERT INTO service_staff (service_id, staff_id) VALUES ${values}`);
    }
    
    res.json({ success: true, message: 'Team updated', data: { count: staff_ids.length } });
  } catch (error) {
    console.error('Update service team error:', error);
    res.status(500).json({ success: false, message: 'Failed to update team' });
  }
});

// ── Service-Resource assignment ──

router.get('/service/:serviceId/resources', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const tenantId = req.tenantId;
    let sql = `
      SELECT r.*, b.name as branch_name,
        CASE WHEN sr.id IS NOT NULL THEN 1 ELSE 0 END as assigned
      FROM resources r
      LEFT JOIN branches b ON r.branch_id = b.id
      LEFT JOIN service_resources sr ON r.id = sr.resource_id AND sr.service_id = ?
      WHERE r.is_active = 1
    `;
    const params = [req.params.serviceId];
    if (tenantId) { sql += ' AND r.tenant_id = ?'; params.push(tenantId); }
    sql += ' ORDER BY b.name, r.name';
    
    const resources = await query(sql, params);
    res.json({ success: true, data: resources });
  } catch (error) {
    console.error('Get service resources error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch resources' });
  }
});

router.post('/service/:serviceId/resources', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { resource_ids } = req.body;
    if (!Array.isArray(resource_ids)) return res.status(400).json({ success: false, message: 'resource_ids array required' });
    
    await execute('DELETE FROM service_resources WHERE service_id = ?', [req.params.serviceId]);
    
    if (resource_ids.length > 0) {
      const values = resource_ids.map(id => `(${parseInt(req.params.serviceId)}, ${parseInt(id)})`).join(',');
      await execute(`INSERT INTO service_resources (service_id, resource_id) VALUES ${values}`);
    }
    
    res.json({ success: true, message: 'Resources updated', data: { count: resource_ids.length } });
  } catch (error) {
    console.error('Update service resources error:', error);
    res.status(500).json({ success: false, message: 'Failed to update resources' });
  }
});

export default router;
