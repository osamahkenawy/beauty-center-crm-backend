import express from 'express';
import bcrypt from 'bcryptjs';
import { query, execute } from '../lib/database.js';
import { authMiddleware, platformOwnerOnly, tenantOwnerOnly, adminOnly, generateToken } from '../middleware/auth.js';
import crypto from 'crypto';

const router = express.Router();

// =====================================================
// PUBLIC ROUTES - For Registration/Onboarding
// =====================================================

/**
 * Register a new tenant (Sign up)
 * Creates tenant, subscription, and admin user
 */
router.post('/register', async (req, res) => {
  try {
    const { 
      company_name, 
      email, 
      password, 
      full_name, 
      phone,
      industry,
      plan = 'trial'
    } = req.body;
    
    if (!company_name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Company name, email, and password are required' });
    }
    
    // Generate slug from company name
    const slug = company_name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .substring(0, 50);
    
    // Check if slug/email already exists
    const [existing] = await query('SELECT id FROM tenants WHERE slug = ? OR email = ?', [slug, email]);
    if (existing) {
      return res.status(400).json({ success: false, message: 'Company or email already registered' });
    }
    
    // Create tenant
    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 14); // 14-day trial
    
    const tenantResult = await execute(
      `INSERT INTO tenants (name, slug, subdomain, email, phone, industry, status, trial_ends_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [company_name, slug, slug, email, phone || null, industry || null, 'trial', trialEnds]
    );
    const tenantId = tenantResult.insertId;
    
    // Create subscription
    const planConfig = getPlanConfig(plan);
    await execute(
      `INSERT INTO subscriptions (tenant_id, plan, status, max_users, features, started_at, current_period_start, current_period_end) 
       VALUES (?, ?, ?, ?, ?, NOW(), NOW(), ?)`,
      [tenantId, 'trial', 'active', planConfig.maxUsers, JSON.stringify(planConfig.features), trialEnds]
    );
    
    // Create admin user
    const hashedPassword = await bcrypt.hash(password, 10);
    const username = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    
    const userResult = await execute(
      `INSERT INTO staff (tenant_id, username, email, password, full_name, role, permissions, is_owner) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, username, email, hashedPassword, full_name || company_name, 'admin', JSON.stringify({ all: true }), 1]
    );
    
    // Create industry-specific pipeline
    const pipelineConfig = getIndustryPipeline(industry);
    const pipelineResult = await execute(
      "INSERT INTO pipelines (tenant_id, name, description, is_default) VALUES (?, ?, ?, ?)",
      [tenantId, pipelineConfig.name, pipelineConfig.description, 1]
    );
    const pipelineId = pipelineResult.insertId;
    
    for (const stage of pipelineConfig.stages) {
      await execute(
        'INSERT INTO pipeline_stages (pipeline_id, name, color, probability, sort_order, is_won, is_lost) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [pipelineId, stage.name, stage.color, stage.probability, stage.order, stage.is_won || 0, stage.is_lost || 0]
      );
    }
    
    // Generate token for auto-login
    const token = generateToken({
      id: userResult.insertId,
      tenant_id: tenantId,
      username,
      role: 'admin',
      permissions: { all: true }
    });
    
    // Log the registration
    await execute(
      'INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_values) VALUES (?, ?, ?, ?, ?, ?)',
      [tenantId, userResult.insertId, 'tenant_registered', 'tenant', tenantId, JSON.stringify({ company_name, email })]
    );
    
    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        tenant: {
          id: tenantId,
          name: company_name,
          slug,
          subdomain: slug,
          trial_ends_at: trialEnds
        },
        user: {
          id: userResult.insertId,
          username,
          email,
          role: 'admin'
        },
        token
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

/**
 * Check if subdomain/slug is available
 */
router.get('/check-availability', async (req, res) => {
  try {
    const { slug, email } = req.query;
    const result = { slug_available: true, email_available: true };
    
    if (slug) {
      const [existing] = await query('SELECT id FROM tenants WHERE slug = ? OR subdomain = ?', [slug, slug]);
      result.slug_available = !existing;
    }
    
    if (email) {
      const [existing] = await query('SELECT id FROM tenants WHERE email = ?', [email]);
      result.email_available = !existing;
    }
    
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Check failed' });
  }
});

// =====================================================
// AUTHENTICATED ROUTES - Tenant Management
// =====================================================

/**
 * Get current tenant info
 */
router.get('/current', authMiddleware, async (req, res) => {
  try {
    if (!req.tenantId) {
      return res.status(400).json({ success: false, message: 'No tenant context' });
    }
    
    const [tenant] = await query(
      `SELECT t.*, s.plan, s.max_users, s.current_users, s.status as subscription_status, 
              s.current_period_end, s.features
       FROM tenants t 
       LEFT JOIN subscriptions s ON t.id = s.tenant_id 
       WHERE t.id = ?`,
      [req.tenantId]
    );
    
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }
    
    // Get user count
    const [userCount] = await query('SELECT COUNT(*) as count FROM staff WHERE tenant_id = ? AND is_active = 1', [req.tenantId]);
    tenant.current_users = userCount?.count || 0;
    
    res.json({ success: true, data: tenant });
  } catch (error) {
    console.error('Get tenant error:', error);
    res.status(500).json({ success: false, message: 'Failed to get tenant info' });
  }
});

/**
 * Update current tenant
 */
router.patch('/current', authMiddleware, tenantOwnerOnly, async (req, res) => {
  try {
    const fields = ['name', 'email', 'phone', 'logo_url', 'address', 'city', 'country', 'timezone', 'currency', 'language'];
    const updates = [];
    const params = [];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(req.body[f] || null); // empty string → null
      }
    }

    // logo_url special case: allow empty string to explicitly clear
    if (req.body.logo_url === '') {
      // Already handled above as null, which clears it
    }

    // Handle settings separately (JSON) — frontend may send as string or object
    if (req.body.settings !== undefined) {
      updates.push('settings = ?');
      const settingsVal = req.body.settings;
      if (!settingsVal) {
        params.push(null);
      } else if (typeof settingsVal === 'string') {
        // Already a JSON string from frontend — store as-is
        params.push(settingsVal);
      } else {
        params.push(JSON.stringify(settingsVal));
      }
    }

    if (updates.length === 0) {
      return res.json({ success: true, message: 'No changes' });
    }

    params.push(req.tenantId);
    await execute(`UPDATE tenants SET ${updates.join(', ')} WHERE id = ?`, params);
    
    res.json({ success: true, message: 'Tenant updated successfully' });
  } catch (error) {
    console.error('Update tenant error:', error);
    res.status(500).json({ success: false, message: 'Failed to update tenant' });
  }
});

/**
 * Reset current tenant data (development/testing helper)
 * Keeps tenant record + subscription + current user account.
 */
router.post('/current/reset-data', authMiddleware, adminOnly, async (req, res) => {
  try {
    if (!req.tenantId) {
      return res.status(400).json({ success: false, message: 'No tenant context' });
    }

    const { confirm } = req.body || {};
    if (confirm !== 'RESET') {
      return res.status(400).json({
        success: false,
        message: 'Confirmation required. Send {"confirm":"RESET"} to proceed.'
      });
    }

    const excludedTables = ['tenants', 'subscriptions', 'staff', 'roles'];

    const tenantTables = await query(
      `SELECT DISTINCT c.table_name
       FROM information_schema.columns c
       WHERE c.table_schema = DATABASE()
         AND c.column_name = 'tenant_id'
         AND c.table_name NOT IN (${excludedTables.map(() => '?').join(', ')})`,
      excludedTables
    );

    const summary = [];

    for (const row of tenantTables) {
      const tableName = row.table_name || row.TABLE_NAME;
      if (!tableName) continue;
      const result = await execute(`DELETE FROM \`${tableName}\` WHERE tenant_id = ?`, [req.tenantId]);
      summary.push({ table: tableName, deleted: result.affectedRows || 0 });
    }

    const staffCleanup = await execute(
      'DELETE FROM staff WHERE tenant_id = ? AND id != ? AND IFNULL(is_owner, 0) = 0',
      [req.tenantId, req.user.id]
    );
    summary.push({ table: 'staff(non-owner)', deleted: staffCleanup.affectedRows || 0 });

    const deletedRows = summary.reduce((acc, item) => acc + (item.deleted || 0), 0);

    res.json({
      success: true,
      message: 'Tenant dummy data cleared successfully',
      data: {
        tenant_id: req.tenantId,
        deleted_rows: deletedRows,
        tables_processed: summary.length,
        details: summary.filter(item => item.deleted > 0)
      }
    });
  } catch (error) {
    console.error('Reset tenant data error:', error);
    res.status(500).json({ success: false, message: 'Failed to reset tenant data', debug: error.message });
  }
});

/**
 * Get subscription info
 */
router.get('/subscription', authMiddleware, async (req, res) => {
  try {
    const [subscription] = await query(
      `SELECT s.*, t.trial_ends_at, t.status as tenant_status
       FROM subscriptions s 
       JOIN tenants t ON s.tenant_id = t.id
       WHERE s.tenant_id = ?`,
      [req.tenantId]
    );
    
    if (!subscription) {
      return res.status(404).json({ success: false, message: 'No subscription found' });
    }
    
    // Parse features
    if (typeof subscription.features === 'string') {
      subscription.features = JSON.parse(subscription.features);
    }
    
    res.json({ success: true, data: subscription });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get subscription' });
  }
});

/**
 * Get usage statistics
 */
router.get('/usage', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    
    const [users] = await query('SELECT COUNT(*) as count FROM staff WHERE tenant_id = ? AND is_active = 1', [tenantId]);
    const [contacts] = await query('SELECT COUNT(*) as count FROM contacts WHERE tenant_id = ?', [tenantId]);
    const [leads] = await query('SELECT COUNT(*) as count FROM leads WHERE tenant_id = ?', [tenantId]);
    const [deals] = await query('SELECT COUNT(*) as count FROM deals WHERE tenant_id = ?', [tenantId]);
    const [subscription] = await query('SELECT max_users FROM subscriptions WHERE tenant_id = ?', [tenantId]);
    
    res.json({
      success: true,
      data: {
        users: { current: users?.count || 0, max: subscription?.max_users || 5 },
        contacts: contacts?.count || 0,
        leads: leads?.count || 0,
        deals: deals?.count || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get usage stats' });
  }
});

// =====================================================
// PLATFORM ADMIN ROUTES - Manage All Tenants
// =====================================================

/**
 * List all tenants (Platform admin only)
 */
router.get('/', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    const { status, search, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    
    let sql = `
      SELECT t.*, s.plan, s.max_users, s.current_users, s.status as subscription_status,
             (SELECT COUNT(*) FROM staff WHERE tenant_id = t.id) as user_count
      FROM tenants t
      LEFT JOIN subscriptions s ON t.id = s.tenant_id
      WHERE 1=1
    `;
    const params = [];
    
    if (status) {
      sql += ' AND t.status = ?';
      params.push(status);
    }
    
    if (search) {
      sql += ' AND (t.name LIKE ? OR t.email LIKE ? OR t.slug LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    
    sql += ` ORDER BY t.created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
    
    const tenants = await query(sql, params);
    
    // Get total count
    const [countResult] = await query('SELECT COUNT(*) as total FROM tenants');
    
    res.json({
      success: true,
      data: tenants,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult?.total || 0
      }
    });
  } catch (error) {
    console.error('List tenants error:', error);
    res.status(500).json({ success: false, message: 'Failed to list tenants' });
  }
});

/**
 * Get single tenant (Platform admin only)
 */
router.get('/:id', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    const [tenant] = await query(
      `SELECT t.*, s.plan, s.max_users, s.features, s.status as subscription_status,
              s.current_period_start, s.current_period_end
       FROM tenants t
       LEFT JOIN subscriptions s ON t.id = s.tenant_id
       WHERE t.id = ?`,
      [req.params.id]
    );
    
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'Tenant not found' });
    }
    
    // Get users
    const users = await query('SELECT id, username, email, full_name, role, is_active FROM staff WHERE tenant_id = ?', [tenant.id]);
    tenant.users = users;
    
    res.json({ success: true, data: tenant });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get tenant' });
  }
});

/**
 * Update tenant (Platform admin only)
 */
router.patch('/:id', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    const { status, plan, max_users } = req.body;
    
    if (status) {
      await execute('UPDATE tenants SET status = ? WHERE id = ?', [status, req.params.id]);
    }
    
    if (plan || max_users) {
      const planConfig = plan ? getPlanConfig(plan) : {};
      await execute(
        `UPDATE subscriptions SET 
          plan = COALESCE(?, plan),
          max_users = COALESCE(?, max_users),
          features = COALESCE(?, features)
         WHERE tenant_id = ?`,
        [plan, max_users || planConfig.maxUsers, plan ? JSON.stringify(planConfig.features) : null, req.params.id]
      );
    }
    
    res.json({ success: true, message: 'Tenant updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update tenant' });
  }
});

/**
 * Suspend tenant (Platform admin only)
 */
router.post('/:id/suspend', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    await execute('UPDATE tenants SET status = "suspended" WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Tenant suspended' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to suspend tenant' });
  }
});

/**
 * Activate tenant (Platform admin only)
 */
router.post('/:id/activate', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    await execute('UPDATE tenants SET status = "active" WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Tenant activated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to activate tenant' });
  }
});

/**
 * Delete tenant (Platform admin only)
 */
router.delete('/:id', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    const tenantId = req.params.id;
    
    // Delete in order due to foreign keys
    await execute('DELETE FROM subscriptions WHERE tenant_id = ?', [tenantId]);
    await execute('DELETE FROM staff WHERE tenant_id = ?', [tenantId]);
    await execute('DELETE FROM tenants WHERE id = ?', [tenantId]);
    
    res.json({ success: true, message: 'Tenant deleted' });
  } catch (error) {
    console.error('Delete tenant error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete tenant' });
  }
});

// =====================================================
// LICENSE KEY ROUTES
// =====================================================

/**
 * Generate license key (Platform admin only)
 */
router.post('/licenses/generate', authMiddleware, platformOwnerOnly, async (req, res) => {
  try {
    const { tenant_id, license_type, max_users, expires_in_days, features } = req.body;
    
    // Generate unique license key
    const licenseKey = `TRAS-${license_type.toUpperCase().substring(0, 3)}-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (expires_in_days || 365));
    
    const result = await execute(
      `INSERT INTO license_keys (tenant_id, license_key, license_type, max_users, features, expires_at) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [tenant_id || null, licenseKey, license_type, max_users || 5, JSON.stringify(features || {}), expiresAt]
    );
    
    res.json({
      success: true,
      data: {
        id: result.insertId,
        license_key: licenseKey,
        license_type,
        max_users,
        expires_at: expiresAt
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to generate license' });
  }
});

/**
 * Validate license key
 */
router.post('/licenses/validate', async (req, res) => {
  try {
    const { license_key } = req.body;
    
    const [license] = await query(
      'SELECT * FROM license_keys WHERE license_key = ?',
      [license_key]
    );
    
    if (!license) {
      return res.status(404).json({ success: false, message: 'Invalid license key' });
    }
    
    if (!license.is_active) {
      return res.status(403).json({ success: false, message: 'License is deactivated' });
    }
    
    if (new Date(license.expires_at) < new Date()) {
      return res.status(403).json({ success: false, message: 'License has expired' });
    }
    
    // Update validation count
    await execute(
      'UPDATE license_keys SET last_validated_at = NOW(), validation_count = validation_count + 1 WHERE id = ?',
      [license.id]
    );
    
    res.json({
      success: true,
      data: {
        valid: true,
        license_type: license.license_type,
        max_users: license.max_users,
        expires_at: license.expires_at,
        features: license.features
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'License validation failed' });
  }
});

/**
 * Activate license for a tenant
 */
router.post('/licenses/activate', async (req, res) => {
  try {
    const { license_key, company_name, email, password, full_name } = req.body;
    
    // Validate license
    const [license] = await query(
      'SELECT * FROM license_keys WHERE license_key = ? AND is_active = 1 AND tenant_id IS NULL',
      [license_key]
    );
    
    if (!license) {
      return res.status(404).json({ success: false, message: 'Invalid or already used license key' });
    }
    
    if (new Date(license.expires_at) < new Date()) {
      return res.status(403).json({ success: false, message: 'License has expired' });
    }
    
    // Create tenant with this license
    const slug = company_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 50);
    
    const tenantResult = await execute(
      `INSERT INTO tenants (name, slug, subdomain, email, status) VALUES (?, ?, ?, ?, ?)`,
      [company_name, slug, slug, email, 'active']
    );
    const tenantId = tenantResult.insertId;
    
    // Create subscription based on license
    await execute(
      `INSERT INTO subscriptions (tenant_id, plan, status, max_users, features, started_at) 
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [tenantId, license.license_type, 'active', license.max_users, license.features]
    );
    
    // Link license to tenant
    await execute(
      'UPDATE license_keys SET tenant_id = ?, activated_at = NOW() WHERE id = ?',
      [tenantId, license.id]
    );
    
    // Create admin user
    const hashedPassword = await bcrypt.hash(password, 10);
    const username = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    
    const userResult = await execute(
      `INSERT INTO staff (tenant_id, username, email, password, full_name, role, permissions, is_owner) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, username, email, hashedPassword, full_name || company_name, 'admin', JSON.stringify({ all: true }), 1]
    );
    
    // Generate token
    const token = generateToken({
      id: userResult.insertId,
      tenant_id: tenantId,
      username,
      role: 'admin',
      permissions: { all: true }
    });
    
    res.json({
      success: true,
      message: 'License activated successfully',
      data: {
        tenant: { id: tenantId, name: company_name, slug },
        user: { id: userResult.insertId, username, email },
        token
      }
    });
  } catch (error) {
    console.error('License activation error:', error);
    res.status(500).json({ success: false, message: 'License activation failed' });
  }
});

// =====================================================
// HELPER FUNCTIONS
// =====================================================

function getPlanConfig(plan) {
  const plans = {
    trial: { maxUsers: 3, features: { core_crm: true, basic_reports: true } },
    starter: { maxUsers: 5, features: { core_crm: true, basic_reports: true, pipelines: 1 } },
    professional: { maxUsers: 25, features: { core_crm: true, reports: true, workflows: true, campaigns: true, integrations: true, pipelines: 5 } },
    enterprise: { maxUsers: 999, features: { all: true } },
    self_hosted: { maxUsers: 999, features: { all: true } }
  };
  
  return plans[plan] || plans.trial;
}

/**
 * Get industry-specific pipeline configuration
 */
function getIndustryPipeline(industry) {
  const pipelines = {
    Technology: {
      name: 'Tech Sales Pipeline',
      description: 'Optimized for software and technology sales',
      stages: [
        { name: 'Lead Qualified', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Demo Scheduled', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Demo Completed', color: '#f59e0b', probability: 40, order: 3 },
        { name: 'Technical Evaluation', color: '#ec4899', probability: 55, order: 4 },
        { name: 'Proposal Sent', color: '#14b8a6', probability: 70, order: 5 },
        { name: 'Negotiation', color: '#ef4444', probability: 85, order: 6 },
        { name: 'Closed Won', color: '#22c55e', probability: 100, order: 7, is_won: 1 },
        { name: 'Closed Lost', color: '#6b7280', probability: 0, order: 8, is_lost: 1 },
      ]
    },
    Healthcare: {
      name: 'Healthcare Sales Pipeline',
      description: 'For medical and healthcare services',
      stages: [
        { name: 'Initial Inquiry', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Assessment', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Compliance Review', color: '#f59e0b', probability: 40, order: 3 },
        { name: 'Proposal', color: '#14b8a6', probability: 60, order: 4 },
        { name: 'Contract Review', color: '#ef4444', probability: 80, order: 5 },
        { name: 'Closed Won', color: '#22c55e', probability: 100, order: 6, is_won: 1 },
        { name: 'Closed Lost', color: '#6b7280', probability: 0, order: 7, is_lost: 1 },
      ]
    },
    'Real Estate': {
      name: 'Real Estate Pipeline',
      description: 'For property sales and leasing',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Property Viewing', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Interest Confirmed', color: '#f59e0b', probability: 45, order: 3 },
        { name: 'Offer Made', color: '#14b8a6', probability: 65, order: 4 },
        { name: 'Negotiation', color: '#ef4444', probability: 80, order: 5 },
        { name: 'Contract Signed', color: '#22c55e', probability: 100, order: 6, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 7, is_lost: 1 },
      ]
    },
    Finance: {
      name: 'Financial Services Pipeline',
      description: 'For banking and financial services',
      stages: [
        { name: 'Inquiry', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Needs Analysis', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Credit Assessment', color: '#f59e0b', probability: 40, order: 3 },
        { name: 'Proposal', color: '#14b8a6', probability: 55, order: 4 },
        { name: 'Documentation', color: '#ec4899', probability: 70, order: 5 },
        { name: 'Final Approval', color: '#ef4444', probability: 85, order: 6 },
        { name: 'Disbursed', color: '#22c55e', probability: 100, order: 7, is_won: 1 },
        { name: 'Rejected', color: '#6b7280', probability: 0, order: 8, is_lost: 1 },
      ]
    },
    Retail: {
      name: 'Retail Sales Pipeline',
      description: 'For retail and wholesale businesses',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 15, order: 1 },
        { name: 'Product Interest', color: '#8b5cf6', probability: 35, order: 2 },
        { name: 'Quote Sent', color: '#f59e0b', probability: 55, order: 3 },
        { name: 'Negotiation', color: '#ef4444', probability: 75, order: 4 },
        { name: 'Order Placed', color: '#22c55e', probability: 100, order: 5, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 6, is_lost: 1 },
      ]
    },
    Manufacturing: {
      name: 'Manufacturing Pipeline',
      description: 'For B2B manufacturing sales',
      stages: [
        { name: 'RFQ Received', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Specifications', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Quotation', color: '#f59e0b', probability: 45, order: 3 },
        { name: 'Sample/Prototype', color: '#14b8a6', probability: 60, order: 4 },
        { name: 'Negotiation', color: '#ef4444', probability: 75, order: 5 },
        { name: 'Purchase Order', color: '#22c55e', probability: 100, order: 6, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 7, is_lost: 1 },
      ]
    },
    Education: {
      name: 'Education Enrollment Pipeline',
      description: 'For educational institutions',
      stages: [
        { name: 'Inquiry', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Application', color: '#8b5cf6', probability: 30, order: 2 },
        { name: 'Assessment', color: '#f59e0b', probability: 50, order: 3 },
        { name: 'Offer Made', color: '#14b8a6', probability: 70, order: 4 },
        { name: 'Enrolled', color: '#22c55e', probability: 100, order: 5, is_won: 1 },
        { name: 'Not Enrolled', color: '#6b7280', probability: 0, order: 6, is_lost: 1 },
      ]
    },
    Consulting: {
      name: 'Consulting Pipeline',
      description: 'For consulting and professional services',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Discovery Call', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Needs Assessment', color: '#f59e0b', probability: 40, order: 3 },
        { name: 'Proposal', color: '#14b8a6', probability: 60, order: 4 },
        { name: 'Presentation', color: '#ec4899', probability: 75, order: 5 },
        { name: 'Contract', color: '#ef4444', probability: 90, order: 6 },
        { name: 'Won', color: '#22c55e', probability: 100, order: 7, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 8, is_lost: 1 },
      ]
    },
    Hospitality: {
      name: 'Hospitality Pipeline',
      description: 'For hotels and hospitality',
      stages: [
        { name: 'Inquiry', color: '#3b82f6', probability: 15, order: 1 },
        { name: 'Quote Sent', color: '#8b5cf6', probability: 35, order: 2 },
        { name: 'Site Visit', color: '#f59e0b', probability: 55, order: 3 },
        { name: 'Proposal', color: '#14b8a6', probability: 75, order: 4 },
        { name: 'Booked', color: '#22c55e', probability: 100, order: 5, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 6, is_lost: 1 },
      ]
    },
    Automotive: {
      name: 'Automotive Sales Pipeline',
      description: 'For car dealerships and automotive',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Showroom Visit', color: '#8b5cf6', probability: 30, order: 2 },
        { name: 'Test Drive', color: '#f59e0b', probability: 50, order: 3 },
        { name: 'Financing', color: '#14b8a6', probability: 70, order: 4 },
        { name: 'Negotiation', color: '#ef4444', probability: 85, order: 5 },
        { name: 'Sold', color: '#22c55e', probability: 100, order: 6, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 7, is_lost: 1 },
      ]
    },
    Construction: {
      name: 'Construction Pipeline',
      description: 'For construction and contracting',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Site Survey', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Estimation', color: '#f59e0b', probability: 45, order: 3 },
        { name: 'Proposal', color: '#14b8a6', probability: 60, order: 4 },
        { name: 'Negotiation', color: '#ef4444', probability: 75, order: 5 },
        { name: 'Contract Signed', color: '#22c55e', probability: 100, order: 6, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 7, is_lost: 1 },
      ]
    },
    Legal: {
      name: 'Legal Services Pipeline',
      description: 'For law firms and legal services',
      stages: [
        { name: 'Initial Consultation', color: '#3b82f6', probability: 15, order: 1 },
        { name: 'Case Evaluation', color: '#8b5cf6', probability: 35, order: 2 },
        { name: 'Engagement Letter', color: '#f59e0b', probability: 60, order: 3 },
        { name: 'Retainer', color: '#14b8a6', probability: 80, order: 4 },
        { name: 'Engaged', color: '#22c55e', probability: 100, order: 5, is_won: 1 },
        { name: 'Not Retained', color: '#6b7280', probability: 0, order: 6, is_lost: 1 },
      ]
    },
    Insurance: {
      name: 'Insurance Pipeline',
      description: 'For insurance sales',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Needs Analysis', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Quote Provided', color: '#f59e0b', probability: 45, order: 3 },
        { name: 'Underwriting', color: '#14b8a6', probability: 65, order: 4 },
        { name: 'Policy Issued', color: '#22c55e', probability: 100, order: 5, is_won: 1 },
        { name: 'Declined', color: '#6b7280', probability: 0, order: 6, is_lost: 1 },
      ]
    },
    Marketing: {
      name: 'Agency Pipeline',
      description: 'For marketing agencies',
      stages: [
        { name: 'Lead', color: '#3b82f6', probability: 10, order: 1 },
        { name: 'Discovery', color: '#8b5cf6', probability: 25, order: 2 },
        { name: 'Strategy Proposal', color: '#f59e0b', probability: 45, order: 3 },
        { name: 'Pitch/Presentation', color: '#14b8a6', probability: 65, order: 4 },
        { name: 'Negotiation', color: '#ef4444', probability: 80, order: 5 },
        { name: 'Won', color: '#22c55e', probability: 100, order: 6, is_won: 1 },
        { name: 'Lost', color: '#6b7280', probability: 0, order: 7, is_lost: 1 },
      ]
    }
  };

  // Default generic pipeline if industry not found
  const defaultPipeline = {
    name: 'Sales Pipeline',
    description: 'Standard sales pipeline',
    stages: [
      { name: 'Qualification', color: '#3b82f6', probability: 10, order: 1 },
      { name: 'Needs Analysis', color: '#8b5cf6', probability: 25, order: 2 },
      { name: 'Proposal', color: '#f59e0b', probability: 50, order: 3 },
      { name: 'Negotiation', color: '#ef4444', probability: 75, order: 4 },
      { name: 'Closed Won', color: '#22c55e', probability: 100, order: 5, is_won: 1 },
      { name: 'Closed Lost', color: '#6b7280', probability: 0, order: 6, is_lost: 1 },
    ]
  };

  return pipelines[industry] || defaultPipeline;
}

export default router;

