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
 * Validates JWT and loads full user data + role-based permissions
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
    
    // Load role-based permissions from roles table
    if (user.tenant_id && user.role) {
      try {
        const roleRows = await query(
          'SELECT permissions FROM roles WHERE tenant_id = ? AND name = ? AND is_active = 1',
          [user.tenant_id, user.role]
        );
        if (roleRows.length > 0) {
          let rolePerms = roleRows[0].permissions;
          if (typeof rolePerms === 'string') {
            try { rolePerms = JSON.parse(rolePerms); } catch { rolePerms = {}; }
          }
          user.rolePermissions = rolePerms || {};
        }
      } catch {
        // roles table might not exist yet — that's fine
      }
    }
    if (!user.rolePermissions) user.rolePermissions = {};
    
    req.user = user;
    req.tenantId = user.tenant_id; // Set tenant ID from user
    
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(500).json({ success: false, message: 'Authentication error' });
  }
}

/**
 * Check if user has full access (admin, super_admin, owner, or all-permissions)
 */
function hasFullAccess(user) {
  if (!user) return false;
  const role = user.role;
  const perms = user.permissions || {};
  return role === 'admin' || role === 'super_admin' || user.is_owner === 1 || perms.all || perms.platform_owner;
}

/**
 * Admin only middleware
 * Allows admin, super_admin, manager, and owner
 */
export function adminOnly(req, res, next) {
  if (hasFullAccess(req.user)) return next();
  if (req.user?.role === 'manager') return next();
  return res.status(403).json({ success: false, message: 'Admin access required' });
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
  if (hasFullAccess(req.user)) return next();
  const role = req.user?.role;
  if (role === 'manager') return next();
  const hasWrite = req.user?.permissions?.write;
  if (hasWrite) return next();
  return res.status(403).json({ success: false, message: 'Write access required' });
}

/**
 * Check specific permission (legacy)
 */
export function hasPermission(permission) {
  return (req, res, next) => {
    if (hasFullAccess(req.user)) return next();
    
    const perms = req.user?.permissions || {};
    if (perms[permission]) return next();
    
    return res.status(403).json({ success: false, message: `Permission '${permission}' required` });
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
    
    // Admin / owner always passes
    if (hasFullAccess(req.user)) return next();
    
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false, 
        message: `Access denied. Required roles: ${allowedRoles.join(', ')}` 
      });
    }
    
    next();
  };
}

/**
 * Module-level permission check using the roles table permissions
 * Usage: canAccess('appointments', 'create')
 * Checks if the user's role has the specified action on the module
 */
export function canAccess(module, action = 'view') {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    
    // Admin / owner / super_admin always has full access
    if (hasFullAccess(req.user)) return next();
    
    // Check role-based permissions loaded from DB
    const rolePerms = req.user.rolePermissions || {};
    const modulePerms = rolePerms[module] || {};
    
    if (modulePerms[action]) return next();
    
    // Fallback to legacy permissions object
    const legacyPerms = req.user.permissions || {};
    if (legacyPerms.all || legacyPerms[module]) return next();
    
    return res.status(403).json({
      success: false,
      message: `Access denied. You need '${action}' permission for '${module}'.`
    });
  };
}
