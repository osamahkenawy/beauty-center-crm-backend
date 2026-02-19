import express from 'express';
import bcrypt from 'bcryptjs';
import { query, execute } from '../lib/database.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';

const router = express.Router();

/**
 * Login endpoint
 * Supports login with username or email
 * Returns user info with tenant context
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password, subdomain } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    
    // Build query to find user
    let sql = `
      SELECT s.id, s.tenant_id, s.username, s.email, s.password, s.full_name, 
             s.role, s.permissions, s.is_active, s.is_owner, s.avatar_url,
             t.name as tenant_name, t.slug as tenant_slug, t.status as tenant_status,
             t.logo_url as tenant_logo
      FROM staff s
      LEFT JOIN tenants t ON s.tenant_id = t.id
      WHERE (s.username = ? OR s.email = ?)
    `;
    const params = [username, username];
    
    // If subdomain is provided, filter by tenant
    if (subdomain) {
      sql += ' AND t.subdomain = ?';
      params.push(subdomain);
    }
    
    const users = await query(sql, params);
    
    if (users.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    // If multiple users found (same username in different tenants), use the first one
    // In production, you'd want to require subdomain or show tenant selection
    const user = users[0];
    
    if (!user.is_active) {
      return res.status(401).json({ success: false, message: 'Account is disabled' });
    }
    
    // Check tenant status
    if (user.tenant_id && user.tenant_status) {
      if (user.tenant_status === 'suspended') {
        return res.status(403).json({ success: false, message: 'Your organization account is suspended. Please contact support.' });
      }
      if (user.tenant_status === 'cancelled') {
        return res.status(403).json({ success: false, message: 'Your organization account has been cancelled.' });
      }
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    
    // Update last login
    await execute('UPDATE staff SET last_login = NOW() WHERE id = ?', [user.id]);
    
    // Parse permissions
    let permissions = {};
    if (user.permissions) {
      try {
        permissions = typeof user.permissions === 'string' ? JSON.parse(user.permissions) : user.permissions;
      } catch (e) {
        permissions = {};
      }
    }
    
    const token = generateToken({
      id: user.id,
      tenant_id: user.tenant_id,
      username: user.username,
      role: user.role,
      permissions
    });
    
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    
    // Log login
    await execute(
      'INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
      [user.tenant_id, user.id, 'login', 'staff', user.id, req.ip]
    );
    
    res.json({
      success: true,
      message: 'Login successful',
      token, // Include token in response body for frontend
      user: {
        id: user.id,
        tenant_id: user.tenant_id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        permissions,
        is_owner: user.is_owner === 1,
        avatar_url: user.avatar_url,
        tenant: user.tenant_id ? {
          id: user.tenant_id,
          name: user.tenant_name,
          slug: user.tenant_slug,
          logo_url: user.tenant_logo
        } : null
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

/**
 * Logout endpoint
 */
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    // Log logout
    if (req.user) {
      await execute(
        'INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)',
        [req.user.tenant_id, req.user.id, 'logout', 'staff', req.user.id]
      );
    }
    
    res.clearCookie('auth_token');
    res.json({ success: true, message: 'Logged out' });
  } catch (error) {
    res.clearCookie('auth_token');
    res.json({ success: true, message: 'Logged out' });
  }
});

/**
 * Get current session
 * Returns full user and tenant info
 */
router.get('/session', authMiddleware, async (req, res) => {
  try {
    const [user] = await query(
      `SELECT s.id, s.tenant_id, s.username, s.email, s.full_name, s.role, 
              s.permissions, s.is_owner, s.avatar_url,
              t.name as tenant_name, t.slug as tenant_slug, t.status as tenant_status,
              t.logo_url as tenant_logo, t.settings as tenant_settings,
              sub.plan, sub.max_users, sub.features
       FROM staff s
       LEFT JOIN tenants t ON s.tenant_id = t.id
       LEFT JOIN subscriptions sub ON t.id = sub.tenant_id
       WHERE s.id = ?`,
      [req.user.id]
    );
    
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }
    
    // Parse permissions
    let permissions = {};
    if (user.permissions) {
      try {
        permissions = typeof user.permissions === 'string' ? JSON.parse(user.permissions) : user.permissions;
      } catch (e) {
        permissions = {};
      }
    }
    
    // Parse features
    let features = {};
    if (user.features) {
      try {
        features = typeof user.features === 'string' ? JSON.parse(user.features) : user.features;
      } catch (e) {
        features = {};
      }
    }
    
    res.json({
      success: true,
      data: {
        id: user.id,
        tenant_id: user.tenant_id,
        username: user.username,
        email: user.email,
        full_name: user.full_name,
        role: user.role,
        permissions,
        is_owner: user.is_owner === 1,
        avatar_url: user.avatar_url,
        tenant: user.tenant_id ? {
          id: user.tenant_id,
          name: user.tenant_name,
          slug: user.tenant_slug,
          status: user.tenant_status,
          logo_url: user.tenant_logo,
          plan: user.plan,
          max_users: user.max_users,
          features
        } : null
      }
    });
  } catch (error) {
    console.error('Session error:', error);
    res.status(500).json({ success: false, message: 'Failed to get session' });
  }
});

/**
 * Get current user profile (alias for /session)
 */
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const [user] = await query(
      `SELECT s.id, s.tenant_id, s.username, s.email, s.full_name, s.role, 
              s.permissions, s.is_owner, s.avatar_url,
              t.name as tenant_name, t.slug as tenant_slug, t.status as tenant_status,
              t.logo_url as tenant_logo
       FROM staff s
       LEFT JOIN tenants t ON s.tenant_id = t.id
       WHERE s.id = ?`,
      [req.user.id]
    );
    if (!user) return res.status(401).json({ success: false, message: 'User not found' });
    let permissions = {};
    try { permissions = typeof user.permissions === 'string' ? JSON.parse(user.permissions) : (user.permissions || {}); } catch (e) {}
    res.json({ success: true, user: { ...user, permissions } });
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ success: false, message: 'Failed to get profile' });
  }
});

/**
 * Change password
 */
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    
    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: 'Current and new password required' });
    }
    
    if (new_password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }
    
    const [user] = await query('SELECT password FROM staff WHERE id = ?', [req.user.id]);
    
    const validPassword = await bcrypt.compare(current_password, user.password);
    if (!validPassword) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }
    
    const hashedPassword = await bcrypt.hash(new_password, 10);
    await execute('UPDATE staff SET password = ? WHERE id = ?', [hashedPassword, req.user.id]);
    
    // Log password change
    await execute(
      'INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)',
      [req.user.tenant_id, req.user.id, 'password_change', 'staff', req.user.id]
    );
    
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ success: false, message: 'Failed to change password' });
  }
});

export default router;
