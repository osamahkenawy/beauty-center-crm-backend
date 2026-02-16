import express from 'express';
import bcrypt from 'bcryptjs';
import { query, execute } from '../lib/database.js';
import { authMiddleware, adminOnly } from '../middleware/auth.js';

const router = express.Router();

// Ensure branch_id column exists
async function ensureSchema() {
  const cols = [
    { name: 'branch_id', sql: 'ALTER TABLE staff ADD COLUMN branch_id INT AFTER role' },
    { name: 'tenant_id', sql: 'ALTER TABLE staff ADD COLUMN tenant_id INT AFTER id' },
  ];
  for (const col of cols) {
    try { await execute(col.sql); } catch (e) { /* column already exists */ }
  }
}

// Get all staff (with branch info)
router.get('/', authMiddleware, async (req, res) => {
  try {
    await ensureSchema();
    const tenantId = req.tenantId;

    let sql = `
      SELECT s.id, s.username, s.email, s.full_name, s.phone, s.role, 
             s.is_active, s.last_login, s.created_at, s.branch_id, s.tenant_id,
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

    // Filter by branch_id
    if (req.query.branch_id) {
      sql += ' AND s.branch_id = ?';
      params.push(req.query.branch_id);
    }

    // Filter by active
    if (req.query.active !== undefined) {
      sql += ' AND s.is_active = ?';
      params.push(req.query.active === 'true' ? 1 : 0);
    }

    sql += ' ORDER BY s.created_at DESC';

    const staff = await query(sql, params);
    res.json({ success: true, data: staff });
  } catch (error) {
    console.error('Get staff error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch staff' });
  }
});

// Create staff (admin only)
router.post('/', authMiddleware, adminOnly, async (req, res) => {
  try {
    await ensureSchema();
    const { username, email, password, full_name, phone, role, branch_id } = req.body;
    const tenantId = req.tenantId;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const result = await execute(
      'INSERT INTO staff (tenant_id, username, email, password, full_name, phone, role, branch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [tenantId || null, username, email || null, hashedPassword, full_name || null, phone || null, role || 'staff', branch_id || null]
    );
    
    res.json({ success: true, message: 'Staff created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create staff error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: 'Username or email already exists' });
    }
    res.status(500).json({ success: false, message: 'Failed to create staff' });
  }
});

// Update staff
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email, phone, role, is_active, password, branch_id } = req.body;
    
    // Only admin can change role or active status
    if ((role || is_active !== undefined) && req.user.role !== 'admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    
    const updates = [];
    const params = [];
    
    if (full_name !== undefined) { updates.push('full_name = ?'); params.push(full_name); }
    if (email !== undefined) { updates.push('email = ?'); params.push(email || null); }
    if (phone !== undefined) { updates.push('phone = ?'); params.push(phone || null); }
    if (role !== undefined) { updates.push('role = ?'); params.push(role); }
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
    if (branch_id !== undefined) { updates.push('branch_id = ?'); params.push(branch_id || null); }
    if (req.body.tenant_id !== undefined) { updates.push('tenant_id = ?'); params.push(req.body.tenant_id || null); }
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      updates.push('password = ?');
      params.push(hashedPassword);
    }
    
    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No updates provided' });
    }
    
    params.push(id);
    await execute(`UPDATE staff SET ${updates.join(', ')} WHERE id = ?`, params);
    
    res.json({ success: true, message: 'Staff updated' });
  } catch (error) {
    console.error('Update staff error:', error);
    res.status(500).json({ success: false, message: 'Failed to update staff' });
  }
});

// Delete staff (admin only)
router.delete('/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Prevent self-delete
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ success: false, message: 'Cannot delete yourself' });
    }
    
    await execute('DELETE FROM staff WHERE id = ?', [id]);
    res.json({ success: true, message: 'Staff deleted' });
  } catch (error) {
    console.error('Delete staff error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete staff' });
  }
});

export default router;
