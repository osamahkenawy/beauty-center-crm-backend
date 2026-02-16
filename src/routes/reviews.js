import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

async function ensureTables() {
  await execute(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      branch_id INT,
      appointment_id INT,
      customer_id INT NOT NULL,
      staff_id INT,
      service_id INT,
      rating TINYINT NOT NULL,
      comment TEXT,
      is_public TINYINT(1) DEFAULT 1,
      response TEXT,
      responded_at DATETIME,
      responded_by INT,
      status ENUM('pending','approved','rejected') DEFAULT 'approved',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_customer (customer_id),
      INDEX idx_staff (staff_id),
      INDEX idx_service (service_id),
      INDEX idx_rating (rating),
      INDEX idx_appointment (appointment_id)
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
        COUNT(*) as total_reviews,
        ROUND(AVG(rating), 1) as average_rating,
        SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) as five_star,
        SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) as four_star,
        SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) as three_star,
        SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) as two_star,
        SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) as one_star,
        SUM(CASE WHEN response IS NOT NULL THEN 1 ELSE 0 END) as responded,
        SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) as last_30_days
      FROM reviews WHERE tenant_id = ?
    `, [t]);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Review stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── List reviews ──
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { rating, staff_id, service_id, status, has_response, page = 1, limit = 20 } = req.query;
    let where = 'WHERE r.tenant_id = ?';
    const params = [t];

    if (rating) { where += ' AND r.rating = ?'; params.push(parseInt(rating)); }
    if (staff_id) { where += ' AND r.staff_id = ?'; params.push(staff_id); }
    if (service_id) { where += ' AND r.service_id = ?'; params.push(service_id); }
    if (status) { where += ' AND r.status = ?'; params.push(status); }
    if (has_response === 'true') where += ' AND r.response IS NOT NULL';
    if (has_response === 'false') where += ' AND r.response IS NULL';

    const pg = parseInt(page); const lm = parseInt(limit);
    const [{ total }] = await query(`SELECT COUNT(*) as total FROM reviews r ${where}`, [...params]);

    const reviews = await query(`
      SELECT r.*,
        c.first_name as customer_first_name, c.last_name as customer_last_name,
        s.full_name as staff_name,
        p.name as service_name,
        b.name as branch_name
      FROM reviews r
      LEFT JOIN contacts c ON r.customer_id = c.id
      LEFT JOIN staff s ON r.staff_id = s.id
      LEFT JOIN products p ON r.service_id = p.id
      LEFT JOIN branches b ON r.branch_id = b.id
      ${where}
      ORDER BY r.created_at DESC
      LIMIT ${lm} OFFSET ${(pg - 1) * lm}
    `, [...params]);

    res.json({ success: true, data: reviews, pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) } });
  } catch (error) {
    console.error('List reviews error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Get single ──
router.get('/:id', async (req, res) => {
  try {
    await ensureTables();
    const [review] = await query(`
      SELECT r.*,
        c.first_name as customer_first_name, c.last_name as customer_last_name,
        s.full_name as staff_name,
        p.name as service_name,
        b.name as branch_name
      FROM reviews r
      LEFT JOIN contacts c ON r.customer_id = c.id
      LEFT JOIN staff s ON r.staff_id = s.id
      LEFT JOIN products p ON r.service_id = p.id
      LEFT JOIN branches b ON r.branch_id = b.id
      WHERE r.id = ? AND r.tenant_id = ?
    `, [req.params.id, req.tenantId]);
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' });
    res.json({ success: true, data: review });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Create review ──
router.post('/', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { customer_id, staff_id, service_id, appointment_id, branch_id, rating, comment, is_public = 1 } = req.body;

    if (!customer_id || !rating) return res.status(400).json({ success: false, message: 'Customer and rating are required' });
    if (rating < 1 || rating > 5) return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });

    // Prevent duplicate reviews for the same appointment
    if (appointment_id) {
      const [existing] = await query('SELECT id FROM reviews WHERE appointment_id = ? AND tenant_id = ?', [appointment_id, t]);
      if (existing) return res.status(409).json({ success: false, message: 'Review already exists for this appointment' });
    }

    const result = await execute(`
      INSERT INTO reviews (tenant_id, branch_id, appointment_id, customer_id, staff_id, service_id, rating, comment, is_public)
      VALUES (?,?,?,?,?,?,?,?,?)
    `, [t, branch_id || null, appointment_id || null, customer_id, staff_id || null, service_id || null, rating, comment || null, is_public]);

    res.status(201).json({ success: true, data: { id: result.insertId }, message: 'Review submitted' });
  } catch (error) {
    console.error('Create review error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Respond to review ──
router.post('/:id/respond', async (req, res) => {
  try {
    const { response } = req.body;
    if (!response) return res.status(400).json({ success: false, message: 'Response is required' });

    const [review] = await query('SELECT id FROM reviews WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!review) return res.status(404).json({ success: false, message: 'Review not found' });

    await execute('UPDATE reviews SET response = ?, responded_at = NOW(), responded_by = ? WHERE id = ?',
      [response, req.user?.id || null, req.params.id]);

    res.json({ success: true, message: 'Response added' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Update review status ──
router.patch('/:id', async (req, res) => {
  try {
    const fields = ['status', 'is_public'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (!updates.length) return res.status(400).json({ success: false, message: 'No fields to update' });

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE reviews SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    res.json({ success: true, message: 'Review updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Delete review ──
router.delete('/:id', async (req, res) => {
  try {
    await execute('DELETE FROM reviews WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Review deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Staff ratings summary ──
router.get('/staff/:staffId/summary', async (req, res) => {
  try {
    await ensureTables();
    const [summary] = await query(`
      SELECT
        COUNT(*) as total_reviews,
        ROUND(AVG(rating), 1) as average_rating,
        SUM(CASE WHEN rating >= 4 THEN 1 ELSE 0 END) as positive,
        SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) as negative
      FROM reviews WHERE staff_id = ? AND tenant_id = ?
    `, [req.params.staffId, req.tenantId]);

    const recent = await query(`
      SELECT r.rating, r.comment, r.created_at, c.first_name, c.last_name
      FROM reviews r
      LEFT JOIN contacts c ON r.customer_id = c.id
      WHERE r.staff_id = ? AND r.tenant_id = ? AND r.is_public = 1
      ORDER BY r.created_at DESC LIMIT 10
    `, [req.params.staffId, req.tenantId]);

    res.json({ success: true, data: { ...summary, recent_reviews: recent } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Service ratings summary ──
router.get('/service/:serviceId/summary', async (req, res) => {
  try {
    await ensureTables();
    const [summary] = await query(`
      SELECT
        COUNT(*) as total_reviews,
        ROUND(AVG(rating), 1) as average_rating
      FROM reviews WHERE service_id = ? AND tenant_id = ?
    `, [req.params.serviceId, req.tenantId]);
    res.json({ success: true, data: summary });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
