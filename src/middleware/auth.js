import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../lib/database.js';

/**
 * Generate JWT token with tenant context
 */
export function generateToken(user) {
  return jwt.sign(
    { 
      id: user.id, 
      username: user.username, 
      role: user.role,
      tenant_id: user.tenant_id,
      permissions: user.permissions
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

/**
 * Verify JWT token
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret);
  } catch {
    return null;
  }
}

/**
 * Authentication middleware
 * Validates JWT and loads full user data
 */
export async function authMiddleware(req, res, next) {
  try {
    const token = req.cookies?.auth_token || req.headers.authorization?.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    
    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    
    // Load fresh user data from database
    const [user] = await query(
      'SELECT id, tenant_id, username, email, full_name, role, permissions, is_active, is_owner FROM staff WHERE id = ?',
      [decoded.id]
    );
    
    if (!user || !user.is_active) {
      return res.status(401).json({ success: false, message: 'User not found or inactive' });
    }
    
    // Parse permissions if it's a string
    if (typeof user.permissions === 'string') {
      try {
        user.permissions = JSON.parse(user.permissions);
      } catch {
        user.permissions = {};
      }
    }
    
    req.user = user;
    req.tenantId = user.tenant_id; // Set tenant ID from user
    
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({ success: false, message: 'Authentication error' });
  }
}

/**
 * Admin only middleware
 * Allows admin and super_admin roles
 */
export function adminOnly(req, res, next) {
  if (!req.user || !['admin', 'super_admin'].includes(req.user.role)) {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
}

/**
 * Super admin only middleware
 * Only allows super_admin role
 */
export function superAdminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({ success: false, message: 'Super admin access required' });
  }
  next();
}

/**
 * Platform owner only middleware
 * Only allows platform owners (Trasealla staff)
 */
export function platformOwnerOnly(req, res, next) {
  if (!req.user?.permissions?.platform_owner) {
    return res.status(403).json({ success: false, message: 'Platform owner access required' });
  }
  next();
}

/**
 * Tenant owner / admin middleware
 * Allows tenant owner, admin/manager role, staff with write permission, or platform owner
 */
export function tenantOwnerOnly(req, res, next) {
  const role = req.user?.role;
  const isOwner = req.user?.is_owner;
  const isPlatformOwner = req.user?.permissions?.platform_owner;
  const isAdminRole = role === 'admin' || role === 'manager';
  const hasAll = req.user?.permissions?.all;
  const hasWrite = req.user?.permissions?.write;

  if (!isOwner && !isPlatformOwner && !isAdminRole && !hasAll && !hasWrite) {
    return res.status(403).json({ success: false, message: 'Write access required' });
  }
  next();
}

/**
 * Check specific permission
 */
export function hasPermission(permission) {
  return (req, res, next) => {
    const perms = req.user?.permissions || {};
    
    // Platform owners and super admins have all permissions
    if (perms.all || perms.super_admin || perms.platform_owner) {
      return next();
    }
    
    // Check specific permission
    if (!perms[permission]) {
      return res.status(403).json({ success: false, message: `Permission '${permission}' required` });
    }
    
    next();
  };
}

/**
 * Role-based access control
 * @param {string[]} allowedRoles - Array of allowed roles
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    
    // Platform owners can access everything
    if (req.user.permissions?.platform_owner) {
      return next();
    }
    
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false, 
        message: `Access denied. Required roles: ${allowedRoles.join(', ')}` 
      });
    }
    
    next();
  };
}
