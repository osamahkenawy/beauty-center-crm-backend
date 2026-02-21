import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, execute } from '../lib/database.js';
import { config } from '../config.js';
import { sendNotificationEmail } from '../lib/email.js';

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
    const events = await query(`
      SELECT 'appointment' AS type,
        a.id, a.status, a.created_at AS event_time,
        CONCAT('New appointment: ', p.name, ' for ', COALESCE(c.full_name,'Unknown')) AS description,
        t.name AS tenant_name, t.id AS tenant_id
      FROM appointments a
      JOIN tenants t ON a.tenant_id = t.id
      JOIN services p ON a.service_id = p.id
      LEFT JOIN contacts c ON a.client_id = c.id
      WHERE a.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)

      UNION ALL

      SELECT 'invoice' AS type,
        i.id, i.status, i.created_at AS event_time,
        CONCAT('Invoice ', i.invoice_number, ' — AED ', FORMAT(i.total,2)) AS description,
        t.name AS tenant_name, t.id AS tenant_id
      FROM invoices i JOIN tenants t ON i.tenant_id = t.id
      WHERE i.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)

      UNION ALL

      SELECT 'customer' AS type,
        c.id, 'new' AS status, c.created_at AS event_time,
        CONCAT('New customer: ', c.full_name) AS description,
        t.name AS tenant_name, t.id AS tenant_id
      FROM contacts c JOIN tenants t ON c.tenant_id = t.id
      WHERE c.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)

      UNION ALL

      SELECT 'payment' AS type,
        i.id, i.status, i.updated_at AS event_time,
        CONCAT('Payment received: AED ', FORMAT(i.amount_paid,2), ' for ', i.invoice_number) AS description,
        t.name AS tenant_name, t.id AS tenant_id
      FROM invoices i JOIN tenants t ON i.tenant_id = t.id
      WHERE i.status = 'paid' AND i.updated_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)

      UNION ALL

      SELECT 'review' AS type,
        r.id, CAST(r.rating AS CHAR) AS status, r.created_at AS event_time,
        CONCAT(COALESCE(r.reviewer_name,'Customer'), ' left a ', r.rating, '-star review') AS description,
        t.name AS tenant_name, t.id AS tenant_id
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
        (SELECT COUNT(*) FROM appointments WHERE tenant_id = ? AND DATE(appointment_date) = CURDATE()) AS appointments_today,
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
      SELECT a.id, a.appointment_date, a.appointment_time, a.status,
             s.name AS service_name, COALESCE(c.full_name,'Unknown') AS client_name,
             st.full_name AS staff_name
      FROM appointments a
      LEFT JOIN services s ON a.service_id = s.id
      LEFT JOIN contacts c ON a.client_id = c.id
      LEFT JOIN staff st ON a.staff_id = st.id
      WHERE a.tenant_id = ?
      ORDER BY a.created_at DESC LIMIT 10
    `, [tenantId]);

    const topServices = await query(`
      SELECT s.name, COUNT(*) AS booking_count,
             COALESCE(SUM(inv.total), 0) AS revenue
      FROM appointments a
      JOIN services s ON a.service_id = s.id
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
        (SELECT COUNT(*) FROM appointments WHERE DATE(appointment_date) = CURDATE()) AS appointments_today,
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
             (SELECT COUNT(*) FROM appointments WHERE tenant_id = t.id AND DATE(appointment_date) = CURDATE()) AS today_apts
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
// STRIPE WEBHOOK HANDLER  (placeholder — wire actual Stripe later)
// ─────────────────────────────────────────────────────────────
router.post('/stripe/webhook', async (req, res) => {
  // TODO: verify Stripe signature with stripe.webhooks.constructEvent
  // For now just log and 200
  try {
    const event = req.body;
    if (event?.type === 'checkout.session.completed') {
      const session = event.data?.object || {};
      const { tenant_name, tenant_email, plan, country } = session.metadata || {};
      if (tenant_name && tenant_email) {
        const slug = tenant_name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const tempPwd = `Beauty${Math.floor(10000 + Math.random() * 90000)}!`;
        const hash = await bcrypt.hash(tempPwd, 12);
        const trialEnd = new Date(); trialEnd.setDate(trialEnd.getDate() + 30);

        const result = await execute(
          `INSERT IGNORE INTO tenants (name, slug, email, status, plan, max_users, billing_email, subscription_ends_at, is_active, created_at)
           VALUES (?, ?, ?, 'trial', ?, 5, ?, ?, 1, NOW())`,
          [tenant_name, slug, tenant_email, plan || 'starter', tenant_email, trialEnd]
        );
        if (result.insertId) {
          const adminUser = `${slug.replace(/-/g,'_')}_admin`;
          await execute(
            `INSERT INTO staff (tenant_id, username, email, password, full_name, role, is_active, created_at)
             VALUES (?, ?, ?, ?, ?, 'admin', 1, NOW())`,
            [result.insertId, adminUser, tenant_email, hash, `${tenant_name} Admin`]
          );
          await sendNotificationEmail({
            to: tenant_email,
            subject: 'Welcome to Trasealla CRM — Your account is ready!',
            html: `<p>Login: <strong>${adminUser}</strong> / <strong>${tempPwd}</strong></p>`
          });
        }
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Stripe webhook error:', err);
    res.status(500).json({ error: 'Webhook error' });
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
      await sendNotificationEmail({
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

export default router;

