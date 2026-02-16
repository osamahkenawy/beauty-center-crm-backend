import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, execute } from '../lib/database.js';
import { config } from '../config.js';

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
        SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) as suspended_tenants
      FROM tenants
    `);

    const userStats = await query(`
      SELECT COUNT(*) as total_users FROM staff WHERE is_active = 1
    `);

    const recentTenants = await query(`
      SELECT id, name, email, industry, status, created_at 
      FROM tenants 
      ORDER BY created_at DESC 
      LIMIT 5
    `);

    res.json({
      stats: {
        ...(tenantStats[0] || {}),
        total_users: userStats[0]?.total_users || 0
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

export default router;
