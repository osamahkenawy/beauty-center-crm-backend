import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { notifyClient } from '../lib/notify.js';
import { sendNotificationEmail } from '../lib/email.js';

const router = express.Router();

/* ─── Ensure beauty-specific columns exist ─── */
async function ensureColumns() {
  const cols = [
    ['gender', "VARCHAR(20) DEFAULT NULL"],
    ['date_of_birth', "DATE DEFAULT NULL"],
    ['notes', "TEXT"],
    ['preferred_staff_id', "INT DEFAULT NULL"],
    ['tags', "JSON"],
    ['source', "VARCHAR(50) DEFAULT 'walk-in'"],
    ['address', "TEXT"],
    ['instagram', "VARCHAR(100) DEFAULT NULL"],
    ['allergies', "TEXT"],
    ['referral_source', "VARCHAR(100) DEFAULT NULL"],
    ['is_vip', "TINYINT(1) NOT NULL DEFAULT 0"],
  ];
  for (const [col, def] of cols) {
    try { await execute(`ALTER TABLE contacts ADD COLUMN ${col} ${def}`); } catch (_) { /* exists */ }
  }
}
ensureColumns();

/* ─── Helpers ─── */
function validateEmail(email) {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function validatePhone(phone) {
  if (!phone) return true;
  return /^[+]?[\d\s\-()]{7,20}$/.test(phone);
}

/* ─────────────────────────────────────────────
   GET /stats – Dashboard stats (before /:id)
   ───────────────────────────────────────────── */
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const tid = req.tenantId;
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const [[totals]] = await Promise.all([
      query(`SELECT
        COUNT(*) as total,
        SUM(status = 'active') as active,
        SUM(status = 'inactive') as inactive
        FROM contacts WHERE tenant_id = ?`, [tid]),
    ]);

    const [newThisMonth] = await query(
      `SELECT COUNT(*) as cnt FROM contacts WHERE tenant_id = ? AND created_at >= ?`, [tid, monthStart]
    );

    // VIP = contacts with is_vip flag set
    const [vip] = await query(
      `SELECT COUNT(*) as cnt FROM contacts WHERE tenant_id = ? AND is_vip = 1`, [tid]
    );

    // Top spenders
    const topSpenders = await query(
      `SELECT c.id, c.first_name, c.last_name, c.email, c.phone,
        COALESCE(SUM(i.total), 0) as total_spent,
        COUNT(DISTINCT i.id) as invoice_count
       FROM contacts c
       LEFT JOIN invoices i ON i.customer_id = c.id AND i.tenant_id = c.tenant_id AND i.status = 'paid'
       WHERE c.tenant_id = ?
       GROUP BY c.id
       ORDER BY total_spent DESC
       LIMIT 5`, [tid]
    );

    // Source breakdown
    const sources = await query(
      `SELECT COALESCE(source, 'walk-in') as source, COUNT(*) as count
       FROM contacts WHERE tenant_id = ?
       GROUP BY source ORDER BY count DESC`, [tid]
    );

    // Gender breakdown
    const genders = await query(
      `SELECT COALESCE(gender, 'unspecified') as gender, COUNT(*) as count
       FROM contacts WHERE tenant_id = ?
       GROUP BY gender ORDER BY count DESC`, [tid]
    );

    // Monthly growth (last 6 months)
    const growth = await query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m') as month, COUNT(*) as count
       FROM contacts WHERE tenant_id = ?
       AND created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
       GROUP BY month ORDER BY month ASC`, [tid]
    );

    res.json({
      success: true,
      data: {
        total: totals?.total || 0,
        active: totals?.active || 0,
        inactive: totals?.inactive || 0,
        vip: vip?.cnt || 0,
        newThisMonth: newThisMonth?.cnt || 0,
        topSpenders,
        sources,
        genders,
        growth,
      }
    });
  } catch (error) {
    console.error('Client stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

/* ─────────────────────────────────────────────
   GET / – List contacts with enriched data
   ───────────────────────────────────────────── */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 100, search, status, source, gender, vip, sort = 'newest' } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const tid = req.tenantId;

    let sql = `
      SELECT c.*,
        lp.points as loyalty_points,
        lp.tier as loyalty_tier,
        lp.total_earned as loyalty_total_earned,
        COALESCE(inv.total_spent, 0) as total_spent,
        COALESCE(inv.invoice_count, 0) as invoice_count,
        appt.last_visit,
        COALESCE(appt.total_visits, 0) as total_visits,
        appt.total_appointments,
        appt.upcoming_appointment
      FROM contacts c
      LEFT JOIN loyalty_points lp ON lp.customer_id = c.id AND lp.tenant_id = c.tenant_id
      LEFT JOIN (
        SELECT customer_id, tenant_id,
          SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END) as total_spent,
          COUNT(CASE WHEN status = 'paid' THEN 1 END) as invoice_count
        FROM invoices GROUP BY customer_id, tenant_id
      ) inv ON inv.customer_id = c.id AND inv.tenant_id = c.tenant_id
      LEFT JOIN (
        SELECT customer_id, tenant_id,
          MAX(CASE WHEN status = 'completed' THEN DATE(start_time) END) as last_visit,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as total_visits,
          COUNT(*) as total_appointments,
          MIN(CASE WHEN DATE(start_time) >= CURDATE() AND status IN ('confirmed','scheduled') THEN DATE(start_time) END) as upcoming_appointment
        FROM appointments GROUP BY customer_id, tenant_id
      ) appt ON appt.customer_id = c.id AND appt.tenant_id = c.tenant_id
      WHERE c.tenant_id = ?
    `;
    const params = [tid];

    if (search) {
      sql += ` AND (c.first_name LIKE ? OR c.last_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR CONCAT(c.first_name,' ',c.last_name) LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }
    if (status) { sql += ' AND c.status = ?'; params.push(status); }
    if (source) { sql += ' AND c.source = ?'; params.push(source); }
    if (gender) { sql += ' AND c.gender = ?'; params.push(gender); }
    if (vip === 'true') { sql += ' AND c.is_vip = 1'; }

    // Sorting
    const sortMap = {
      newest: 'c.created_at DESC',
      oldest: 'c.created_at ASC',
      name_asc: 'c.first_name ASC, c.last_name ASC',
      name_desc: 'c.first_name DESC, c.last_name DESC',
      spent_high: 'total_spent DESC',
      spent_low: 'total_spent ASC',
      recent_visit: 'COALESCE(appt.last_visit, "1970-01-01") DESC',
    };
    sql += ` ORDER BY ${sortMap[sort] || sortMap.newest}`;
    sql += ` LIMIT ${parseInt(limit)} OFFSET ${offset}`;

    const contacts = await query(sql, params);

    // Count
    let countSql = 'SELECT COUNT(*) as total FROM contacts WHERE tenant_id = ?';
    const countParams = [tid];
    if (search) {
      countSql += ` AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ? OR CONCAT(first_name,' ',last_name) LIKE ?)`;
      const s = `%${search}%`;
      countParams.push(s, s, s, s, s);
    }
    if (status) { countSql += ' AND status = ?'; countParams.push(status); }
    if (source) { countSql += ' AND source = ?'; countParams.push(source); }
    if (gender) { countSql += ' AND gender = ?'; countParams.push(gender); }
    if (vip === 'true') { countSql += ' AND is_vip = 1'; }

    const [countResult] = await query(countSql, countParams);

    res.json({
      success: true,
      data: contacts,
      pagination: { page: parseInt(page), limit: parseInt(limit), total: countResult?.total || 0 }
    });
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch contacts' });
  }
});

/* ─────────────────────────────────────────────
   GET /:id – Single contact with full summary
   ───────────────────────────────────────────── */
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const tid = req.tenantId;
    const [contact] = await query(`
      SELECT c.*,
        lp.points as loyalty_points,
        lp.tier as loyalty_tier,
        lp.total_earned as loyalty_total_earned,
        lp.total_redeemed as loyalty_total_redeemed
      FROM contacts c
      LEFT JOIN loyalty_points lp ON lp.customer_id = c.id AND lp.tenant_id = c.tenant_id
      WHERE c.id = ? AND c.tenant_id = ?
    `, [req.params.id, tid]);

    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });

    // Fetch appointments
    const appointments = await query(
      `SELECT a.id, a.start_time, a.end_time, a.status, a.notes,
         DATE(a.start_time) as appointment_date,
         p.name as service_name, st.full_name as staff_name
       FROM appointments a
       LEFT JOIN products p ON a.service_id = p.id
       LEFT JOIN staff st ON a.staff_id = st.id
       WHERE a.customer_id = ? AND a.tenant_id = ?
       ORDER BY a.start_time DESC
       LIMIT 20`,
      [req.params.id, tid]
    );

    // Fetch invoices
    const invoices = await query(
      `SELECT id, invoice_number, total, status, created_at
       FROM invoices
       WHERE customer_id = ? AND tenant_id = ?
       ORDER BY created_at DESC LIMIT 10`,
      [req.params.id, tid]
    );

    // Total spend
    const [spend] = await query(
      `SELECT COALESCE(SUM(total), 0) as total_spent, COUNT(*) as paid_invoices
       FROM invoices WHERE customer_id = ? AND tenant_id = ? AND status = 'paid'`,
      [req.params.id, tid]
    );

    // Loyalty transactions
    const loyaltyTxns = await query(
      `SELECT * FROM loyalty_transactions
       WHERE customer_id = ? AND tenant_id = ?
       ORDER BY created_at DESC LIMIT 15`,
      [req.params.id, tid]
    );

    res.json({
      success: true,
      data: {
        ...contact,
        appointments,
        invoices,
        total_spent: spend?.total_spent || 0,
        paid_invoices: spend?.paid_invoices || 0,
        loyalty_transactions: loyaltyTxns,
      }
    });
  } catch (error) {
    console.error('Get contact error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch contact' });
  }
});

/* ─────────────────────────────────────────────
   POST / – Create contact with validation
   ───────────────────────────────────────────── */
router.post('/', authMiddleware, async (req, res) => {
  try {
    const tid = req.tenantId;
    const {
      first_name, last_name, email, phone, mobile, gender, date_of_birth,
      notes, tags, source, address, instagram, allergies, referral_source,
      job_title, department, account_id, is_primary, owner_id, is_vip
    } = req.body;

    if (!first_name?.trim()) {
      return res.status(400).json({ success: false, message: 'First name is required' });
    }
    if (email && !validateEmail(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }
    if (phone && !validatePhone(phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone format' });
    }

    // Check duplicate email
    if (email) {
      const [dup] = await query('SELECT id FROM contacts WHERE email = ? AND tenant_id = ?', [email, tid]);
      if (dup) return res.status(400).json({ success: false, message: 'A client with this email already exists' });
    }

    const result = await execute(
      `INSERT INTO contacts (tenant_id, first_name, last_name, email, phone, mobile, gender, date_of_birth,
        notes, tags, source, address, instagram, allergies, referral_source,
        job_title, department, account_id, is_primary, owner_id, created_by, is_vip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tid, first_name.trim(), last_name?.trim() || null, email?.trim() || null, phone?.trim() || null,
       mobile?.trim() || null, gender || null, date_of_birth || null,
       notes || null, tags ? JSON.stringify(tags) : null, source || 'walk-in',
       address || null, instagram || null, allergies || null, referral_source || null,
       job_title || null, department || null, account_id || null, is_primary ? 1 : 0,
       owner_id || req.user.id, req.user.id, is_vip ? 1 : 0]
    );

    await execute(
      'INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_values) VALUES (?, ?, ?, ?, ?, ?)',
      [tid, req.user.id, 'create', 'contact', result.insertId, JSON.stringify({ first_name, last_name, email })]
    );

    // Push notification
    notifyClient(tid, `New Client — ${first_name} ${last_name || ''}`.trim(), email || phone || 'Added via dashboard', { client_id: result.insertId }).catch(() => {});

    // Send welcome email if email provided
    if (email) {
      try {
        await sendNotificationEmail({
          to: email,
          subject: `Welcome to ${first_name}! 👋`,
          title: `Welcome! We're Excited to Have You`,
          body: `
            <p>Dear ${first_name}${last_name ? ` ${last_name}` : ''},</p>
            <p>Welcome to our beauty center! We're thrilled to have you as part of our community.</p>
            <p>We're here to help you look and feel your best. Whether you're looking for a new style, a relaxing treatment, or expert advice, our team is ready to serve you.</p>
            <p><strong>What's next?</strong></p>
            <ul>
              <li>Book your first appointment</li>
              <li>Explore our services</li>
              <li>Join our loyalty program to earn rewards</li>
            </ul>
            <p>If you have any questions or special requests, don't hesitate to reach out to us.</p>
            <p>We look forward to seeing you soon!</p>
            <p>Best regards,<br>The Team</p>
          `,
          tenantId: tid,
        }).catch(err => console.error('Failed to send welcome email:', err.message));
      } catch (emailErr) {
        console.error('Error sending welcome email:', emailErr);
      }
    }

    res.json({ success: true, message: 'Client created successfully', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create contact error:', error);
    res.status(500).json({ success: false, message: 'Failed to create client' });
  }
});

/* ─────────────────────────────────────────────
   PATCH /:id – Update contact
   ───────────────────────────────────────────── */
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const tid = req.tenantId;

    const [existing] = await query('SELECT id, email FROM contacts WHERE id = ? AND tenant_id = ?', [id, tid]);
    if (!existing) return res.status(404).json({ success: false, message: 'Contact not found' });

    // Validate
    if (req.body.email && !validateEmail(req.body.email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }
    if (req.body.phone && !validatePhone(req.body.phone)) {
      return res.status(400).json({ success: false, message: 'Invalid phone format' });
    }

    // Check duplicate email (excluding self)
    if (req.body.email && req.body.email !== existing.email) {
      const [dup] = await query('SELECT id FROM contacts WHERE email = ? AND tenant_id = ? AND id != ?', [req.body.email, tid, id]);
      if (dup) return res.status(400).json({ success: false, message: 'A client with this email already exists' });
    }

    const fields = [
      'first_name', 'last_name', 'email', 'phone', 'mobile', 'gender', 'date_of_birth',
      'notes', 'tags', 'source', 'address', 'instagram', 'allergies', 'referral_source',
      'job_title', 'department', 'account_id', 'is_primary', 'status', 'owner_id', 'is_vip'
    ];
    const updates = [];
    const params = [];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        let value = req.body[field];
        if (field === 'is_primary' || field === 'is_vip') value = value ? 1 : 0;
        if (['account_id', 'owner_id'].includes(field) && value === '') value = null;
        if (field === 'tags' && Array.isArray(value)) value = JSON.stringify(value);
        if (field === 'first_name') value = value?.trim();
        if (field === 'last_name') value = value?.trim() || null;
        if (field === 'email') value = value?.trim() || null;
        if (field === 'phone') value = value?.trim() || null;
        params.push(value);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No updates provided' });
    }

    params.push(id, tid);
    await execute(`UPDATE contacts SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);

    await execute(
      'INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_values) VALUES (?, ?, ?, ?, ?, ?)',
      [tid, req.user.id, 'update', 'contact', id, JSON.stringify(req.body)]
    );

    res.json({ success: true, message: 'Client updated successfully' });
  } catch (error) {
    console.error('Update contact error:', error);
    res.status(500).json({ success: false, message: 'Failed to update client' });
  }
});

/* ─────────────────────────────────────────────
   PATCH /:id/toggle-vip – Toggle VIP status
   ───────────────────────────────────────────── */
router.patch('/:id/toggle-vip', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const tid = req.tenantId;

    const [contact] = await query('SELECT id, is_vip FROM contacts WHERE id = ? AND tenant_id = ?', [id, tid]);
    if (!contact) return res.status(404).json({ success: false, message: 'Contact not found' });

    const newValue = contact.is_vip ? 0 : 1;
    await execute('UPDATE contacts SET is_vip = ? WHERE id = ? AND tenant_id = ?', [newValue, id, tid]);

    await execute(
      'INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_values) VALUES (?, ?, ?, ?, ?, ?)',
      [tid, req.user.id, 'toggle_vip', 'contact', id, JSON.stringify({ is_vip: newValue })]
    );

    res.json({ success: true, message: newValue ? 'Client marked as VIP' : 'VIP status removed', data: { is_vip: newValue } });
  } catch (error) {
    console.error('Toggle VIP error:', error);
    res.status(500).json({ success: false, message: 'Failed to toggle VIP status' });
  }
});

/* ─────────────────────────────────────────────
   DELETE /:id
   ───────────────────────────────────────────── */
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const tid = req.tenantId;

    // Check for linked appointments
    const [linkedAppts] = await query(
      'SELECT COUNT(*) as cnt FROM appointments WHERE customer_id = ? AND tenant_id = ? AND status IN (\'confirmed\',\'pending\')',
      [id, tid]
    );
    if (linkedAppts?.cnt > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete client with ${linkedAppts.cnt} upcoming appointment(s). Cancel them first.`
      });
    }

    const result = await execute('DELETE FROM contacts WHERE id = ? AND tenant_id = ?', [id, tid]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }

    // Clean up loyalty
    await execute('DELETE FROM loyalty_points WHERE customer_id = ? AND tenant_id = ?', [id, tid]);
    await execute('DELETE FROM loyalty_transactions WHERE customer_id = ? AND tenant_id = ?', [id, tid]);

    await execute(
      'INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)',
      [tid, req.user.id, 'delete', 'contact', id]
    );

    res.json({ success: true, message: 'Client deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete client' });
  }
});

export default router;
