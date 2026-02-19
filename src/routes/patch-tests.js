import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

async function ensureTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS patch_tests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      customer_id INT NOT NULL,
      service_id INT,
      staff_id INT,
      branch_id INT,
      test_date DATETIME NOT NULL,
      result_date DATETIME,
      result ENUM('pending','pass','fail','reaction') DEFAULT 'pending',
      notes TEXT,
      photos JSON,
      valid_until DATE,
      is_valid TINYINT(1) DEFAULT 0,
      created_by INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_customer (customer_id),
      INDEX idx_service (service_id)
    )
  `);

  // Add requires_patch_test to products if not exists
  try {
    await execute('ALTER TABLE products ADD COLUMN requires_patch_test TINYINT(1) DEFAULT 0');
  } catch (e) { /* already exists */ }
}

// ── Stats (must be before /:id) ──
router.get('/stats', async (req, res) => {
  try {
    await ensureTable();
    const [total] = await query('SELECT COUNT(*) as count FROM patch_tests WHERE tenant_id = ?', [req.tenantId]);
    const [pending] = await query('SELECT COUNT(*) as count FROM patch_tests WHERE tenant_id = ? AND result = ?', [req.tenantId, 'pending']);
    const [passed] = await query('SELECT COUNT(*) as count FROM patch_tests WHERE tenant_id = ? AND result = ?', [req.tenantId, 'pass']);
    const [failed] = await query('SELECT COUNT(*) as count FROM patch_tests WHERE tenant_id = ? AND result IN (?,?)', [req.tenantId, 'fail', 'reaction']);
    const [valid] = await query('SELECT COUNT(*) as count FROM patch_tests WHERE tenant_id = ? AND is_valid = 1 AND (valid_until IS NULL OR valid_until >= CURDATE())', [req.tenantId]);

    res.json({
      success: true,
      data: {
        total: total?.count || 0,
        pending: pending?.count || 0,
        passed: passed?.count || 0,
        failed: failed?.count || 0,
        currently_valid: valid?.count || 0
      }
    });
  } catch (error) {
    console.error('Patch test stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ── Check if customer has valid patch test for service (must be before /:id) ──
router.get('/check/:customerId/:serviceId', async (req, res) => {
  try {
    await ensureTable();
    const [service] = await query('SELECT requires_patch_test FROM products WHERE id = ?', [req.params.serviceId]);
    if (!service || !service.requires_patch_test) {
      return res.json({ success: true, data: { required: false, valid: true } });
    }

    const [validTest] = await query(`
      SELECT id, test_date, result_date, result, valid_until
      FROM patch_tests 
      WHERE tenant_id = ? AND customer_id = ? AND service_id = ? 
        AND is_valid = 1 AND (valid_until IS NULL OR valid_until >= CURDATE())
      ORDER BY test_date DESC LIMIT 1
    `, [req.tenantId, req.params.customerId, req.params.serviceId]);

    res.json({
      success: true,
      data: {
        required: true,
        valid: !!validTest,
        patch_test: validTest || null
      }
    });
  } catch (error) {
    console.error('Patch test check error:', error);
    res.status(500).json({ success: false, message: 'Failed to check patch test' });
  }
});

// ── List ──
router.get('/', async (req, res) => {
  try {
    await ensureTable();
    const { customer_id, service_id, result, valid_only, page = 1, limit = 20 } = req.query;
    let where = 'WHERE pt.tenant_id = ?';
    const params = [req.tenantId];

    if (customer_id) { where += ' AND pt.customer_id = ?'; params.push(customer_id); }
    if (service_id) { where += ' AND pt.service_id = ?'; params.push(service_id); }
    if (result) { where += ' AND pt.result = ?'; params.push(result); }
    if (valid_only === 'true') { where += ' AND pt.is_valid = 1 AND (pt.valid_until IS NULL OR pt.valid_until >= CURDATE())'; }

    const [cnt] = await query(`SELECT COUNT(*) as count FROM patch_tests pt ${where}`, params);
    const total = cnt?.count || 0;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const rows = await query(`
      SELECT pt.*,
             c.first_name as customer_first_name, c.last_name as customer_last_name,
             p.name as service_name,
             s.full_name as staff_name,
             b.name as branch_name
      FROM patch_tests pt
      LEFT JOIN contacts c ON pt.customer_id = c.id
      LEFT JOIN products p ON pt.service_id = p.id
      LEFT JOIN staff s ON pt.staff_id = s.id
      LEFT JOIN branches b ON pt.branch_id = b.id
      ${where}
      ORDER BY pt.test_date DESC
      LIMIT ${parseInt(limit)} OFFSET ${offset}
    `, params);

    const data = rows.map(r => ({
      ...r,
      photos: typeof r.photos === 'string' ? JSON.parse(r.photos) : r.photos
    }));

    res.json({
      success: true,
      data,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (error) {
    console.error('Patch tests list error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch patch tests' });
  }
});

// ── Get single ──
router.get('/:id', async (req, res) => {
  try {
    await ensureTable();
    const [test] = await query(`
      SELECT pt.*,
             c.first_name as customer_first_name, c.last_name as customer_last_name,
             p.name as service_name, s.full_name as staff_name
      FROM patch_tests pt
      LEFT JOIN contacts c ON pt.customer_id = c.id
      LEFT JOIN products p ON pt.service_id = p.id
      LEFT JOIN staff s ON pt.staff_id = s.id
      WHERE pt.id = ? AND pt.tenant_id = ?
    `, [req.params.id, req.tenantId]);

    if (!test) return res.status(404).json({ success: false, message: 'Patch test not found' });
    test.photos = typeof test.photos === 'string' ? JSON.parse(test.photos) : test.photos;

    res.json({ success: true, data: test });
  } catch (error) {
    console.error('Patch test get error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch patch test' });
  }
});

// ── Create ──
router.post('/', async (req, res) => {
  try {
    await ensureTable();
    const { customer_id, service_id, staff_id, branch_id, test_date, notes, photos, valid_until } = req.body;

    if (!customer_id || !test_date) {
      return res.status(400).json({ success: false, message: 'Customer and test date required' });
    }

    const mysqlDate = new Date(test_date).toISOString().slice(0, 19).replace('T', ' ');

    const result = await execute(`
      INSERT INTO patch_tests (tenant_id, customer_id, service_id, staff_id, branch_id, test_date, notes, photos, valid_until, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.tenantId, customer_id, service_id || null, staff_id || null,
      branch_id || null, mysqlDate, notes || null,
      photos ? JSON.stringify(photos) : null,
      valid_until || null, req.user.id
    ]);

    res.status(201).json({ success: true, message: 'Patch test created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Patch test create error:', error);
    res.status(500).json({ success: false, message: 'Failed to create patch test' });
  }
});

// ── Record result ──
router.post('/:id/result', async (req, res) => {
  try {
    await ensureTable();
    const { result, notes, photos, valid_until } = req.body;

    if (!['pass', 'fail', 'reaction'].includes(result)) {
      return res.status(400).json({ success: false, message: 'Result must be pass, fail, or reaction' });
    }

    const updates = [
      'result = ?', 'result_date = NOW()', 'is_valid = ?'
    ];
    const params = [result, result === 'pass' ? 1 : 0];

    if (notes) { updates.push('notes = ?'); params.push(notes); }
    if (photos) { updates.push('photos = ?'); params.push(JSON.stringify(photos)); }
    if (valid_until) { updates.push('valid_until = ?'); params.push(valid_until); }

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE patch_tests SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);

    res.json({ success: true, message: `Patch test result: ${result}` });
  } catch (error) {
    console.error('Patch test result error:', error);
    res.status(500).json({ success: false, message: 'Failed to record result' });
  }
});

// ── Delete ──
router.delete('/:id', async (req, res) => {
  try {
    await ensureTable();
    await execute('DELETE FROM patch_tests WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Patch test deleted' });
  } catch (error) {
    console.error('Patch test delete error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete patch test' });
  }
});

export default router;
