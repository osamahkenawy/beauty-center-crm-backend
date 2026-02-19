import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware, adminOnly } from '../middleware/auth.js';

const router = express.Router();

// ─── Default Predefined Roles ────────────────────────────
const DEFAULT_ROLES = [
  {
    name: 'admin',
    display_name: 'Admin / Owner',
    description: 'Full access to all features. Beauty center owner.',
    color: '#f2421b',
    is_system: true,
    sort_order: 1,
    permissions: {
      dashboard: { view: true },
      appointments: { view: true, create: true, edit: true, delete: true, confirm: true, cancel: true },
      clients: { view: true, create: true, edit: true, delete: true, export: true },
      team: { view: true, create: true, edit: true, delete: true, manage_roles: true },
      services: { view: true, create: true, edit: true, delete: true },
      categories: { view: true, create: true, edit: true, delete: true },
      payments: { view: true, create: true, edit: true, refund: true },
      invoices: { view: true, create: true, edit: true, print: true },
      reports: { view: true, export: true },
      settings: { view: true, edit: true },
      branches: { view: true, create: true, edit: true, delete: true },
      inventory: { view: true, create: true, edit: true, delete: true },
      marketing: { view: true, create: true, edit: true, delete: true },
      promotions: { view: true, create: true, edit: true, delete: true },
      gift_cards: { view: true, create: true, edit: true },
      packages: { view: true, create: true, edit: true, delete: true },
      memberships: { view: true, create: true, edit: true, delete: true },
      loyalty: { view: true, edit: true },
      reviews: { view: true, respond: true },
      pos: { view: true, create: true },
      consultation_forms: { view: true, create: true, edit: true },
      group_bookings: { view: true, create: true, edit: true },
      patch_tests: { view: true, create: true, edit: true },
      notifications: { view: true, manage: true },
      waitlist: { view: true, manage: true },
      online_booking: { view: true, manage: true },
      audit_logs: { view: true },
      roles: { view: true, manage: true },
    },
  },
  {
    name: 'manager',
    display_name: 'Manager',
    description: 'Manages daily operations, team, and reports. Cannot change settings or roles.',
    color: '#667eea',
    is_system: true,
    sort_order: 2,
    permissions: {
      dashboard: { view: true },
      appointments: { view: true, create: true, edit: true, confirm: true, cancel: true },
      clients: { view: true, create: true, edit: true, export: true },
      team: { view: true, create: true, edit: true },
      services: { view: true, create: true, edit: true },
      categories: { view: true, create: true, edit: true },
      payments: { view: true, create: true, edit: true, refund: true },
      invoices: { view: true, create: true, edit: true, print: true },
      reports: { view: true, export: true },
      settings: { view: true },
      branches: { view: true },
      inventory: { view: true, create: true, edit: true },
      marketing: { view: true, create: true, edit: true },
      promotions: { view: true, create: true, edit: true },
      gift_cards: { view: true, create: true },
      packages: { view: true, create: true, edit: true },
      memberships: { view: true, create: true, edit: true },
      loyalty: { view: true, edit: true },
      reviews: { view: true, respond: true },
      pos: { view: true, create: true },
      consultation_forms: { view: true, create: true, edit: true },
      group_bookings: { view: true, create: true, edit: true },
      patch_tests: { view: true, create: true, edit: true },
      notifications: { view: true, manage: true },
      waitlist: { view: true, manage: true },
      online_booking: { view: true },
      audit_logs: { view: true },
    },
  },
  {
    name: 'receptionist',
    display_name: 'Receptionist',
    description: 'Front desk operations: appointments, check-in/out, clients, and payments.',
    color: '#10b981',
    is_system: true,
    sort_order: 3,
    permissions: {
      dashboard: { view: true },
      appointments: { view: true, create: true, edit: true, confirm: true, cancel: true },
      clients: { view: true, create: true, edit: true },
      team: { view: true },
      services: { view: true },
      categories: { view: true },
      payments: { view: true, create: true },
      invoices: { view: true, create: true, print: true },
      reports: { view: true },
      inventory: { view: true },
      gift_cards: { view: true },
      packages: { view: true },
      memberships: { view: true },
      reviews: { view: true },
      pos: { view: true, create: true },
      consultation_forms: { view: true, create: true },
      group_bookings: { view: true, create: true },
      patch_tests: { view: true },
      notifications: { view: true },
      waitlist: { view: true, manage: true },
    },
  },
  {
    name: 'stylist',
    display_name: 'Stylist / Therapist',
    description: 'Service provider: views own appointments, marks complete, manages own schedule.',
    color: '#8b5cf6',
    is_system: true,
    sort_order: 4,
    permissions: {
      dashboard: { view: true },
      appointments: { view: true, edit: true }, // own appointments only
      clients: { view: true },
      team: {},
      services: { view: true },
      categories: { view: true },
      payments: {},
      invoices: {},
      reports: {},
      consultation_forms: { view: true },
      patch_tests: { view: true, create: true },
      notifications: { view: true },
      waitlist: { view: true },
    },
  },
  {
    name: 'staff',
    display_name: 'Staff / Employee',
    description: 'Basic access: views own schedule and assigned tasks.',
    color: '#f59e0b',
    is_system: true,
    sort_order: 5,
    permissions: {
      dashboard: { view: true },
      appointments: { view: true }, // own only
      clients: { view: true },
      services: { view: true },
      categories: { view: true },
      notifications: { view: true },
    },
  },
];

// ─── Ensure Tables ───────────────────────────────────────
async function ensureTables() {
  await execute(`
    CREATE TABLE IF NOT EXISTS roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(50) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      description TEXT,
      color VARCHAR(20) DEFAULT '#667eea',
      permissions JSON,
      is_system BOOLEAN DEFAULT 0,
      is_active BOOLEAN DEFAULT 1,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_role_tenant (tenant_id, name)
    )
  `);
}

// ─── Seed default roles for a tenant ─────────────────────
async function seedDefaultRoles(tenantId) {
  for (const role of DEFAULT_ROLES) {
    const existing = await query(
      'SELECT id FROM roles WHERE tenant_id = ? AND name = ?',
      [tenantId, role.name]
    );
    if (existing.length === 0) {
      await execute(
        `INSERT INTO roles (tenant_id, name, display_name, description, color, permissions, is_system, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [tenantId, role.name, role.display_name, role.description, role.color,
          JSON.stringify(role.permissions), role.is_system ? 1 : 0, role.sort_order]
      );
    }
  }
}

// ============================================================
// GET /roles — List all roles for the tenant
// ============================================================
router.get('/', authMiddleware, async (req, res) => {
  try {
    await ensureTables();
    const tenantId = req.tenantId;

    // Auto-seed if no roles exist
    const countCheck = await query('SELECT COUNT(*) as cnt FROM roles WHERE tenant_id = ?', [tenantId]);
    if (countCheck[0].cnt === 0) {
      await seedDefaultRoles(tenantId);
    }

    const roles = await query(
      `SELECT r.*, 
        (SELECT COUNT(*) FROM staff s WHERE s.role = r.name AND s.tenant_id = r.tenant_id) as member_count
       FROM roles r 
       WHERE r.tenant_id = ? AND r.is_active = 1
       ORDER BY r.sort_order, r.name`,
      [tenantId]
    );

    // Parse permissions
    const parsed = roles.map(r => ({
      ...r,
      permissions: typeof r.permissions === 'string' ? JSON.parse(r.permissions) : (r.permissions || {}),
    }));

    res.json({ success: true, data: parsed });
  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch roles', debug: error.message });
  }
});

// ============================================================
// GET /roles/permissions-matrix — All available permission modules
// ============================================================
router.get('/permissions-matrix', authMiddleware, async (req, res) => {
  const matrix = [
    { module: 'dashboard', label: 'Dashboard', actions: ['view'] },
    { module: 'appointments', label: 'Appointments', actions: ['view', 'create', 'edit', 'delete', 'confirm', 'cancel'] },
    { module: 'clients', label: 'Clients', actions: ['view', 'create', 'edit', 'delete', 'export'] },
    { module: 'team', label: 'Team Management', actions: ['view', 'create', 'edit', 'delete', 'manage_roles'] },
    { module: 'services', label: 'Services', actions: ['view', 'create', 'edit', 'delete'] },
    { module: 'categories', label: 'Categories', actions: ['view', 'create', 'edit', 'delete'] },
    { module: 'payments', label: 'Payments', actions: ['view', 'create', 'edit', 'refund'] },
    { module: 'invoices', label: 'Invoices', actions: ['view', 'create', 'edit', 'print'] },
    { module: 'reports', label: 'Reports', actions: ['view', 'export'] },
    { module: 'settings', label: 'Settings', actions: ['view', 'edit'] },
    { module: 'branches', label: 'Branches', actions: ['view', 'create', 'edit', 'delete'] },
    { module: 'inventory', label: 'Inventory', actions: ['view', 'create', 'edit', 'delete'] },
    { module: 'marketing', label: 'Marketing', actions: ['view', 'create', 'edit', 'delete'] },
    { module: 'promotions', label: 'Promotions', actions: ['view', 'create', 'edit', 'delete'] },
    { module: 'gift_cards', label: 'Gift Cards', actions: ['view', 'create', 'edit'] },
    { module: 'packages', label: 'Packages', actions: ['view', 'create', 'edit', 'delete'] },
    { module: 'memberships', label: 'Memberships', actions: ['view', 'create', 'edit', 'delete'] },
    { module: 'loyalty', label: 'Loyalty', actions: ['view', 'edit'] },
    { module: 'reviews', label: 'Reviews', actions: ['view', 'respond'] },
    { module: 'pos', label: 'Point of Sale', actions: ['view', 'create'] },
    { module: 'consultation_forms', label: 'Consultation Forms', actions: ['view', 'create', 'edit'] },
    { module: 'group_bookings', label: 'Group Bookings', actions: ['view', 'create', 'edit'] },
    { module: 'patch_tests', label: 'Patch Tests', actions: ['view', 'create', 'edit'] },
    { module: 'notifications', label: 'Notifications', actions: ['view', 'manage'] },
    { module: 'waitlist', label: 'Waitlist', actions: ['view', 'manage'] },
    { module: 'online_booking', label: 'Online Booking', actions: ['view', 'manage'] },
    { module: 'audit_logs', label: 'Audit Logs', actions: ['view'] },
    { module: 'roles', label: 'Roles & Permissions', actions: ['view', 'manage'] },
  ];
  res.json({ success: true, data: matrix });
});

// ============================================================
// GET /roles/:id — Single role detail
// ============================================================
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    await ensureTables();
    const [role] = await query(
      'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantId]
    );
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });

    role.permissions = typeof role.permissions === 'string' ? JSON.parse(role.permissions) : (role.permissions || {});

    // Get members with this role
    const members = await query(
      'SELECT id, full_name, email, avatar_url, is_active FROM staff WHERE role = ? AND tenant_id = ?',
      [role.name, req.tenantId]
    );

    res.json({ success: true, data: { ...role, members } });
  } catch (error) {
    console.error('Get role detail error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch role', debug: error.message });
  }
});

// ============================================================
// POST /roles — Create a custom role
// ============================================================
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const { name, display_name, description, color, permissions } = req.body;

    if (!name?.trim() || !display_name?.trim()) {
      return res.status(400).json({ success: false, message: 'Name and display name are required' });
    }

    // Validate name format
    const cleanName = name.trim().toLowerCase().replace(/\s+/g, '_');

    // Check duplicate
    const existing = await query(
      'SELECT id FROM roles WHERE tenant_id = ? AND name = ?',
      [req.tenantId, cleanName]
    );
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'A role with this name already exists' });
    }

    // Get max sort_order
    const [maxSort] = await query(
      'SELECT MAX(sort_order) as max_sort FROM roles WHERE tenant_id = ?',
      [req.tenantId]
    );

    const result = await execute(
      `INSERT INTO roles (tenant_id, name, display_name, description, color, permissions, is_system, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        req.tenantId,
        cleanName,
        display_name.trim(),
        description || null,
        color || '#667eea',
        JSON.stringify(permissions || {}),
        (maxSort?.max_sort || 0) + 1,
      ]
    );

    res.json({ success: true, message: 'Role created', data: { id: result.insertId, name: cleanName } });
  } catch (error) {
    console.error('Create role error:', error);
    res.status(500).json({ success: false, message: 'Failed to create role', debug: error.message });
  }
});

// ============================================================
// PATCH /roles/:id — Update role permissions
// ============================================================
router.patch('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    await ensureTables();
    const { display_name, description, color, permissions } = req.body;

    const [role] = await query(
      'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantId]
    );
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });

    // System roles can have their permissions updated but not name
    const updates = [];
    const params = [];

    if (display_name !== undefined) { updates.push('display_name = ?'); params.push(display_name); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (color !== undefined) { updates.push('color = ?'); params.push(color); }
    if (permissions !== undefined) { updates.push('permissions = ?'); params.push(JSON.stringify(permissions)); }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'Nothing to update' });
    }

    params.push(req.params.id, req.tenantId);
    await execute(
      `UPDATE roles SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`,
      params
    );

    res.json({ success: true, message: 'Role updated' });
  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({ success: false, message: 'Failed to update role', debug: error.message });
  }
});

// ============================================================
// DELETE /roles/:id — Delete custom role (not system roles)
// ============================================================
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [role] = await query(
      'SELECT * FROM roles WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantId]
    );
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });

    if (role.is_system) {
      return res.status(400).json({ success: false, message: 'System roles cannot be deleted' });
    }

    // Check if any staff have this role
    const staffCount = await query(
      'SELECT COUNT(*) as cnt FROM staff WHERE role = ? AND tenant_id = ?',
      [role.name, req.tenantId]
    );
    if (staffCount[0].cnt > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete: ${staffCount[0].cnt} team member(s) have this role. Reassign them first.`
      });
    }

    await execute('DELETE FROM roles WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Role deleted' });
  } catch (error) {
    console.error('Delete role error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete role', debug: error.message });
  }
});

// ============================================================
// POST /roles/seed — Re-seed default roles
// ============================================================
router.post('/seed', authMiddleware, adminOnly, async (req, res) => {
  try {
    await ensureTables();
    await seedDefaultRoles(req.tenantId);
    res.json({ success: true, message: 'Default roles seeded' });
  } catch (error) {
    console.error('Seed roles error:', error);
    res.status(500).json({ success: false, message: 'Failed to seed roles', debug: error.message });
  }
});

// ============================================================
// POST /roles/reset/:id — Reset a system role to defaults
// ============================================================
router.post('/reset/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const [role] = await query(
      'SELECT name FROM roles WHERE id = ? AND tenant_id = ?',
      [req.params.id, req.tenantId]
    );
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });

    const defaultRole = DEFAULT_ROLES.find(r => r.name === role.name);
    if (!defaultRole) {
      return res.status(400).json({ success: false, message: 'This is not a system role' });
    }

    await execute(
      'UPDATE roles SET permissions = ?, description = ?, color = ? WHERE id = ? AND tenant_id = ?',
      [JSON.stringify(defaultRole.permissions), defaultRole.description, defaultRole.color, req.params.id, req.tenantId]
    );

    res.json({ success: true, message: 'Role reset to default permissions' });
  } catch (error) {
    console.error('Reset role error:', error);
    res.status(500).json({ success: false, message: 'Failed to reset role', debug: error.message });
  }
});

// ============================================================
// GET /roles/available — Get available role names for staff assignment
// ============================================================
router.get('/list/available', authMiddleware, async (req, res) => {
  try {
    await ensureTables();
    const tenantId = req.tenantId;

    const countCheck = await query('SELECT COUNT(*) as cnt FROM roles WHERE tenant_id = ?', [tenantId]);
    if (countCheck[0].cnt === 0) {
      await seedDefaultRoles(tenantId);
    }

    const roles = await query(
      'SELECT name, display_name, color, description FROM roles WHERE tenant_id = ? AND is_active = 1 ORDER BY sort_order',
      [tenantId]
    );

    res.json({ success: true, data: roles });
  } catch (error) {
    console.error('Get available roles error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch available roles', debug: error.message });
  }
});

export default router;
