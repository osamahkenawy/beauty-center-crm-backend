import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

const toMySQLDateTime = (isoString) => {
  const date = new Date(isoString);
  return date.toISOString().slice(0, 19).replace('T', ' ');
};

async function ensureTables() {
  await execute(`
    CREATE TABLE IF NOT EXISTS waitlists (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      branch_id INT,
      customer_id INT NOT NULL,
      service_id INT,
      preferred_staff_id INT,
      preferred_date DATE,
      preferred_time_start TIME,
      preferred_time_end TIME,
      priority INT DEFAULT 0,
      status ENUM('waiting','notified','booked','expired','cancelled') DEFAULT 'waiting',
      notes TEXT,
      notified_at DATETIME,
      booked_appointment_id INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_customer (customer_id),
      INDEX idx_status (status),
      INDEX idx_date (preferred_date)
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
        SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) as waiting,
        SUM(CASE WHEN status = 'notified' THEN 1 ELSE 0 END) as notified,
        SUM(CASE WHEN status = 'booked' THEN 1 ELSE 0 END) as booked,
        SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) as expired,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled
      FROM waitlists WHERE tenant_id = ?
    `, [t]);
    res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Waitlist stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── List ──
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { status, service_id, staff_id, from_date, to_date, page = 1, limit = 20 } = req.query;
    let where = 'WHERE w.tenant_id = ?';
    const params = [t];

    if (status) { where += ' AND w.status = ?'; params.push(status); }
    if (service_id) { where += ' AND w.service_id = ?'; params.push(service_id); }
    if (staff_id) { where += ' AND w.preferred_staff_id = ?'; params.push(staff_id); }
    if (from_date) { where += ' AND w.preferred_date >= ?'; params.push(from_date); }
    if (to_date) { where += ' AND w.preferred_date <= ?'; params.push(to_date); }

    const [{ total }] = await query(`SELECT COUNT(*) as total FROM waitlists w ${where}`, [...params]);
    const pg = parseInt(page); const lm = parseInt(limit);

    const items = await query(`
      SELECT w.*,
        c.first_name as customer_first_name, c.last_name as customer_last_name, c.phone as customer_phone,
        p.name as service_name,
        s.full_name as staff_name,
        b.name as branch_name
      FROM waitlists w
      LEFT JOIN contacts c ON w.customer_id = c.id
      LEFT JOIN products p ON w.service_id = p.id
      LEFT JOIN staff s ON w.preferred_staff_id = s.id
      LEFT JOIN branches b ON w.branch_id = b.id
      ${where}
      ORDER BY w.priority DESC, w.created_at ASC
      LIMIT ${lm} OFFSET ${(pg - 1) * lm}
    `, [...params]);

    res.json({ success: true, data: items, pagination: { page: pg, limit: lm, total, totalPages: Math.ceil(total / lm) } });
  } catch (error) {
    console.error('List waitlist error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Get single ──
router.get('/:id', async (req, res) => {
  try {
    await ensureTables();
    const [item] = await query(`
      SELECT w.*,
        c.first_name as customer_first_name, c.last_name as customer_last_name, c.phone as customer_phone, c.email as customer_email,
        p.name as service_name, p.duration as service_duration, p.unit_price as service_price,
        s.full_name as staff_name,
        b.name as branch_name
      FROM waitlists w
      LEFT JOIN contacts c ON w.customer_id = c.id
      LEFT JOIN products p ON w.service_id = p.id
      LEFT JOIN staff s ON w.preferred_staff_id = s.id
      LEFT JOIN branches b ON w.branch_id = b.id
      WHERE w.id = ? AND w.tenant_id = ?
    `, [req.params.id, req.tenantId]);
    if (!item) return res.status(404).json({ success: false, message: 'Waitlist entry not found' });
    res.json({ success: true, data: item });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Create ──
router.post('/', async (req, res) => {
  try {
    await ensureTables();
    const t = req.tenantId;
    const { customer_id, service_id, branch_id, preferred_staff_id, preferred_date, preferred_time_start, preferred_time_end, priority = 0, notes } = req.body;

    if (!customer_id) return res.status(400).json({ success: false, message: 'Customer is required' });

    const result = await execute(`
      INSERT INTO waitlists (tenant_id, branch_id, customer_id, service_id, preferred_staff_id, preferred_date, preferred_time_start, preferred_time_end, priority, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `, [t, branch_id || null, customer_id, service_id || null, preferred_staff_id || null, preferred_date || null, preferred_time_start || null, preferred_time_end || null, priority, notes || null]);

    res.status(201).json({ success: true, data: { id: result.insertId }, message: 'Added to waitlist' });
  } catch (error) {
    console.error('Create waitlist error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Update status ──
router.patch('/:id', async (req, res) => {
  try {
    const fields = ['status', 'priority', 'notes', 'preferred_date', 'preferred_time_start', 'preferred_time_end', 'preferred_staff_id', 'service_id', 'branch_id'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
    }
    if (req.body.status === 'notified') { updates.push('notified_at = NOW()'); }
    if (req.body.status === 'booked' && req.body.appointment_id) {
      updates.push('booked_appointment_id = ?'); params.push(req.body.appointment_id);
    }
    if (!updates.length) return res.status(400).json({ success: false, message: 'No fields to update' });

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE waitlists SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    res.json({ success: true, message: 'Waitlist entry updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Delete ──
router.delete('/:id', async (req, res) => {
  try {
    const [item] = await query('SELECT id FROM waitlists WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!item) return res.status(404).json({ success: false, message: 'Waitlist entry not found' });
    await execute('DELETE FROM waitlists WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Waitlist entry removed' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Convert to appointment ──
router.post('/:id/book', async (req, res) => {
  try {
    const [item] = await query('SELECT * FROM waitlists WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!item) return res.status(404).json({ success: false, message: 'Waitlist entry not found' });
    if (item.status !== 'waiting' && item.status !== 'notified') {
      return res.status(400).json({ success: false, message: 'Entry is not in waiting/notified status' });
    }

    const { start_time, end_time, staff_id } = req.body;
    if (!start_time || !end_time) return res.status(400).json({ success: false, message: 'Start and end time required' });

    // Create appointment
    const aptResult = await execute(`
      INSERT INTO appointments (tenant_id, customer_id, service_id, staff_id, start_time, end_time, status, notes)
      VALUES (?,?,?,?,?,?,?,?)
    `, [req.tenantId, item.customer_id, item.service_id, staff_id || item.preferred_staff_id, toMySQLDateTime(start_time), toMySQLDateTime(end_time), 'scheduled', item.notes || null]);

    // Update waitlist entry
    await execute(`UPDATE waitlists SET status = 'booked', booked_appointment_id = ? WHERE id = ?`, [aptResult.insertId, item.id]);

    res.json({ success: true, data: { appointment_id: aptResult.insertId, waitlist_id: item.id }, message: 'Appointment booked from waitlist' });
  } catch (error) {
    console.error('Book from waitlist error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
