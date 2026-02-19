import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query, execute } from '../lib/database.js';
import { authMiddleware, adminOnly, canAccess } from '../middleware/auth.js';
import { config } from '../config.js';
import { sendInviteEmail as sendInvite } from '../lib/email.js';
import { notifyStaff } from '../lib/notify.js';

const router = express.Router();

// ─── Ensure all necessary columns exist ─────────────────
async function ensureSchema() {
  const cols = [
    { name: 'branch_id', sql: 'ALTER TABLE staff ADD COLUMN branch_id INT AFTER role' },
    { name: 'tenant_id', sql: 'ALTER TABLE staff ADD COLUMN tenant_id INT AFTER id' },
    { name: 'avatar_url', sql: "ALTER TABLE staff ADD COLUMN avatar_url VARCHAR(500) DEFAULT NULL" },
    { name: 'job_title', sql: "ALTER TABLE staff ADD COLUMN job_title VARCHAR(100) DEFAULT NULL" },
    { name: 'bio', sql: "ALTER TABLE staff ADD COLUMN bio TEXT DEFAULT NULL" },
    { name: 'hire_date', sql: "ALTER TABLE staff ADD COLUMN hire_date DATE DEFAULT NULL" },
    { name: 'commission_rate', sql: "ALTER TABLE staff ADD COLUMN commission_rate DECIMAL(5,2) DEFAULT 0" },
    { name: 'color', sql: "ALTER TABLE staff ADD COLUMN color VARCHAR(7) DEFAULT '#667eea'" },
    { name: 'can_book_online', sql: "ALTER TABLE staff ADD COLUMN can_book_online TINYINT(1) DEFAULT 1" },
    { name: 'notes', sql: "ALTER TABLE staff ADD COLUMN notes TEXT DEFAULT NULL" },
    { name: 'emergency_contact', sql: "ALTER TABLE staff ADD COLUMN emergency_contact VARCHAR(255) DEFAULT NULL" },
    { name: 'salary', sql: "ALTER TABLE staff ADD COLUMN salary DECIMAL(10,2) DEFAULT NULL" },
    { name: 'employment_type', sql: "ALTER TABLE staff ADD COLUMN employment_type VARCHAR(50) DEFAULT 'full_time'" },
    // New fields
    { name: 'nationality', sql: "ALTER TABLE staff ADD COLUMN nationality VARCHAR(100) DEFAULT NULL" },
    { name: 'national_id', sql: "ALTER TABLE staff ADD COLUMN national_id VARCHAR(100) DEFAULT NULL" },
    { name: 'date_of_birth', sql: "ALTER TABLE staff ADD COLUMN date_of_birth DATE DEFAULT NULL" },
    { name: 'gender', sql: "ALTER TABLE staff ADD COLUMN gender VARCHAR(20) DEFAULT NULL" },
    { name: 'invite_token', sql: "ALTER TABLE staff ADD COLUMN invite_token VARCHAR(255) DEFAULT NULL" },
    { name: 'invite_token_expires', sql: "ALTER TABLE staff ADD COLUMN invite_token_expires DATETIME DEFAULT NULL" },
    { name: 'password_set', sql: "ALTER TABLE staff ADD COLUMN password_set TINYINT(1) DEFAULT 0" },
    { name: 'salary_currency', sql: "ALTER TABLE staff ADD COLUMN salary_currency VARCHAR(10) DEFAULT NULL" },
    { name: 'address', sql: "ALTER TABLE staff ADD COLUMN address TEXT DEFAULT NULL" },
  ];
  for (const col of cols) {
    try { await execute(col.sql); } catch (e) { /* column already exists */ }
  }
}

// ─── Send invite email (uses shared email utility) ──────
async function sendInviteEmail(member, token, tenantId, tenantName) {
  return sendInvite(member, token, tenantId, tenantName);
}

// ═══════════════════════════════════════════════════════
// ─── Test email sending (admin only) ──────────────────
// ═══════════════════════════════════════════════════════
router.post('/test-email', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { to } = req.body;
    const { sendEmail } = await import('../lib/email.js');
    const result = await sendEmail({
      to: to || req.user.email,
      subject: 'Test Email from Trasealla CRM',
      html: `
        <div style="max-width:500px;margin:0 auto;font-family:Arial,sans-serif;">
          <div style="background:#f2421b;padding:24px;text-align:center;border-radius:12px 12px 0 0;">
            <h1 style="color:#fff;margin:0;font-size:22px;">✅ Email Working!</h1>
          </div>
          <div style="background:#fff;padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;">
            <p style="color:#333;font-size:16px;">This is a test email from your CRM system.</p>
            <p style="color:#555;font-size:14px;">If you received this, email sending is configured correctly.</p>
            <p style="color:#aaa;font-size:12px;">Sent at: ${new Date().toISOString()}</p>
          </div>
        </div>
      `,
      tenantId: req.tenantId,
    });

    if (result.success) {
      res.json({ success: true, message: `Test email sent to ${to || req.user.email}`, messageId: result.messageId });
    } else {
      res.status(400).json({ success: false, message: 'Email failed to send', error: result.error });
    }
  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({ success: false, message: 'Failed to send test email', error: error.message });
  }
});

// ═══════════════════════════════════════════════════════
// ─── Stats ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    await ensureSchema();
    const tenantId = req.tenantId;

    const [totals] = await query(
      `SELECT 
        COUNT(*) as total,
        SUM(is_active = 1) as active,
        SUM(is_active = 0) as inactive,
        SUM(role = 'admin') as admins,
        SUM(role = 'manager') as managers,
        SUM(role IN ('staff','employee','receptionist')) as staff_count,
        SUM(password_set = 0 AND invite_token IS NOT NULL) as pending_invites
      FROM staff WHERE tenant_id = ?`,
      [tenantId]
    );

    let completedThisMonth = 0;
    let revenueThisMonth = 0;
    try {
      const [monthlyPerf] = await query(
        `SELECT COUNT(*) as cnt FROM appointments WHERE tenant_id = ? AND status = 'completed'
         AND start_time >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
        [tenantId]
      );
      completedThisMonth = monthlyPerf?.cnt || 0;
    } catch (e) { /* */ }

    try {
      const [monthlyRev] = await query(
        `SELECT COALESCE(SUM(COALESCE(final_price, original_price, 0)), 0) as rev FROM appointments 
         WHERE tenant_id = ? AND status = 'completed'
         AND start_time >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
        [tenantId]
      );
      revenueThisMonth = parseFloat(monthlyRev?.rev || 0);
    } catch (e) { /* */ }

    res.json({
      success: true,
      data: {
        total: totals?.total || 0,
        active: totals?.active || 0,
        inactive: totals?.inactive || 0,
        admins: totals?.admins || 0,
        managers: totals?.managers || 0,
        staff_count: totals?.staff_count || 0,
        pending_invites: totals?.pending_invites || 0,
        completed_this_month: completedThisMonth,
        revenue_this_month: revenueThisMonth,
      }
    });
  } catch (error) {
    console.error('Staff stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats', debug: error.message });
  }
});

// ═══════════════════════════════════════════════════════
// ─── Get all staff (with branch info + performance) ────
// ═══════════════════════════════════════════════════════
router.get('/', authMiddleware, async (req, res) => {
  try {
    await ensureSchema();
    const tenantId = req.tenantId;

    let sql = `
      SELECT s.id, s.username, s.email, s.full_name, s.phone, s.role, 
             s.is_active, s.last_login, s.created_at, s.branch_id, s.tenant_id,
             s.avatar_url, s.job_title, s.bio, s.hire_date, s.commission_rate,
             s.color, s.can_book_online, s.notes, s.emergency_contact,
             s.salary, s.employment_type, s.salary_currency,
             s.nationality, s.national_id, s.date_of_birth, s.gender,
             s.password_set, s.invite_token, s.address,
             b.name as branch_name
      FROM staff s
      LEFT JOIN branches b ON s.branch_id = b.id
      WHERE 1=1
    `;
    const params = [];

    if (tenantId) {
      sql += ' AND (s.tenant_id = ? OR s.tenant_id IS NULL)';
      params.push(tenantId);
    }

    if (req.query.branch_id) {
      sql += ' AND s.branch_id = ?';
      params.push(req.query.branch_id);
    }

    if (req.query.role) {
      sql += ' AND s.role = ?';
      params.push(req.query.role);
    }

    if (req.query.active !== undefined) {
      sql += ' AND s.is_active = ?';
      params.push(req.query.active === 'true' ? 1 : 0);
    }

    if (req.query.search) {
      sql += ' AND (s.full_name LIKE ? OR s.email LIKE ? OR s.phone LIKE ? OR s.username LIKE ?)';
      const s = `%${req.query.search}%`;
      params.push(s, s, s, s);
    }

    sql += ' ORDER BY s.is_active DESC, s.created_at DESC';

    const staff = await query(sql, params);

    // Get appointment performance per staff
    let perfMap = {};
    try {
      const perfs = await query(
        `SELECT staff_id,
          COUNT(*) as total_appointments,
          SUM(start_time >= DATE_FORMAT(NOW(), '%Y-%m-01')) as appointments_this_month,
          COALESCE(SUM(COALESCE(final_price, original_price, 0)), 0) as total_revenue
         FROM appointments WHERE tenant_id = ? AND status = 'completed' GROUP BY staff_id`,
        [tenantId]
      );
      perfs.forEach(p => { perfMap[p.staff_id] = p; });
    } catch (e) { /* */ }

    // Get review ratings per staff (optional)
    let reviewMap = {};
    try {
      const revs = await query(
        `SELECT staff_id, AVG(rating) as avg_rating, COUNT(*) as review_count
         FROM reviews WHERE tenant_id = ? GROUP BY staff_id`,
        [tenantId]
      );
      revs.forEach(r => { reviewMap[r.staff_id] = r; });
    } catch (e) { /* reviews table might not exist */ }

    // Get specializations for each staff
    let specMap = {};
    try {
      const specs = await query(
        `SELECT ss.staff_id, ss.service_id, ss.skill_level, p.name as service_name
         FROM staff_specializations ss
         LEFT JOIN products p ON ss.service_id = p.id
         WHERE ss.tenant_id = ?`,
        [tenantId]
      );
      specs.forEach(sp => {
        if (!specMap[sp.staff_id]) specMap[sp.staff_id] = [];
        specMap[sp.staff_id].push(sp);
      });
    } catch (e) { /* */ }

    // Get schedules for each staff
    let schedMap = {};
    try {
      const schedules = await query(
        `SELECT staff_id, day_of_week, start_time, end_time FROM staff_schedule WHERE tenant_id = ?`,
        [tenantId]
      );
      schedules.forEach(sc => {
        if (!schedMap[sc.staff_id]) schedMap[sc.staff_id] = [];
        schedMap[sc.staff_id].push(sc);
      });
    } catch (e) { /* */ }

    const enriched = staff.map(s => {
      const perf = perfMap[s.id] || {};
      const rev = reviewMap[s.id] || {};
      return {
        ...s,
        specializations: specMap[s.id] || [],
        schedule: schedMap[s.id] || [],
        total_appointments: perf.total_appointments || 0,
        appointments_this_month: perf.appointments_this_month || 0,
        total_revenue: parseFloat(perf.total_revenue || 0),
        avg_rating: rev.avg_rating ? parseFloat(rev.avg_rating).toFixed(1) : null,
        review_count: rev.review_count || 0,
        has_pending_invite: !!(s.invite_token && !s.password_set),
      };
    });

    res.json({ success: true, data: enriched });
  } catch (error) {
    console.error('Get staff error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch staff' });
  }
});

// ═══════════════════════════════════════════════════════
// ─── Get single staff detail ───────────────────────────
// ═══════════════════════════════════════════════════════
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    await ensureSchema();
    const { id } = req.params;
    const tenantId = req.tenantId;

    const [member] = await query(
      `SELECT s.*, b.name as branch_name
       FROM staff s
       LEFT JOIN branches b ON s.branch_id = b.id
       WHERE s.id = ? AND (s.tenant_id = ? OR s.tenant_id IS NULL)`,
      [id, tenantId]
    );

    if (!member) {
      return res.status(404).json({ success: false, message: 'Staff not found' });
    }

    // Get specializations
    let specs = [];
    try {
      specs = await query(
        `SELECT ss.*, p.name as service_name FROM staff_specializations ss
         LEFT JOIN products p ON ss.service_id = p.id
         WHERE ss.staff_id = ? AND ss.tenant_id = ?`,
        [id, tenantId]
      );
    } catch (e) { /* */ }

    // Get recent appointments
    let recentAppts = [];
    try {
      recentAppts = await query(
        `SELECT a.id, a.start_time, a.status, p.name as service_name, c.first_name, c.last_name
         FROM appointments a
         LEFT JOIN products p ON a.service_id = p.id
         LEFT JOIN contacts c ON a.customer_id = c.id
         WHERE a.staff_id = ? AND a.tenant_id = ?
         ORDER BY a.start_time DESC LIMIT 10`,
        [id, tenantId]
      );
    } catch (e) { /* */ }

    // Performance stats
    let perf = { total_appointments: 0, completed: 0, cancelled: 0, no_shows: 0, total_revenue: 0 };
    try {
      const [p] = await query(
        `SELECT 
          COUNT(*) as total_appointments,
          SUM(status = 'completed') as completed,
          SUM(status = 'cancelled') as cancelled,
          SUM(status = 'no_show') as no_shows,
          COALESCE(SUM(COALESCE(final_price, original_price, 0)), 0) as total_revenue
         FROM appointments WHERE staff_id = ? AND tenant_id = ?`,
        [id, tenantId]
      );
      if (p) perf = { ...perf, ...p, total_revenue: parseFloat(p.total_revenue || 0) };
    } catch (e) { /* */ }

    // Schedule
    let schedule = [];
    try {
      schedule = await query(
        'SELECT * FROM staff_schedule WHERE staff_id = ? AND tenant_id = ? ORDER BY day_of_week',
        [id, tenantId]
      );
    } catch (e) { /* */ }

    // Reviews (optional)
    let reviewStats = { avg_rating: null, total_reviews: 0 };
    try {
      const [rev] = await query(
        `SELECT AVG(rating) as avg_rating, COUNT(*) as total_reviews
         FROM reviews WHERE staff_id = ? AND tenant_id = ?`,
        [id, tenantId]
      );
      if (rev) {
        reviewStats = {
          avg_rating: rev.avg_rating ? parseFloat(rev.avg_rating).toFixed(1) : null,
          total_reviews: rev.total_reviews || 0,
        };
      }
    } catch (e) { /* */ }

    // Remove sensitive data
    delete member.password;
    delete member.invite_token;

    res.json({
      success: true,
      data: {
        ...member,
        specializations: specs,
        recent_appointments: recentAppts,
        performance: perf,
        schedule,
        review_stats: reviewStats,
        has_pending_invite: !!(member.invite_token_expires && !member.password_set),
      }
    });
  } catch (error) {
    console.error('Get staff detail error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch staff details', debug: error.message });
  }
});

// ═══════════════════════════════════════════════════════
// ─── Create staff (admin only) ─────────────────────────
//     No password required — send invite email instead
// ═══════════════════════════════════════════════════════
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    await ensureSchema();
    const {
      username, email, password, full_name, phone, role, branch_id,
      avatar_url, job_title, bio, hire_date, commission_rate,
      color, can_book_online, notes, emergency_contact, salary, employment_type,
      nationality, national_id, date_of_birth, gender, salary_currency, address,
      send_invite
    } = req.body;
    const tenantId = req.tenantId;

    if (!full_name?.trim()) {
      return res.status(400).json({ success: false, message: 'Full name is required' });
    }

    // Validate email format if provided
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    // Validate phone format if provided (basic check)
    if (phone && phone.length < 7) {
      return res.status(400).json({ success: false, message: 'Phone number must be at least 7 digits' });
    }

    // Auto-generate username if not provided
    const finalUsername = username?.trim() || 
      (email ? email.split('@')[0] : full_name.trim().toLowerCase().replace(/\s+/g, '.')) +
      '_' + Math.floor(Math.random() * 999);

    let hashedPassword = null;
    let passwordIsSet = 0;
    let inviteToken = null;
    let inviteExpires = null;

    if (password?.trim()) {
      // Direct password provided
      hashedPassword = await bcrypt.hash(password.trim(), 10);
      passwordIsSet = 1;
    } else {
      // No password — generate a random one (locked) and create invite token
      hashedPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      inviteToken = crypto.randomBytes(48).toString('hex');
      inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
      passwordIsSet = 0;
    }

    const result = await execute(
      `INSERT INTO staff (
        tenant_id, username, email, password, full_name, phone, role, branch_id,
        avatar_url, job_title, bio, hire_date, commission_rate, color, can_book_online,
        notes, emergency_contact, salary, employment_type, salary_currency,
        nationality, national_id, date_of_birth, gender,
        invite_token, invite_token_expires, password_set, address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId || null,
        finalUsername,
        email || null,
        hashedPassword,
        full_name.trim(),
        phone || null,
        role || 'staff',
        branch_id || null,
        avatar_url || null,
        job_title || null,
        bio || null,
        hire_date || null,
        commission_rate || 0,
        color || '#667eea',
        can_book_online !== false ? 1 : 0,
        notes || null,
        emergency_contact || null,
        salary || null,
        employment_type || 'full_time',
        salary_currency || null,
        nationality || null,
        national_id || null,
        date_of_birth || null,
        gender || null,
        inviteToken,
        inviteExpires,
        passwordIsSet,
        address || null,
      ]
    );

    // Send invite email if requested and email is provided
    let emailSent = false;
    let emailError = null;
    if ((send_invite !== false) && email && inviteToken) {
      const emailResult = await sendInviteEmail({ email, full_name, role }, inviteToken, tenantId);
      emailSent = emailResult === true;
      if (!emailSent && emailResult !== 'dev') {
        emailError = 'SMTP authentication failed. Please enable "Authenticated SMTP" in Microsoft 365 Admin Center for noreply@trasealla.com';
      }
    }

    // Always log invite URL to console for admin reference
    if (inviteToken) {
      const inviteUrl = `${config.frontendUrl}/set-password?token=${inviteToken}`;
      console.log(`\n📧 Staff Invite Created:`);
      console.log(`   Name: ${full_name}`);
      console.log(`   Email: ${email || 'N/A'}`);
      console.log(`   Link: ${inviteUrl}`);
      console.log(`   Email Sent: ${emailSent ? '✅' : '❌ ' + (emailError || 'No SMTP configured')}\n`);
    }

    // Push notification
    notifyStaff(req.tenantId, `New Team Member — ${full_name}`, `${role || 'Staff'} · ${email}`, { staff_id: result.insertId, email }).catch(() => {});

    res.json({
      success: true,
      message: inviteToken
        ? (emailSent 
            ? 'Team member added & invite email sent!' 
            : `Team member added. ${emailError ? 'Email failed: ' + emailError : 'Invite link generated (check server logs).'}`)
        : 'Team member added with password set.',
      data: {
        id: result.insertId,
        invite_sent: emailSent,
        has_pending_invite: !!inviteToken,
        ...(emailError && { email_error: emailError }),
        // Include invite URL in dev mode so admin can copy it
        ...(inviteToken && !emailSent && { invite_url: `${config.frontendUrl}/set-password?token=${inviteToken}` }),
      }
    });
  } catch (error) {
    console.error('Create staff error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: 'Username or email already exists' });
    }
    res.status(500).json({ success: false, message: 'Failed to create staff', debug: error.message });
  }
});

// ═══════════════════════════════════════════════════════
// ─── Set password via invite token (public) ────────────
// ═══════════════════════════════════════════════════════
router.post('/set-password', async (req, res) => {
  try {
    await ensureSchema();
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ success: false, message: 'Token and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const [staff] = await query(
      'SELECT id, full_name, invite_token_expires FROM staff WHERE invite_token = ?',
      [token]
    );

    if (!staff) {
      return res.status(400).json({ success: false, message: 'Invalid or expired invite link' });
    }

    if (staff.invite_token_expires && new Date(staff.invite_token_expires) < new Date()) {
      return res.status(400).json({ success: false, message: 'Invite link has expired. Please ask your admin to resend.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await execute(
      'UPDATE staff SET password = ?, password_set = 1, invite_token = NULL, invite_token_expires = NULL WHERE id = ?',
      [hashedPassword, staff.id]
    );

    res.json({ success: true, message: 'Password set successfully! You can now log in.' });
  } catch (error) {
    console.error('Set password error:', error);
    res.status(500).json({ success: false, message: 'Failed to set password' });
  }
});

// ═══════════════════════════════════════════════════════
// ─── Resend invite email ──────────────────────────────
// ═══════════════════════════════════════════════════════
router.post('/:id/resend-invite', authMiddleware, adminOnly, async (req, res) => {
  try {
    await ensureSchema();
    const { id } = req.params;
    const tenantId = req.tenantId;

    const [member] = await query(
      'SELECT id, email, full_name, role, password_set FROM staff WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (!member) {
      return res.status(404).json({ success: false, message: 'Staff not found' });
    }

    if (member.password_set) {
      return res.status(400).json({ success: false, message: 'This member has already set their password' });
    }

    if (!member.email) {
      return res.status(400).json({ success: false, message: 'No email address for this member. Add an email first.' });
    }

    // Generate new token
    const newToken = crypto.randomBytes(48).toString('hex');
    const newExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await execute(
      'UPDATE staff SET invite_token = ?, invite_token_expires = ? WHERE id = ?',
      [newToken, newExpires, id]
    );

    const emailResult = await sendInviteEmail(member, newToken, tenantId);
    const sent = emailResult === true;

    // Log invite URL
    const inviteUrl = `${config.frontendUrl}/set-password?token=${newToken}`;
    console.log(`\n📧 Resend Invite: ${member.full_name} → ${member.email}`);
    console.log(`   Link: ${inviteUrl}`);
    console.log(`   Sent: ${sent ? '✅' : '❌'}\n`);

    res.json({
      success: true,
      message: sent
        ? 'Invite email resent successfully!'
        : 'New invite link generated. Email delivery failed — please enable SMTP AUTH in Microsoft 365.',
      data: {
        email_sent: sent,
        ...(!sent && { invite_url: inviteUrl }),
      }
    });
  } catch (error) {
    console.error('Resend invite error:', error);
    res.status(500).json({ success: false, message: 'Failed to resend invite' });
  }
});

// ═══════════════════════════════════════════════════════
// ─── Update staff ──────────────────────────────────────
// ═══════════════════════════════════════════════════════
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    await ensureSchema();
    const { id } = req.params;
    const body = req.body;

    // Only admin can change role or active status
    if ((body.role || body.is_active !== undefined) && 
        req.user.role !== 'admin' && req.user.role !== 'super_admin' && req.user.role !== 'manager') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    // Validate email if provided
    if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      return res.status(400).json({ success: false, message: 'Invalid email format' });
    }

    // Validate phone if provided
    if (body.phone && body.phone.length < 7) {
      return res.status(400).json({ success: false, message: 'Phone number must be at least 7 digits' });
    }

    const updatable = [
      'full_name', 'email', 'phone', 'role', 'is_active', 'branch_id',
      'avatar_url', 'job_title', 'bio', 'hire_date', 'commission_rate',
      'color', 'can_book_online', 'notes', 'emergency_contact',
      'salary', 'employment_type', 'salary_currency', 'tenant_id',
      'nationality', 'national_id', 'date_of_birth', 'gender', 'address',
    ];

    const updates = [];
    const params = [];

    for (const field of updatable) {
      if (body[field] !== undefined) {
        updates.push(`${field} = ?`);
        const val = body[field];
        // Boolean fields
        if (field === 'is_active' || field === 'can_book_online') {
          params.push(val ? 1 : 0);
        } else {
          params.push(val || null);
        }
      }
    }

    if (body.password?.trim()) {
      const hashedPassword = await bcrypt.hash(body.password.trim(), 10);
      updates.push('password = ?');
      params.push(hashedPassword);
      updates.push('password_set = 1');
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No updates provided' });
    }

    params.push(id);
    await execute(`UPDATE staff SET ${updates.join(', ')} WHERE id = ?`, params);

    res.json({ success: true, message: 'Team member updated' });
  } catch (error) {
    console.error('Update staff error:', error);
    res.status(500).json({ success: false, message: 'Failed to update staff' });
  }
});

// ═══════════════════════════════════════════════════════
// ─── Toggle active status ──────────────────────────────
// ═══════════════════════════════════════════════════════
router.patch('/:id/toggle-active', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ success: false, message: 'Cannot deactivate yourself' });
    }
    const [current] = await query('SELECT is_active FROM staff WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ success: false, message: 'Staff not found' });

    const newStatus = current.is_active ? 0 : 1;
    await execute('UPDATE staff SET is_active = ? WHERE id = ?', [newStatus, id]);
    res.json({ success: true, message: newStatus ? 'Team member activated' : 'Team member deactivated' });
  } catch (error) {
    console.error('Toggle active error:', error);
    res.status(500).json({ success: false, message: 'Failed to toggle status' });
  }
});

// ═══════════════════════════════════════════════════════
// ─── Delete staff (admin only) ─────────────────────────
// ═══════════════════════════════════════════════════════
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ success: false, message: 'Cannot delete yourself' });
    }

    const [apptCount] = await query('SELECT COUNT(*) as count FROM appointments WHERE staff_id = ?', [id]);
    if (apptCount?.count > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete - this team member has ${apptCount.count} appointments. Deactivate instead.`
      });
    }

    await execute('DELETE FROM staff WHERE id = ?', [id]);
    res.json({ success: true, message: 'Team member deleted' });
  } catch (error) {
    console.error('Delete staff error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete staff' });
  }
});

export default router;
