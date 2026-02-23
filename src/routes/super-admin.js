import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { query, execute } from '../lib/database.js';
import { config } from '../config.js';
import { sendNotificationEmail, sendEmail } from '../lib/email.js';

// Stripe client — lazy init so missing key doesn't crash startup
const getStripe = () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.startsWith('sk_test_placeholder')) throw new Error('STRIPE_SECRET_KEY not configured');
  return new Stripe(key, { apiVersion: '2024-06-20' });
};

// ─── Hardcoded fallback plans (used only if billing_plans table is empty) ───
const FALLBACK_PLANS = {
  starter:      { label: 'Starter',      price: 199,  currency: 'aed', max_users: 10,  features: ['Up to 10 staff', 'All core modules', 'Email support'] },
  professional: { label: 'Professional', price: 399,  currency: 'aed', max_users: 25,  features: ['Up to 25 staff', 'All modules + AI', 'Priority support', 'Custom branding'] },
  enterprise:   { label: 'Enterprise',   price: 799,  currency: 'aed', max_users: 100, features: ['Unlimited staff', 'All modules + dedicated AI', '24/7 SLA support', 'White-label', 'API access'] },
};

// ─── Load plans from DB (with fallback) ───
const getPlans = async () => {
  try {
    const rows = await query('SELECT * FROM billing_plans WHERE is_active = 1 ORDER BY sort_order ASC');
    if (rows.length === 0) return FALLBACK_PLANS;
    const plans = {};
    for (const r of rows) {
      let features = r.features;
      if (typeof features === 'string') try { features = JSON.parse(features); } catch { features = []; }
      plans[r.plan_key] = {
        id: r.id,
        label: r.label,
        price: Number(r.price),
        currency: r.currency || 'aed',
        max_users: r.max_users,
        features: Array.isArray(features) ? features : [],
        stripe_price_id: r.stripe_price_id,
        color: r.color,
        description: r.description,
      };
    }
    return plans;
  } catch (e) {
    return FALLBACK_PLANS;
  }
};

const router = express.Router();

// Middleware to verify super admin token
const verifySuperAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    const decoded = jwt.verify(token, config.jwt.secret);
    if (decoded.type !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied. Super admin only.' });
    }

    const admins = await query(
      'SELECT id, username, email, full_name, role, permissions FROM super_admins WHERE id = ? AND is_active = 1',
      [decoded.id]
    );

    if (!admins || admins.length === 0) {
      return res.status(401).json({ error: 'Super admin not found or inactive.' });
    }

    req.superAdmin = admins[0];
    next();
  } catch (error) {
    console.error('Super admin auth error:', error);
    res.status(401).json({ error: 'Invalid token.' });
  }
};

// Super Admin Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const admins = await query(
      'SELECT * FROM super_admins WHERE (username = ? OR email = ?) AND is_active = 1',
      [username, username]
    );

    if (!admins || admins.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const admin = admins[0];
    const validPassword = await bcrypt.compare(password, admin.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    await execute('UPDATE super_admins SET last_login = NOW() WHERE id = ?', [admin.id]);

    const token = jwt.sign(
      { id: admin.id, username: admin.username, type: 'super_admin', role: admin.role },
      config.jwt.secret,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: admin.id,
        username: admin.username,
        email: admin.email,
        full_name: admin.full_name,
        role: admin.role,
        type: 'super_admin'
      }
    });
  } catch (error) {
    console.error('Super admin login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get current super admin session
router.get('/session', verifySuperAdmin, (req, res) => {
  res.json({ user: { ...req.superAdmin, type: 'super_admin' } });
});

// Get platform statistics
router.get('/stats', verifySuperAdmin, async (req, res) => {
  try {
    const tenantStats = await query(`
      SELECT 
        COUNT(*) as total_tenants,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_tenants,
        SUM(CASE WHEN status = 'trial' THEN 1 ELSE 0 END) as trial_tenants,
        SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) as suspended_tenants,
        SUM(COALESCE(monthly_price, 0)) as monthly_recurring_revenue
      FROM tenants
      WHERE status = 'active' OR status = 'trial'
    `);

    const allTenantsCount = await query(`SELECT COUNT(*) as total FROM tenants`);

    const userStats = await query(`
      SELECT COUNT(*) as total_users FROM staff WHERE is_active = 1
    `);

    // Total platform revenue from all paid invoices across all tenants
    const revenueStats = await query(`
      SELECT 
        COALESCE(SUM(total), 0) as total_platform_revenue,
        COALESCE(SUM(CASE WHEN MONTH(created_at) = MONTH(NOW()) AND YEAR(created_at) = YEAR(NOW()) THEN total ELSE 0 END), 0) as this_month_revenue,
        COUNT(*) as total_invoices
      FROM invoices WHERE status = 'paid'
    `);

    const recentTenants = await query(`
      SELECT id, name, email, industry, status, plan, created_at 
      FROM tenants 
      ORDER BY created_at DESC 
      LIMIT 5
    `);

    res.json({
      stats: {
        ...(tenantStats[0] || {}),
        total_tenants: allTenantsCount[0]?.total || 0,
        total_users: userStats[0]?.total_users || 0,
        total_platform_revenue: revenueStats[0]?.total_platform_revenue || 0,
        this_month_revenue: revenueStats[0]?.this_month_revenue || 0,
        total_invoices: revenueStats[0]?.total_invoices || 0
      },
      recentTenants: recentTenants || []
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get all tenants
router.get('/tenants', verifySuperAdmin, async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let sql = `
      SELECT t.*, 
        (SELECT COUNT(*) FROM staff WHERE tenant_id = t.id) as user_count
      FROM tenants t
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      sql += ' AND t.status = ?';
      params.push(status);
    }

    if (search) {
      sql += ' AND (t.name LIKE ? OR t.email LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    sql += ` ORDER BY t.created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;

    const tenants = await query(sql, params);
    const countResult = await query('SELECT COUNT(*) as total FROM tenants');

    res.json({
      tenants: tenants || [],
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult[0]?.total || 0
      }
    });
  } catch (error) {
    console.error('Get tenants error:', error);
    res.status(500).json({ error: 'Failed to fetch tenants' });
  }
});

// Get single tenant
router.get('/tenants/:id', verifySuperAdmin, async (req, res) => {
  try {
    const tenants = await query(
      `SELECT t.*, 
        (SELECT COUNT(*) FROM staff WHERE tenant_id = t.id) as user_count,
        (SELECT COUNT(*) FROM staff WHERE tenant_id = t.id AND is_active = 1) as active_users
      FROM tenants t WHERE t.id = ?`,
      [req.params.id]
    );

    if (!tenants || tenants.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const users = await query(
      'SELECT id, username, email, full_name, role, is_active, last_login, created_at FROM staff WHERE tenant_id = ?',
      [req.params.id]
    );

    res.json({
      tenant: tenants[0],
      users: users || []
    });
  } catch (error) {
    console.error('Get tenant error:', error);
    res.status(500).json({ error: 'Failed to fetch tenant' });
  }
});

// Update tenant
router.put('/tenants/:id', verifySuperAdmin, async (req, res) => {
  try {
    const { name, status, max_users, allowed_modules, is_active, settings } = req.body;

    await execute(
      `UPDATE tenants SET 
        name = COALESCE(?, name),
        status = COALESCE(?, status),
        max_users = COALESCE(?, max_users),
        allowed_modules = COALESCE(?, allowed_modules),
        is_active = COALESCE(?, is_active),
        settings = COALESCE(?, settings)
      WHERE id = ?`,
      [
        name,
        status,
        max_users,
        allowed_modules ? JSON.stringify(allowed_modules) : null,
        is_active,
        settings ? JSON.stringify(settings) : null,
        req.params.id
      ]
    );

    const updated = await query('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (error) {
    console.error('Update tenant error:', error);
    res.status(500).json({ error: 'Failed to update tenant' });
  }
});

// Activate/Deactivate tenant
router.post('/tenants/:id/toggle-status', verifySuperAdmin, async (req, res) => {
  try {
    const { status } = req.body;

    await execute('UPDATE tenants SET status = ? WHERE id = ?', [status, req.params.id]);

    // If suspending, also deactivate all users
    if (status === 'suspended') {
      await execute('UPDATE staff SET is_active = 0 WHERE tenant_id = ?', [req.params.id]);
    }

    res.json({ success: true, message: `Tenant ${status === 'active' ? 'activated' : 'suspended'}` });
  } catch (error) {
    console.error('Toggle tenant status error:', error);
    res.status(500).json({ error: 'Failed to update tenant status' });
  }
});

// Set max users for tenant
router.post('/tenants/:id/max-users', verifySuperAdmin, async (req, res) => {
  try {
    const { max_users } = req.body;

    await execute('UPDATE tenants SET max_users = ? WHERE id = ?', [max_users, req.params.id]);

    res.json({ success: true, message: `Max users set to ${max_users}` });
  } catch (error) {
    console.error('Set max users error:', error);
    res.status(500).json({ error: 'Failed to set max users' });
  }
});

// Set allowed modules for tenant
router.post('/tenants/:id/modules', verifySuperAdmin, async (req, res) => {
  try {
    const { modules } = req.body;

    await execute(
      'UPDATE tenants SET allowed_modules = ? WHERE id = ?',
      [JSON.stringify(modules), req.params.id]
    );

    res.json({ success: true, message: 'Modules updated' });
  } catch (error) {
    console.error('Set modules error:', error);
    res.status(500).json({ error: 'Failed to set modules' });
  }
});

// Get available modules list
router.get('/modules', verifySuperAdmin, (req, res) => {
  const modules = [
    { id: 'accounts', name: 'Accounts', nameAr: 'الحسابات', category: 'CRM' },
    { id: 'contacts', name: 'Contacts', nameAr: 'جهات الاتصال', category: 'CRM' },
    { id: 'leads', name: 'Leads', nameAr: 'العملاء المحتملين', category: 'CRM' },
    { id: 'deals', name: 'Deals', nameAr: 'الصفقات', category: 'CRM' },
    { id: 'pipelines', name: 'Pipelines', nameAr: 'خطوط الأنابيب', category: 'CRM' },
    { id: 'activities', name: 'Activities', nameAr: 'الأنشطة', category: 'CRM' },
    { id: 'calendar', name: 'Calendar', nameAr: 'التقويم', category: 'CRM' },
    { id: 'notes', name: 'Notes', nameAr: 'الملاحظات', category: 'CRM' },
    { id: 'tags', name: 'Tags', nameAr: 'العلامات', category: 'CRM' },
    { id: 'products', name: 'Products', nameAr: 'المنتجات', category: 'Sales' },
    { id: 'quotes', name: 'Quotes', nameAr: 'عروض الأسعار', category: 'Sales' },
    { id: 'documents', name: 'Documents', nameAr: 'المستندات', category: 'Sales' },
    { id: 'campaigns', name: 'Campaigns', nameAr: 'الحملات', category: 'Marketing' },
    { id: 'audiences', name: 'Audiences', nameAr: 'الجماهير', category: 'Marketing' },
    { id: 'email_templates', name: 'Email Templates', nameAr: 'قوالب البريد', category: 'Marketing' },
    { id: 'integrations', name: 'Integrations', nameAr: 'التكاملات', category: 'Marketing' },
    { id: 'inbox', name: 'Inbox', nameAr: 'صندوق الوارد', category: 'Communication' },
    { id: 'branches', name: 'Branches', nameAr: 'الفروع', category: 'Settings' },
    { id: 'custom_fields', name: 'Custom Fields', nameAr: 'الحقول المخصصة', category: 'Settings' },
    { id: 'workflows', name: 'Workflows', nameAr: 'سير العمل', category: 'Settings' },
    { id: 'reports', name: 'Reports', nameAr: 'التقارير', category: 'Analytics' },
    { id: 'audit_logs', name: 'Audit Logs', nameAr: 'سجلات التدقيق', category: 'Settings' }
  ];

  res.json(modules);
});

// GET /super-admin/users — all staff users across all tenants
router.get('/users', verifySuperAdmin, async (req, res) => {
  try {
    const { tenant_id, role, search } = req.query;
    let sql = `
      SELECT
        s.id, s.username, s.email, s.full_name, s.role,
        s.is_active, s.last_login, s.created_at, s.phone,
        t.id AS tenant_id, t.name AS tenant_name, t.plan AS tenant_plan
      FROM staff s
      INNER JOIN tenants t ON t.id = s.tenant_id
      WHERE 1=1
    `;
    const params = [];
    if (tenant_id) { sql += ' AND s.tenant_id = ?'; params.push(tenant_id); }
    if (role)      { sql += ' AND s.role = ?';      params.push(role); }
    if (search)    { sql += ' AND (s.full_name LIKE ? OR s.email LIKE ? OR s.username LIKE ?)';
                     const like = `%${search}%`; params.push(like, like, like); }
    sql += ' ORDER BY s.created_at DESC';

    const users = await query(sql, params);

    // summary stats
    const allUsers = await query(`
      SELECT
        COUNT(*)                                      AS total_users,
        SUM(s.is_active = 1)                          AS active_users,
        SUM(s.role = 'admin')                         AS admins,
        COUNT(DISTINCT s.tenant_id)                   AS tenant_count
      FROM staff s
    `);

    res.json({ users: users || [], stats: allUsers[0] || {} });
  } catch (err) {
    console.error('GET /users error:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// POST /super-admin/users/:userId/toggle — toggle is_active
router.post('/users/:userId/toggle', verifySuperAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const rows = await query('SELECT id, is_active FROM staff WHERE id = ?', [userId]);
    if (!rows || !rows.length) return res.status(404).json({ error: 'User not found' });
    const newVal = rows[0].is_active ? 0 : 1;
    await execute('UPDATE staff SET is_active = ? WHERE id = ?', [newVal, userId]);
    res.json({ success: true, is_active: !!newVal });
  } catch (err) {
    console.error('Toggle user error:', err);
    res.status(500).json({ error: 'Failed to toggle user' });
  }
});

// Get tenant usage stats
router.get('/tenants/:id/usage', verifySuperAdmin, async (req, res) => {
  try {
    const tenantId = req.params.id;

    const stats = await query(`
      SELECT 
        (SELECT COUNT(*) FROM accounts WHERE tenant_id = ?) as accounts,
        (SELECT COUNT(*) FROM contacts WHERE tenant_id = ?) as contacts,
        (SELECT COUNT(*) FROM leads WHERE tenant_id = ?) as leads,
        (SELECT COUNT(*) FROM deals WHERE tenant_id = ?) as deals,
        (SELECT COUNT(*) FROM activities WHERE tenant_id = ?) as activities,
        (SELECT COUNT(*) FROM staff WHERE tenant_id = ?) as users
    `, [tenantId, tenantId, tenantId, tenantId, tenantId, tenantId]);

    res.json(stats[0] || {});
  } catch (error) {
    console.error('Get usage error:', error);
    res.status(500).json({ error: 'Failed to fetch usage stats' });
  }
});

// Login as tenant admin (impersonation)
router.post('/tenants/:id/impersonate', verifySuperAdmin, async (req, res) => {
  try {
    const admins = await query(
      "SELECT * FROM staff WHERE tenant_id = ? AND role = 'admin' AND is_active = 1 LIMIT 1",
      [req.params.id]
    );

    if (!admins || admins.length === 0) {
      return res.status(404).json({ error: 'No active admin found for this tenant' });
    }

    const admin = admins[0];

    const token = jwt.sign(
      { 
        id: admin.id, 
        username: admin.username, 
        tenant_id: admin.tenant_id,
        role: admin.role,
        impersonated_by: req.superAdmin.id
      },
      config.jwt.secret,
      { expiresIn: '2h' }
    );

    res.json({
      token,
      user: {
        id: admin.id,
        username: admin.username,
        email: admin.email,
        full_name: admin.full_name,
        role: admin.role,
        tenant_id: admin.tenant_id
      }
    });
  } catch (error) {
    console.error('Impersonate error:', error);
    res.status(500).json({ error: 'Failed to impersonate' });
  }
});

// ─────────────────────────────────────────────────────────────
// PLATFORM ACTIVITY FEED  (last N events across all tenants)
// ─────────────────────────────────────────────────────────────
router.get('/platform-activity', verifySuperAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    // Pull recent events from 5 high-signal tables and UNION them
    // All text expressions are CONVERT'd to utf8mb4 to prevent collation mismatch errors
    const events = await query(`
      SELECT CONVERT('appointment' USING utf8mb4) COLLATE utf8mb4_general_ci AS type,
        a.id,
        CONVERT(a.status USING utf8mb4) COLLATE utf8mb4_general_ci AS status,
        a.created_at AS event_time,
        CONVERT(CONCAT('New appointment: ', COALESCE(p.name,'Service'), ' for ', COALESCE(CONCAT(c.first_name,' ',c.last_name),'Unknown')) USING utf8mb4) COLLATE utf8mb4_general_ci AS description,
        CONVERT(t.name USING utf8mb4) COLLATE utf8mb4_general_ci AS tenant_name, t.id AS tenant_id
      FROM appointments a
      JOIN tenants t ON a.tenant_id = t.id
      LEFT JOIN service_categories p ON a.service_id = p.id
      LEFT JOIN customers c ON a.customer_id = c.id
      WHERE a.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)

      UNION ALL

      SELECT CONVERT('invoice' USING utf8mb4) COLLATE utf8mb4_general_ci AS type,
        i.id,
        CONVERT(i.status USING utf8mb4) COLLATE utf8mb4_general_ci AS status,
        i.created_at AS event_time,
        CONVERT(CONCAT('Invoice ', i.invoice_number, ' - AED ', FORMAT(i.total,2)) USING utf8mb4) COLLATE utf8mb4_general_ci AS description,
        CONVERT(t.name USING utf8mb4) COLLATE utf8mb4_general_ci AS tenant_name, t.id AS tenant_id
      FROM invoices i JOIN tenants t ON i.tenant_id = t.id
      WHERE i.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)

      UNION ALL

      SELECT CONVERT('customer' USING utf8mb4) COLLATE utf8mb4_general_ci AS type,
        c.id,
        CONVERT('new' USING utf8mb4) COLLATE utf8mb4_general_ci AS status,
        c.created_at AS event_time,
        CONVERT(CONCAT('New customer: ', COALESCE(CONCAT(c.first_name,' ',c.last_name),'Unknown')) USING utf8mb4) COLLATE utf8mb4_general_ci AS description,
        CONVERT(t.name USING utf8mb4) COLLATE utf8mb4_general_ci AS tenant_name, t.id AS tenant_id
      FROM customers c JOIN tenants t ON c.tenant_id = t.id
      WHERE c.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)

      UNION ALL

      SELECT CONVERT('payment' USING utf8mb4) COLLATE utf8mb4_general_ci AS type,
        i.id,
        CONVERT(i.status USING utf8mb4) COLLATE utf8mb4_general_ci AS status,
        i.updated_at AS event_time,
        CONVERT(CONCAT('Payment received: AED ', FORMAT(i.amount_paid,2), ' for ', i.invoice_number) USING utf8mb4) COLLATE utf8mb4_general_ci AS description,
        CONVERT(t.name USING utf8mb4) COLLATE utf8mb4_general_ci AS tenant_name, t.id AS tenant_id
      FROM invoices i JOIN tenants t ON i.tenant_id = t.id
      WHERE i.status = 'paid' AND i.updated_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)

      UNION ALL

      SELECT CONVERT('review' USING utf8mb4) COLLATE utf8mb4_general_ci AS type,
        r.id,
        CONVERT(CAST(r.rating AS CHAR) USING utf8mb4) COLLATE utf8mb4_general_ci AS status,
        r.created_at AS event_time,
        CONVERT(CONCAT('Customer left a ', r.rating, '-star review') USING utf8mb4) COLLATE utf8mb4_general_ci AS description,
        CONVERT(t.name USING utf8mb4) COLLATE utf8mb4_general_ci AS tenant_name, t.id AS tenant_id
      FROM reviews r JOIN tenants t ON r.tenant_id = t.id
      WHERE r.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)

      ORDER BY event_time DESC
      LIMIT ${limit}
    `);

    res.json({ events: events || [] });
  } catch (error) {
    console.error('Platform activity error:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// ─────────────────────────────────────────────────────────────
// TENANT DETAIL  — comprehensive stats for one tenant
// ─────────────────────────────────────────────────────────────
router.get('/tenants/:id/details', verifySuperAdmin, async (req, res) => {
  try {
    const tenantId = req.params.id;

    const [tenant] = await query(
      `SELECT t.*,
         (SELECT COUNT(*) FROM staff WHERE tenant_id = t.id) AS user_count,
         (SELECT COUNT(*) FROM staff WHERE tenant_id = t.id AND is_active = 1) AS active_users
       FROM tenants t WHERE t.id = ?`,
      [tenantId]
    );
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const [kpi] = await query(`
      SELECT
        (SELECT COUNT(*) FROM contacts WHERE tenant_id = ?) AS total_customers,
        (SELECT COUNT(*) FROM contacts WHERE tenant_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS new_customers_month,
        (SELECT COUNT(*) FROM appointments WHERE tenant_id = ?) AS total_appointments,
        (SELECT COUNT(*) FROM appointments WHERE tenant_id = ? AND DATE(start_time) = CURDATE()) AS appointments_today,
        (SELECT COUNT(*) FROM appointments WHERE tenant_id = ? AND status = 'completed') AS completed_appointments,
        (SELECT COUNT(*) FROM invoices WHERE tenant_id = ? AND status = 'paid') AS paid_invoices,
        (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE tenant_id = ? AND status = 'paid') AS total_revenue,
        (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE tenant_id = ? AND status = 'paid' AND MONTH(created_at) = MONTH(NOW()) AND YEAR(created_at) = YEAR(NOW())) AS revenue_this_month,
        (SELECT COALESCE(AVG(rating), 0) FROM reviews WHERE tenant_id = ?) AS avg_rating,
        (SELECT COUNT(*) FROM reviews WHERE tenant_id = ?) AS total_reviews
    `, Array(10).fill(tenantId));

    const staff = await query(
      `SELECT id, username, email, full_name, role, is_active, last_login, created_at
       FROM staff WHERE tenant_id = ? ORDER BY created_at DESC`,
      [tenantId]
    );

    const recentAppointments = await query(`
      SELECT a.id, a.start_time, a.status,
             s.name AS service_name, COALESCE(CONCAT(c.first_name, ' ', COALESCE(c.last_name,'')),'Unknown') AS customer_name,
             st.full_name AS staff_name
      FROM appointments a
      LEFT JOIN products s ON a.service_id = s.id
      LEFT JOIN contacts c ON a.customer_id = c.id
      LEFT JOIN staff st ON a.staff_id = st.id
      WHERE a.tenant_id = ?
      ORDER BY a.created_at DESC LIMIT 10
    `, [tenantId]);

    const topServices = await query(`
      SELECT s.name, COUNT(*) AS booking_count,
             COALESCE(SUM(inv.total), 0) AS revenue
      FROM appointments a
      JOIN products s ON a.service_id = s.id
      LEFT JOIN invoices inv ON inv.appointment_id = a.id AND inv.status = 'paid'
      WHERE a.tenant_id = ?
      GROUP BY s.id, s.name
      ORDER BY booking_count DESC LIMIT 5
    `, [tenantId]);

    const monthlyRevenue = await query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
             SUM(total) AS revenue, COUNT(*) AS invoices
      FROM invoices
      WHERE tenant_id = ? AND status = 'paid'
        AND created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m')
      ORDER BY month ASC
    `, [tenantId]);

    // Compute health score (0-100)
    const kd = kpi;
    let health = 0;
    if (kd.appointments_today > 0) health += 20;
    if (kd.total_customers > 5) health += 20;
    if (kd.paid_invoices > 0) health += 20;
    if (kd.avg_rating >= 4) health += 20;
    if (kd.new_customers_month > 0) health += 20;

    res.json({
      tenant,
      kpi: kd,
      staff,
      recentAppointments,
      topServices,
      monthlyRevenue,
      healthScore: health,
    });
  } catch (error) {
    console.error('Tenant details error:', error);
    res.status(500).json({ error: 'Failed to fetch tenant details' });
  }
});

// Update tenant plan
router.put('/tenants/:id/plan', verifySuperAdmin, async (req, res) => {
  try {
    const { plan, monthly_price, max_users, subscription_ends_at } = req.body;
    if (!plan) return res.status(400).json({ error: 'plan is required' });

    await execute(
      `UPDATE tenants SET plan = ?, monthly_price = COALESCE(?, monthly_price),
        max_users = COALESCE(?, max_users),
        subscription_ends_at = COALESCE(?, subscription_ends_at),
        updated_at = NOW()
       WHERE id = ?`,
      [plan, monthly_price, max_users, subscription_ends_at, req.params.id]
    );

    const [updated] = await query('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    res.json({ success: true, tenant: updated });
  } catch (error) {
    console.error('Update plan error:', error);
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

// ─────────────────────────────────────────────────────────────
// PLATFORM OVERVIEW  — real-time KPI aggregates for dashboard
// ─────────────────────────────────────────────────────────────
router.get('/platform-overview', verifySuperAdmin, async (req, res) => {
  try {
    const [overview] = await query(`
      SELECT
        (SELECT COUNT(*) FROM tenants WHERE status != 'deleted') AS total_tenants,
        (SELECT COUNT(*) FROM tenants WHERE status = 'active') AS active_tenants,
        (SELECT COUNT(*) FROM tenants WHERE status = 'trial') AS trial_tenants,
        (SELECT COUNT(*) FROM tenants WHERE status = 'suspended') AS suspended_tenants,
        (SELECT COUNT(*) FROM tenants WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS new_tenants_month,
        (SELECT COUNT(*) FROM staff WHERE is_active = 1) AS total_users,
        (SELECT COUNT(*) FROM contacts) AS total_customers,
        (SELECT COUNT(*) FROM appointments WHERE DATE(start_time) = CURDATE()) AS appointments_today,
        (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE status = 'paid') AS total_revenue,
        (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE status = 'paid' AND MONTH(created_at) = MONTH(NOW()) AND YEAR(created_at) = YEAR(NOW())) AS revenue_this_month,
        (SELECT COALESCE(SUM(total), 0) FROM invoices WHERE status = 'paid' AND MONTH(created_at) = MONTH(DATE_SUB(NOW(), INTERVAL 1 MONTH)) AND YEAR(created_at) = YEAR(DATE_SUB(NOW(), INTERVAL 1 MONTH))) AS revenue_last_month,
        (SELECT COALESCE(SUM(monthly_price), 0) FROM tenants WHERE status = 'active') AS mrr,
        (SELECT COUNT(*) FROM invoices WHERE status IN ('unpaid','sent') AND due_date < CURDATE()) AS overdue_invoices,
        (SELECT COALESCE(AVG(rating), 0) FROM reviews) AS platform_avg_rating
    `);

    // Monthly growth (12 months)
    const tenantGrowth = await query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS count
      FROM tenants WHERE created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m') ORDER BY month ASC
    `);

    const revenueGrowth = await query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, SUM(total) AS revenue
      FROM invoices WHERE status = 'paid' AND created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m') ORDER BY month ASC
    `);

    // Top tenants by revenue this month
    const topTenants = await query(`
      SELECT t.id, t.name, t.plan, t.status,
             COALESCE(SUM(i.total), 0) AS month_revenue,
             (SELECT COUNT(*) FROM contacts WHERE tenant_id = t.id) AS customers,
             (SELECT COUNT(*) FROM appointments WHERE tenant_id = t.id AND DATE(start_time) = CURDATE()) AS today_apts
      FROM tenants t
      LEFT JOIN invoices i ON i.tenant_id = t.id AND i.status = 'paid'
        AND MONTH(i.created_at) = MONTH(NOW()) AND YEAR(i.created_at) = YEAR(NOW())
      WHERE t.status != 'deleted'
      GROUP BY t.id, t.name, t.plan, t.status
      ORDER BY month_revenue DESC LIMIT 8
    `);

    res.json({
      overview: overview || {},
      tenantGrowth: tenantGrowth || [],
      revenueGrowth: revenueGrowth || [],
      topTenants: topTenants || [],
    });
  } catch (error) {
    console.error('Platform overview error:', error);
    res.status(500).json({ error: 'Failed to fetch overview' });
  }
});

// ─────────────────────────────────────────────────────────────
// STRIPE WEBHOOK — verified signature handler with idempotency
// ─────────────────────────────────────────────────────────────
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  try {
    if (secret && !secret.includes('placeholder')) {
      const stripe = getStripe();
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } else {
      // Dev fallback — accept raw body without signature check
      event = JSON.parse(req.body);
    }
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  // ── Idempotency check ──
  const eventId = event.id || `evt_${Date.now()}`;
  try {
    const [existing] = await query('SELECT id FROM stripe_webhook_logs WHERE stripe_event_id = ?', [eventId]);
    if (existing) {
      console.log(`[Stripe] Duplicate event skipped: ${eventId}`);
      return res.json({ received: true, duplicate: true });
    }
  } catch (e) { /* table may not exist yet */ }

  try {
    const obj = event.data?.object || {};
    let logTenantId = null;

    switch (event.type) {
      case 'checkout.session.completed': {
        const { tenant_id, plan } = obj.metadata || {};
        logTenantId = tenant_id;
        if (tenant_id) {
          const subId = obj.subscription;
          const custId = obj.customer;
          const PLANS = await getPlans();
          const planInfo = PLANS[plan];
          const nextBilling = new Date();
          nextBilling.setMonth(nextBilling.getMonth() + 1);
          await execute(
            `UPDATE tenants SET
               plan = ?, stripe_customer_id = ?, stripe_subscription_id = ?,
               stripe_price_id = ?, subscription_status = 'active',
               next_billing_date = ?, monthly_price = ?, status = 'active',
               max_users = ?, grace_period_ends_at = NULL, updated_at = NOW()
             WHERE id = ?`,
            [plan || 'starter', custId, subId, obj.payment_intent || '',
             nextBilling, planInfo?.price || 0, planInfo?.max_users || 10, tenant_id]
          );
          console.log(`[Stripe] Tenant ${tenant_id} upgraded to ${plan}`);
        } else {
          // New tenant self-sign-up flow
          const PLANS = await getPlans();
          const { tenant_name, tenant_email, new_plan = 'starter' } = obj.metadata || {};
          if (tenant_name && tenant_email) {
            const slug = tenant_name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const tempPwd = `Beauty${Math.floor(10000 + Math.random() * 90000)}!`;
            const hash = await bcrypt.hash(tempPwd, 12);
            const trialEnd = new Date(); trialEnd.setDate(trialEnd.getDate() + 30);
            const result = await execute(
              `INSERT IGNORE INTO tenants (name, slug, email, status, plan, max_users, billing_email, subscription_ends_at, stripe_customer_id, stripe_subscription_id, subscription_status, is_active, created_at)
               VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 'active', 1, NOW())`,
              [tenant_name, slug, tenant_email, new_plan, PLANS[new_plan]?.max_users || 10,
               tenant_email, trialEnd, obj.customer, obj.subscription]
            );
            logTenantId = result.insertId;
            if (result.insertId) {
              const adminUser = `${slug.replace(/-/g,'_')}_admin`;
              await execute(
                `INSERT INTO staff (tenant_id, username, email, password, full_name, role, is_active, created_at)
                 VALUES (?, ?, ?, ?, ?, 'admin', 1, NOW())`,
                [result.insertId, adminUser, tenant_email, hash, `${tenant_name} Admin`]
              );
              await sendNotificationEmail({
                to: tenant_email,
                subject: 'Welcome to Trasealla CRM — Payment Confirmed!',
                html: `<p>Your account has been activated. Login: <strong>${adminUser}</strong> / <strong>${tempPwd}</strong></p>`
              });
            }
          }
        }
        break;
      }
      case 'customer.subscription.updated': {
        const custId = obj.customer;
        // If subscription is now active, clear grace period and ensure account is active
        if (obj.status === 'active') {
          await execute(
            `UPDATE tenants SET subscription_status = 'active', status = 'active',
             next_billing_date = FROM_UNIXTIME(?), grace_period_ends_at = NULL, updated_at = NOW()
             WHERE stripe_customer_id = ?`,
            [obj.current_period_end, custId]
          );
        } else {
          await execute(
            `UPDATE tenants SET subscription_status = ?, next_billing_date = FROM_UNIXTIME(?), updated_at = NOW()
             WHERE stripe_customer_id = ?`,
            [obj.status, obj.current_period_end, custId]
          );
        }
        const [t] = await query('SELECT id FROM tenants WHERE stripe_customer_id = ?', [custId]);
        logTenantId = t?.id;
        break;
      }
      case 'customer.subscription.deleted': {
        await execute(
          `UPDATE tenants SET subscription_status = 'canceled', plan = 'trial', monthly_price = 0,
           stripe_subscription_id = NULL, status = 'suspended', updated_at = NOW()
           WHERE stripe_customer_id = ?`,
          [obj.customer]
        );
        const [t2] = await query('SELECT id FROM tenants WHERE stripe_customer_id = ?', [obj.customer]);
        logTenantId = t2?.id;
        break;
      }
      case 'invoice.paid': {
        // Payment succeeded — ensure account is active and clear grace period
        const custId = obj.customer;
        await execute(
          `UPDATE tenants SET subscription_status = 'active', status = 'active',
           grace_period_ends_at = NULL, updated_at = NOW()
           WHERE stripe_customer_id = ?`,
          [custId]
        );
        const [t3] = await query('SELECT id FROM tenants WHERE stripe_customer_id = ?', [custId]);
        logTenantId = t3?.id;
        console.log(`[Stripe] Invoice paid for customer ${custId}`);
        break;
      }
      case 'invoice.payment_failed': {
        // Set past_due with 3-day grace period
        const gracePeriod = new Date();
        gracePeriod.setDate(gracePeriod.getDate() + 3);
        await execute(
          `UPDATE tenants SET subscription_status = 'past_due',
           grace_period_ends_at = ?, updated_at = NOW()
           WHERE stripe_customer_id = ?`,
          [gracePeriod, obj.customer]
        );
        // Send notification email
        const rows = await query('SELECT id, email, name FROM tenants WHERE stripe_customer_id = ?', [obj.customer]);
        if (rows.length) {
          logTenantId = rows[0].id;
          await sendNotificationEmail({
            to: rows[0].email,
            subject: 'Important: Payment failed for your Trasealla CRM subscription',
            html: `
              <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
                <div style="background:linear-gradient(135deg,#dc2626,#991b1b);padding:28px;border-radius:12px 12px 0 0;text-align:center">
                  <h1 style="color:#fff;margin:0;font-size:20px">Payment Failed</h1>
                </div>
                <div style="padding:28px;background:#fff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 12px 12px">
                  <p>Dear <strong>${rows[0].name}</strong>,</p>
                  <p>We were unable to process your subscription payment. You have a <strong>3-day grace period</strong> to update your payment method before your account is suspended.</p>
                  <div style="text-align:center;margin:24px 0">
                    <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/billing"
                       style="display:inline-block;background:#dc2626;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700">
                      Update Payment Method
                    </a>
                  </div>
                </div>
              </div>
            `
          }).catch(() => {});
        }
        break;
      }
      case 'customer.subscription.trial_will_end': {
        // Trial ending in 3 days — Stripe sends this automatically
        const custId = obj.customer;
        const rows = await query('SELECT id, email, name FROM tenants WHERE stripe_customer_id = ?', [custId]);
        if (rows.length) {
          logTenantId = rows[0].id;
          await sendNotificationEmail({
            to: rows[0].email,
            subject: 'Your Trasealla CRM trial is ending soon',
            html: `<p>Hi ${rows[0].name}, your trial is ending in 3 days. Make sure your payment method is up to date.</p>`
          }).catch(() => {});
        }
        break;
      }
      default:
        console.log(`[Stripe] Unhandled event: ${event.type}`);
    }

    // ── Log webhook event ──
    try {
      await execute(
        `INSERT INTO stripe_webhook_logs (stripe_event_id, event_type, tenant_id, payload, status)
         VALUES (?, ?, ?, ?, 'processed')`,
        [eventId, event.type, logTenantId, JSON.stringify(obj)]
      );
    } catch (logErr) { /* skip if table doesn't exist */ }

    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook processing error:', err);
    // Log failed event
    try {
      await execute(
        `INSERT INTO stripe_webhook_logs (stripe_event_id, event_type, payload, status, error_message)
         VALUES (?, ?, ?, 'failed', ?)`,
        [eventId, event.type, JSON.stringify(event.data?.object || {}), err.message]
      );
    } catch (logErr) { /* skip */ }
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// BILLING — GET /billing/plans
// ─────────────────────────────────────────────────────────────
router.get('/billing/plans', verifySuperAdmin, async (req, res) => {
  try {
    const plans = await getPlans();
    res.json({ plans });
  } catch (error) {
    console.error('Get plans error:', error);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// ─────────────────────────────────────────────────────────────
// BILLING — GET /billing/plans-config  (raw DB rows for settings UI)
// ─────────────────────────────────────────────────────────────
router.get('/billing/plans-config', verifySuperAdmin, async (req, res) => {
  try {
    const rows = await query('SELECT * FROM billing_plans ORDER BY sort_order ASC');
    const parsed = rows.map(r => {
      let features = r.features;
      if (typeof features === 'string') try { features = JSON.parse(features); } catch { features = []; }
      return { ...r, features };
    });
    res.json({ plans: parsed });
  } catch (error) {
    console.error('Plans config error:', error);
    res.status(500).json({ error: 'Failed to fetch plans config' });
  }
});

// ─────────────────────────────────────────────────────────────
// BILLING — POST /billing/plans-config  (create new plan)
// ─────────────────────────────────────────────────────────────
router.post('/billing/plans-config', verifySuperAdmin, async (req, res) => {
  try {
    const { plan_key, label, price, currency = 'aed', max_users = 10, features = [], stripe_price_id, color = '#3b82f6', description = '', billing_cycle = 'monthly' } = req.body;
    if (!plan_key || !label) return res.status(400).json({ error: 'plan_key and label are required' });
    const [maxSort] = await query('SELECT COALESCE(MAX(sort_order),0)+1 AS next_sort FROM billing_plans');
    const result = await execute(
      `INSERT INTO billing_plans (plan_key, label, price, currency, billing_cycle, max_users, features, stripe_price_id, color, sort_order, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [plan_key, label, price || 0, currency, billing_cycle, max_users, JSON.stringify(features), stripe_price_id || null, color, maxSort.next_sort, description]
    );
    res.json({ success: true, id: result.insertId });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Plan key already exists' });
    console.error('Create plan error:', error);
    res.status(500).json({ error: 'Failed to create plan' });
  }
});

// ─────────────────────────────────────────────────────────────
// BILLING — PUT /billing/plans-config/:id  (update plan)
// ─────────────────────────────────────────────────────────────
router.put('/billing/plans-config/:id', verifySuperAdmin, async (req, res) => {
  try {
    const { label, price, currency, max_users, features, stripe_price_id, color, description, is_active, sort_order, billing_cycle } = req.body;
    const sets = [];
    const params = [];
    if (label !== undefined)           { sets.push('label = ?');           params.push(label); }
    if (price !== undefined)           { sets.push('price = ?');           params.push(price); }
    if (currency !== undefined)        { sets.push('currency = ?');        params.push(currency); }
    if (max_users !== undefined)       { sets.push('max_users = ?');       params.push(max_users); }
    if (features !== undefined)        { sets.push('features = ?');        params.push(JSON.stringify(features)); }
    if (stripe_price_id !== undefined) { sets.push('stripe_price_id = ?'); params.push(stripe_price_id); }
    if (color !== undefined)           { sets.push('color = ?');           params.push(color); }
    if (description !== undefined)     { sets.push('description = ?');     params.push(description); }
    if (is_active !== undefined)       { sets.push('is_active = ?');       params.push(is_active ? 1 : 0); }
    if (sort_order !== undefined)      { sets.push('sort_order = ?');      params.push(sort_order); }
    if (billing_cycle !== undefined)   { sets.push('billing_cycle = ?');   params.push(billing_cycle); }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    await execute(`UPDATE billing_plans SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, params);
    const [updated] = await query('SELECT * FROM billing_plans WHERE id = ?', [req.params.id]);
    if (updated?.features && typeof updated.features === 'string') try { updated.features = JSON.parse(updated.features); } catch {}
    res.json({ success: true, plan: updated });
  } catch (error) {
    console.error('Update plan error:', error);
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

// ─────────────────────────────────────────────────────────────
// BILLING — DELETE /billing/plans-config/:id  (soft-delete plan)
// ─────────────────────────────────────────────────────────────
router.delete('/billing/plans-config/:id', verifySuperAdmin, async (req, res) => {
  try {
    // Check if any tenants are on this plan
    const [plan] = await query('SELECT plan_key FROM billing_plans WHERE id = ?', [req.params.id]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const [usage] = await query('SELECT COUNT(*) AS cnt FROM tenants WHERE plan = ? AND status != "deleted"', [plan.plan_key]);
    if (usage.cnt > 0) {
      // Soft-delete (deactivate) instead of hard delete
      await execute('UPDATE billing_plans SET is_active = 0 WHERE id = ?', [req.params.id]);
      return res.json({ success: true, soft_deleted: true, message: `Plan deactivated (${usage.cnt} tenants still on it)` });
    }
    await execute('DELETE FROM billing_plans WHERE id = ?', [req.params.id]);
    res.json({ success: true, deleted: true });
  } catch (error) {
    console.error('Delete plan error:', error);
    res.status(500).json({ error: 'Failed to delete plan' });
  }
});

// ─────────────────────────────────────────────────────────────
// BILLING — GET /billing/subscriptions
// List all tenant subscriptions with Stripe data
// ─────────────────────────────────────────────────────────────
router.get('/billing/subscriptions', verifySuperAdmin, async (req, res) => {
  try {
    const { plan, sub_status, search } = req.query;
    const conditions = ["t.is_active = 1"];
    const params = [];
    if (plan)       { conditions.push('t.plan = ?');                    params.push(plan); }
    if (sub_status) { conditions.push('t.subscription_status = ?');     params.push(sub_status); }
    if (search)     { conditions.push('(t.name LIKE ? OR COALESCE(t.email, t.billing_email, \'\') LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const where = 'WHERE ' + conditions.join(' AND ');

    const rows = await query(`
      SELECT t.id, t.name,
             COALESCE(t.email, t.billing_email, '') AS email,
             t.plan, t.status, COALESCE(t.monthly_price, 0) AS monthly_price,
             t.stripe_customer_id, t.stripe_subscription_id, t.subscription_status,
             t.next_billing_date, t.created_at, t.max_users,
             (SELECT COALESCE(SUM(total), 0)  FROM invoices WHERE tenant_id = t.id AND status = 'paid')                   AS total_paid,
             (SELECT COUNT(*) FROM invoices WHERE tenant_id = t.id)                                                       AS invoice_count,
             (SELECT COALESCE(SUM(total), 0)  FROM invoices WHERE tenant_id = t.id AND status IN ('pending','overdue'))   AS outstanding
      FROM tenants t
      ${where}
      ORDER BY COALESCE(t.monthly_price,0) DESC, t.name ASC
    `, params);
    res.json({ subscriptions: rows });
  } catch (error) {
    console.error('Billing subscriptions error:', error);
    res.status(500).json({ error: 'Failed to fetch subscriptions' });
  }
});

// ─────────────────────────────────────────────────────────────
// BILLING — POST /billing/create-checkout/:tenantId
// Create a Stripe Checkout Session to upgrade/subscribe a tenant
// ─────────────────────────────────────────────────────────────
router.post('/billing/create-checkout/:tenantId', verifySuperAdmin, async (req, res) => {
  try {
    const stripe = getStripe();
    const { tenantId } = req.params;
    const { plan = 'starter' } = req.body;
    const PLANS = await getPlans();
    const planInfo = PLANS[plan];
    if (!planInfo) return res.status(400).json({ error: 'Invalid plan' });

    const tenants = await query('SELECT * FROM tenants WHERE id = ?', [tenantId]);
    if (!tenants.length) return res.status(404).json({ error: 'Tenant not found' });
    const tenant = tenants[0];

    // Create or retrieve Stripe customer
    let customerId = tenant.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: tenant.email || tenant.billing_email,
        name: tenant.name,
        metadata: { tenant_id: String(tenantId), platform: 'trasealla_crm' },
      });
      customerId = customer.id;
      await execute('UPDATE tenants SET stripe_customer_id = ? WHERE id = ?', [customerId, tenantId]);
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: planInfo.currency,
          product_data: {
            name: `Trasealla CRM — ${planInfo.label} Plan`,
            description: planInfo.features.join(' · '),
          },
          unit_amount: planInfo.price * 100, // cents
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      metadata: { tenant_id: String(tenantId), plan },
      success_url: `${frontendUrl}/super-admin/billing?success=1&tenant=${tenantId}&plan=${plan}`,
      cancel_url:  `${frontendUrl}/super-admin/billing?canceled=1`,
      subscription_data: {
        metadata: { tenant_id: String(tenantId), plan },
        trial_period_days: tenant.status === 'trial' ? 7 : undefined,
      },
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (error) {
    console.error('Create checkout error:', error);
    res.status(500).json({ error: error.message || 'Failed to create checkout session' });
  }
});

// ─────────────────────────────────────────────────────────────
// BILLING — POST /billing/customer-portal/:tenantId
// Open the Stripe billing portal for a tenant
// ─────────────────────────────────────────────────────────────
router.post('/billing/customer-portal/:tenantId', verifySuperAdmin, async (req, res) => {
  try {
    const stripe = getStripe();
    const { tenantId } = req.params;
    const tenants = await query('SELECT stripe_customer_id FROM tenants WHERE id = ?', [tenantId]);
    if (!tenants.length) return res.status(404).json({ error: 'Tenant not found' });
    const customerId = tenants[0].stripe_customer_id;
    if (!customerId) return res.status(400).json({ error: 'Tenant has no Stripe customer yet. Create a checkout first.' });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${frontendUrl}/super-admin/billing`,
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error('Customer portal error:', error);
    res.status(500).json({ error: error.message || 'Failed to open billing portal' });
  }
});

// ─────────────────────────────────────────────────────────────
// BILLING — POST /billing/cancel/:tenantId
// ─────────────────────────────────────────────────────────────
router.post('/billing/cancel/:tenantId', verifySuperAdmin, async (req, res) => {
  try {
    const stripe = getStripe();
    const tenants = await query('SELECT stripe_subscription_id, name FROM tenants WHERE id = ?', [req.params.tenantId]);
    if (!tenants.length) return res.status(404).json({ error: 'Tenant not found' });
    const { stripe_subscription_id, name } = tenants[0];
    if (!stripe_subscription_id) return res.status(400).json({ error: 'No active subscription found' });

    await stripe.subscriptions.update(stripe_subscription_id, { cancel_at_period_end: true });
    await execute(
      `UPDATE tenants SET subscription_status = 'canceled', updated_at = NOW() WHERE id = ?`,
      [req.params.tenantId]
    );
    res.json({ success: true, message: `Subscription for "${name}" will cancel at period end` });
  } catch (error) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({ error: error.message || 'Failed to cancel subscription' });
  }
});

// ─────────────────────────────────────────────────────────────
// BILLING — POST /billing/manual-assign/:tenantId
// Manually set a plan (no Stripe, for internal/demo tenants)
// ─────────────────────────────────────────────────────────────
router.post('/billing/manual-assign/:tenantId', verifySuperAdmin, async (req, res) => {
  try {
    const { plan, note } = req.body;
    const PLANS = await getPlans();
    if (!PLANS[plan] && plan !== 'trial') return res.status(400).json({ error: 'Invalid plan' });
    const planInfo = PLANS[plan] || { price: 0, max_users: 5 };
    await execute(
      `UPDATE tenants SET plan = ?, monthly_price = ?, max_users = ?, subscription_status = NULL,
       updated_at = NOW() WHERE id = ?`,
      [plan, planInfo.price, planInfo.max_users, req.params.tenantId]
    );
    res.json({ success: true, message: `Plan manually set to ${plan}` });
  } catch (error) {
    console.error('Manual assign error:', error);
    res.status(500).json({ error: 'Failed to assign plan' });
  }
});

// ─────────────────────────────────────────────────────────────
// Create new tenant (POST /super-admin/tenants)
router.post('/tenants', verifySuperAdmin, async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      plan = 'trial',
      industry = 'beauty',
      city = '',
      country = 'UAE',
      max_users = 5,
      monthly_price = 0
    } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Company name and email are required' });
    }

    // Generate slug from name
    let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    // Ensure slug uniqueness
    const existing = await query('SELECT id FROM tenants WHERE slug = ?', [slug]);
    if (existing.length > 0) {
      slug = `${slug}-${Date.now()}`;
    }

    // Calculate trial end date (30 days from now)
    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 30);

    // Insert tenant
    const tenantResult = await execute(
      `INSERT INTO tenants (name, slug, email, phone, industry, status, plan, max_users, monthly_price, billing_email, subscription_ends_at, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 'trial', ?, ?, ?, ?, ?, 1, NOW())`,
      [name, slug, email, phone || null, industry, plan, max_users, monthly_price, email, trialEnds]
    );
    const tenantId = tenantResult.insertId;

    // Generate temporary password
    const tempPassword = `Beauty${Math.floor(10000 + Math.random() * 90000)}!`;
    const hashedPassword = await bcrypt.hash(tempPassword, 12);

    // Create admin user for the tenant
    const adminUsername = slug.replace(/-/g, '_') + '_admin';
    await execute(
      `INSERT INTO staff (tenant_id, username, email, password, full_name, role, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 'admin', 1, NOW())`,
      [tenantId, adminUsername, email, hashedPassword, `${name} Admin`]
    );

    // Send welcome email with credentials
    try {
      await sendEmail({
        to: email,
        subject: `Welcome to Trasealla CRM — Your Account is Ready`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
            <div style="background:linear-gradient(135deg,#244066,#1a3050);padding:40px 32px;text-align:center">
              <h1 style="color:#fff;margin:0;font-size:26px;font-weight:700">Welcome to Trasealla CRM</h1>
              <p style="color:#a8c4e0;margin:8px 0 0;font-size:15px">Your beauty center management platform is ready</p>
            </div>
            <div style="padding:32px">
              <p style="font-size:16px;color:#333">Hello <strong>${name}</strong>,</p>
              <p style="color:#555;line-height:1.6">Your Trasealla CRM account has been created successfully. You can now log in and start managing your beauty center.</p>
              <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:24px;margin:24px 0">
                <h3 style="color:#0369a1;margin:0 0 16px;font-size:15px">Your Login Credentials</h3>
                <table style="width:100%;border-collapse:collapse">
                  <tr>
                    <td style="padding:6px 0;color:#555;font-size:14px">Login URL:</td>
                    <td style="padding:6px 0;font-weight:600;color:#0369a1;font-size:14px">${process.env.APP_URL || 'https://app.trasealla.com'}/login</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;color:#555;font-size:14px">Username:</td>
                    <td style="padding:6px 0;font-weight:600;font-size:14px">${adminUsername}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;color:#555;font-size:14px">Email:</td>
                    <td style="padding:6px 0;font-weight:600;font-size:14px">${email}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;color:#555;font-size:14px">Temp Password:</td>
                    <td style="padding:6px 0;font-weight:600;font-size:14px;color:#dc2626">${tempPassword}</td>
                  </tr>
                  <tr>
                    <td style="padding:6px 0;color:#555;font-size:14px">Plan:</td>
                    <td style="padding:6px 0;font-weight:600;font-size:14px;text-transform:capitalize">${plan} (30-day trial)</td>
                  </tr>
                </table>
              </div>
              <p style="color:#dc2626;font-size:13px;background:#fef2f2;padding:10px 14px;border-radius:6px;border-left:3px solid #dc2626"><strong>Important:</strong> Please change your password after your first login.</p>
              <div style="text-align:center;margin-top:28px">
                <a href="${process.env.APP_URL || 'https://app.trasealla.com'}/login" style="background:linear-gradient(135deg,#244066,#1a3050);color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Login to Your Account →</a>
              </div>
            </div>
            <div style="background:#f8fafc;padding:20px 32px;text-align:center;border-top:1px solid #e5e7eb">
              <p style="color:#9ca3af;font-size:12px;margin:0">Trasealla CRM — Powered by Trasealla Technology</p>
            </div>
          </div>
        `
      });
    } catch (emailErr) {
      console.error('Welcome email failed:', emailErr.message);
    }

    res.status(201).json({
      success: true,
      data: {
        tenant: { id: tenantId, name, slug, email, plan, status: 'trial' },
        admin_user: { username: adminUsername, email, temp_password: tempPassword }
      },
      message: `Tenant created. Welcome email sent to ${email}`
    });
  } catch (error) {
    console.error('Create tenant error:', error);
    res.status(500).json({ error: 'Failed to create tenant: ' + error.message });
  }
});

// Get per-tenant revenue stats
router.get('/tenants/:id/revenue', verifySuperAdmin, async (req, res) => {
  try {
    const tenantId = req.params.id;

    const revenue = await query(`
      SELECT
        COALESCE(SUM(total), 0) as total_revenue,
        COALESCE(SUM(CASE WHEN MONTH(created_at) = MONTH(NOW()) AND YEAR(created_at) = YEAR(NOW()) THEN total ELSE 0 END), 0) as this_month,
        COALESCE(SUM(CASE WHEN MONTH(created_at) = MONTH(DATE_SUB(NOW(), INTERVAL 1 MONTH)) AND YEAR(created_at) = YEAR(DATE_SUB(NOW(), INTERVAL 1 MONTH)) THEN total ELSE 0 END), 0) as last_month,
        COUNT(*) as total_invoices,
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_invoices,
        SUM(CASE WHEN status = 'unpaid' OR status = 'sent' THEN 1 ELSE 0 END) as outstanding_invoices
      FROM invoices
      WHERE tenant_id = ? AND status IN ('paid', 'unpaid', 'sent', 'partial')
    `, [tenantId]);

    const monthlyBreakdown = await query(`
      SELECT 
        DATE_FORMAT(created_at, '%Y-%m') as month,
        SUM(total) as revenue,
        COUNT(*) as invoice_count
      FROM invoices
      WHERE tenant_id = ? AND status = 'paid'
      AND created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m')
      ORDER BY month ASC
    `, [tenantId]);

    res.json({
      revenue: revenue[0] || {},
      monthly_breakdown: monthlyBreakdown || []
    });
  } catch (error) {
    console.error('Tenant revenue error:', error);
    res.status(500).json({ error: 'Failed to fetch revenue' });
  }
});

// Delete tenant
router.delete('/tenants/:id', verifySuperAdmin, async (req, res) => {
  try {
    const tenantId = req.params.id;

    // Make sure it's not the Trasealla master tenant
    const tenants = await query('SELECT name, slug FROM tenants WHERE id = ?', [tenantId]);
    if (!tenants || tenants.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    if (tenants[0].slug === 'trasealla' || tenants[0].slug === 'trasealla-crm') {
      return res.status(403).json({ error: 'Cannot delete the master Trasealla tenant' });
    }

    // Soft-delete: set status to deleted and is_active = 0
    await execute(
      `UPDATE tenants SET status = 'deleted', is_active = 0, updated_at = NOW() WHERE id = ?`,
      [tenantId]
    );
    // Deactivate all staff
    await execute('UPDATE staff SET is_active = 0 WHERE tenant_id = ?', [tenantId]);

    res.json({ success: true, message: `Tenant "${tenants[0].name}" has been deleted` });
  } catch (error) {
    console.error('Delete tenant error:', error);
    res.status(500).json({ error: 'Failed to delete tenant' });
  }
});

// ─────────────────────────────────────────────────────────────
// BILLING — GET /billing/revenue-summary
// Monthly revenue breakdown for analytics
// ─────────────────────────────────────────────────────────────
router.get('/billing/revenue-summary', verifySuperAdmin, async (req, res) => {
  try {
    const monthly = await query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') AS month,
             COUNT(*)               AS invoice_count,
             COALESCE(SUM(total),0) AS total_revenue,
             COALESCE(SUM(CASE WHEN status='paid'    THEN total ELSE 0 END), 0) AS paid_revenue,
             COALESCE(SUM(CASE WHEN status='unpaid'  THEN total ELSE 0 END), 0) AS unpaid_revenue,
             COUNT(DISTINCT tenant_id) AS active_tenants
      FROM invoices
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m')
      ORDER BY month ASC
    `);

    const planRevenue = await query(`
      SELECT t.plan, COUNT(t.id) AS tenants,
             COALESCE(SUM(t.monthly_price), 0) AS mrr,
             COALESCE(SUM(i.total), 0) AS total_invoiced
      FROM tenants t
      LEFT JOIN invoices i ON i.tenant_id = t.id AND i.status = 'paid'
      WHERE t.status != 'deleted'
      GROUP BY t.plan
    `);

    const [summary] = await query(`
      SELECT
        COALESCE(SUM(CASE WHEN status='paid' THEN total ELSE 0 END), 0)    AS total_collected,
        COALESCE(SUM(CASE WHEN status IN ('pending','overdue') THEN total ELSE 0 END), 0) AS total_outstanding,
        COALESCE(SUM(CASE WHEN status='paid' AND MONTH(created_at)=MONTH(NOW()) AND YEAR(created_at)=YEAR(NOW()) THEN total ELSE 0 END), 0) AS this_month,
        COALESCE(SUM(CASE WHEN status='paid' AND MONTH(created_at)=MONTH(DATE_SUB(NOW(),INTERVAL 1 MONTH)) AND YEAR(created_at)=YEAR(DATE_SUB(NOW(),INTERVAL 1 MONTH)) THEN total ELSE 0 END), 0) AS last_month,
        COUNT(DISTINCT CASE WHEN status='paid' THEN tenant_id END) AS paying_tenants
      FROM invoices
    `);

    const [mrrRow] = await query(`
      SELECT COALESCE(SUM(monthly_price),0) AS total_mrr,
             COUNT(CASE WHEN plan != 'trial' THEN 1 END) AS paid_count
      FROM tenants WHERE is_active = 1
    `);

    res.json({ monthly, planRevenue, summary: { ...(summary || {}), ...mrrRow } });
  } catch (error) {
    console.error('Revenue summary error:', error);
    res.status(500).json({ error: 'Failed to fetch revenue summary' });
  }
});

// ─────────────────────────────────────────────────────────────
// AUDIT LOGS — GET /audit-logs
// Platform-wide admin action trail from audit_logs table
// ─────────────────────────────────────────────────────────────
router.get('/audit-logs', verifySuperAdmin, async (req, res) => {
  try {
    const { tenant_id, action, entity_type, limit = 50, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = [];
    const params = [];
    if (tenant_id)   { conditions.push('al.tenant_id = ?');       params.push(tenant_id); }
    if (action)      { conditions.push('al.action LIKE ?');        params.push(`%${action}%`); }
    if (entity_type) { conditions.push('al.entity_type = ?');      params.push(entity_type); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const rows = await query(`
      SELECT al.id, al.tenant_id, al.user_id, al.action, al.entity_type, al.entity_id,
             al.old_values, al.new_values, al.ip_address, al.created_at,
             t.name  AS tenant_name,
             COALESCE(s.full_name, s.email, u.full_name, u.email, 'Super Admin') AS actor_name
      FROM audit_logs al
      LEFT JOIN tenants t ON al.tenant_id = t.id
      LEFT JOIN staff   s ON al.user_id = s.id AND al.tenant_id = s.tenant_id
      LEFT JOIN (SELECT id, full_name, email FROM super_admins) u ON al.user_id = u.id AND al.tenant_id IS NULL
      ${where}
      ORDER BY al.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), parseInt(offset)]);

    const [countRow] = await query(
      `SELECT COUNT(*) AS cnt FROM audit_logs al ${where}`,
      [...params]
    );

    res.json({ logs: rows, total: countRow?.cnt || 0, page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    console.error('Audit logs error:', error);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});

// ─────────────────────────────────────────────────────────────
// ANNOUNCEMENTS — CRUD
// ─────────────────────────────────────────────────────────────
router.get('/announcements', verifySuperAdmin, async (req, res) => {
  try {
    const rows = await query(`
      SELECT pa.*,
             sa.full_name AS created_by_name,
             (SELECT COUNT(*) FROM tenants WHERE status IN ('active','trial')) AS tenant_count
      FROM platform_announcements pa
      LEFT JOIN super_admins sa ON pa.created_by = sa.id
      ORDER BY pa.created_at DESC
      LIMIT 100
    `);
    res.json({ announcements: rows });
  } catch (error) {
    console.error('Announcements error:', error);
    res.status(500).json({ error: 'Failed to fetch announcements' });
  }
});

router.post('/announcements', verifySuperAdmin, async (req, res) => {
  try {
    const { title, message, priority = 'info', target = 'all', target_tenant_id = null, expires_at = null } = req.body;
    if (!title?.trim() || !message?.trim()) return res.status(400).json({ error: 'Title and message are required' });

    const result = await query(
      `INSERT INTO platform_announcements (title, message, priority, target, target_tenant_id, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [title.trim(), message.trim(), priority, target, target_tenant_id || null, req.superAdmin.id, expires_at || null]
    );

    // Broadcast to notifications table for all matching tenants
    const tenantRows = target === 'specific' && target_tenant_id
      ? await query('SELECT id FROM tenants WHERE id = ? AND status != "deleted"', [target_tenant_id])
      : await query(`SELECT id FROM tenants WHERE status IN ('active','trial')`);

    if (tenantRows.length) {
      const values = tenantRows.map(t => [
        t.id, null, 'platform_announcement', priority === 'critical' ? 'warning' : 'info',
        title.trim(), message.trim(), null, null, null, 0, 0
      ]);
      await query(
        `INSERT INTO notifications (tenant_id, user_id, type, category, title, message, data, link, icon, is_read, is_archived)
         VALUES ${values.map(() => '(?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
        values.flat()
      );
    }

    res.json({ success: true, id: result.insertId, broadcast_count: tenantRows.length });
  } catch (error) {
    console.error('Create announcement error:', error);
    res.status(500).json({ error: 'Failed to create announcement' });
  }
});

router.delete('/announcements/:id', verifySuperAdmin, async (req, res) => {
  try {
    await query('UPDATE platform_announcements SET is_active = 0 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete announcement' });
  }
});

// ─────────────────────────────────────────────────────────────
// PLANS OVERVIEW — GET /plans-overview
// Returns plan config + tenant distribution + plan revenue stats
// ─────────────────────────────────────────────────────────────
router.get('/plans-overview', verifySuperAdmin, async (req, res) => {
  try {
    const tenants = await query(`
      SELECT plan,
             COUNT(*) AS count,
             SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
             SUM(CASE WHEN status = 'trial'  THEN 1 ELSE 0 END) AS trial_count,
             SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended_count,
             COALESCE(SUM(monthly_price), 0) AS actual_mrr
      FROM tenants
      WHERE status != 'deleted'
      GROUP BY plan
    `);

    const revenue = await query(`
      SELECT t.plan,
             COALESCE(SUM(CASE WHEN i.status='paid' AND MONTH(i.created_at)=MONTH(NOW()) AND YEAR(i.created_at)=YEAR(NOW()) THEN i.total ELSE 0 END),0) AS this_month_revenue,
             COALESCE(SUM(CASE WHEN i.status='paid' THEN i.total ELSE 0 END), 0) AS all_time_revenue
      FROM invoices i
      JOIN tenants t ON i.tenant_id = t.id
      GROUP BY t.plan
    `);

    const revenueByPlan = {};
    revenue.forEach(r => { revenueByPlan[r.plan] = r; });

    const PLANS = await getPlans();
    const distribution = tenants.map(t => ({
      ...t,
      ...PLANS[t.plan],
      key: t.plan,
      this_month_revenue: revenueByPlan[t.plan]?.this_month_revenue || 0,
      all_time_revenue:   revenueByPlan[t.plan]?.all_time_revenue   || 0,
    }));

    res.json({ plans: PLANS, distribution });
  } catch (error) {
    console.error('Plans overview error:', error);
    res.status(500).json({ error: 'Failed to fetch plans overview' });
  }
});

export default router;

