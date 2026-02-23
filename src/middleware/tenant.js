import { query } from '../lib/database.js';

/**
 * Tenant Middleware
 * Extracts tenant context from request and validates access
 */
export const tenantMiddleware = async (req, res, next) => {
  try {
    // Skip tenant check for platform super admins
    if (req.user && req.user.permissions?.platform_owner) {
      req.tenantId = req.query.tenant_id || req.body?.tenant_id || null;
      return next();
    }
    
    // Get tenant ID from various sources
    let tenantId = null;
    
    // 1. From authenticated user
    if (req.user?.tenant_id) {
      tenantId = req.user.tenant_id;
    }
    
    // 2. From subdomain (e.g., company.crm.trasealla.com)
    if (!tenantId) {
      const host = req.get('host');
      const subdomain = extractSubdomain(host);
      if (subdomain && subdomain !== 'api' && subdomain !== 'www') {
        const [tenant] = await query('SELECT id FROM tenants WHERE subdomain = ? AND status = "active"', [subdomain]);
        if (tenant) {
          tenantId = tenant.id;
        }
      }
    }
    
    // 3. From custom header
    if (!tenantId && req.headers['x-tenant-id']) {
      tenantId = parseInt(req.headers['x-tenant-id']);
    }
    
    // 4. From query parameter (for API access)
    if (!tenantId && req.query.tenant_id) {
      tenantId = parseInt(req.query.tenant_id);
    }
    
    // Validate tenant exists and is active
    if (tenantId) {
      const [tenant] = await query(
        `SELECT t.*,
                COALESCE(t.plan, 'trial') AS plan,
                COALESCE(t.max_users, 5) AS max_users,
                COALESCE(t.subscription_status, '') AS subscription_status
         FROM tenants t WHERE t.id = ?`,
        [tenantId]
      );
      
      if (!tenant) {
        return res.status(404).json({ success: false, message: 'Tenant not found' });
      }
      
      // ── Account lockout checks — return 423 Locked with reason ──
      if (tenant.status === 'suspended') {
        return res.status(423).json({
          success: false,
          locked: true,
          reason: tenant.subscription_status === 'past_due' ? 'payment_failed' : 'suspended',
          message: 'Your account has been suspended. Please update your subscription to continue.',
          upgrade_url: '/billing'
        });
      }
      
      if (tenant.status === 'cancelled') {
        return res.status(423).json({
          success: false,
          locked: true,
          reason: 'cancelled',
          message: 'Your account has been cancelled. Please subscribe to reactivate.',
          upgrade_url: '/billing'
        });
      }
      
      // Check if trial expired (1 day grace period)
      // Check both status='trial' AND plan='trial' to catch all trial accounts
      if ((tenant.status === 'trial' || tenant.plan === 'trial') && tenant.trial_ends_at) {
        const trialEnd = new Date(tenant.trial_ends_at);
        const now = new Date();
        const graceEnd = new Date(trialEnd);
        graceEnd.setDate(graceEnd.getDate() + 1); // 1 day grace
        
        if (now > graceEnd) {
          return res.status(423).json({
            success: false,
            locked: true,
            reason: 'trial_expired',
            message: 'Your trial period has expired. Please choose a plan to continue.',
            trial_ended_at: tenant.trial_ends_at,
            upgrade_url: '/billing'
          });
        }
      }

      // Check past_due grace period
      if (tenant.subscription_status === 'past_due' && tenant.grace_period_ends_at) {
        if (new Date() > new Date(tenant.grace_period_ends_at)) {
          return res.status(423).json({
            success: false,
            locked: true,
            reason: 'payment_failed',
            message: 'Your payment has failed and the grace period has ended. Please update your payment method.',
            upgrade_url: '/billing'
          });
        }
      }
      
      req.tenantId = tenantId;
      req.tenant = tenant;
    }
    
    next();
  } catch (error) {
    console.error('Tenant middleware error:', error);
    next(error);
  }
};

/**
 * Require Tenant Middleware
 * Ensures a valid tenant is present in the request
 */
export const requireTenant = (req, res, next) => {
  if (!req.tenantId && !req.user?.permissions?.platform_owner) {
    return res.status(400).json({ success: false, message: 'Tenant context required' });
  }
  next();
};

/**
 * Check User Limit Middleware
 * Ensures tenant hasn't exceeded user limit
 */
export const checkUserLimit = async (req, res, next) => {
  try {
    if (!req.tenantId) return next();
    
    const maxUsers = req.tenant?.max_users || 5;
    const [userCount] = await query(
      'SELECT COUNT(*) AS current_users FROM staff WHERE tenant_id = ? AND is_active = 1',
      [req.tenantId]
    );
    
    if (userCount && userCount.current_users >= maxUsers) {
      return res.status(403).json({
        success: false,
        message: `User limit reached (${maxUsers}). Please upgrade your plan.`
      });
    }
    
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Check Feature Access Middleware
 * Ensures tenant has access to a specific feature
 */
export const checkFeature = (feature) => {
  return async (req, res, next) => {
    try {
      if (req.user?.permissions?.platform_owner) return next();
      
      if (!req.tenantId) {
        return res.status(400).json({ success: false, message: 'Tenant context required' });
      }
      
      // Read allowed_modules from tenant (set by super admin)
      const tenant = req.tenant;
      if (!tenant) {
        return res.status(403).json({ success: false, message: 'No active subscription' });
      }
      
      // Enterprise / active paid plans get all features
      if (tenant.plan === 'enterprise' || tenant.plan === 'professional') return next();
      
      let modules = tenant.allowed_modules;
      if (typeof modules === 'string') {
        try { modules = JSON.parse(modules); } catch { modules = null; }
      }
      
      // If no module restrictions set, allow all
      if (!modules || (Array.isArray(modules) && modules.length === 0)) return next();
      
      // Check if feature is in allowed list
      if (Array.isArray(modules) && !modules.includes(feature) && !modules.includes('all')) {
        return res.status(403).json({
          success: false,
          message: `Feature '${feature}' is not available in your plan. Please upgrade.`
        });
      }
      
      next();
    } catch (error) {
      next(error);
    }
  };
};

// Helper function to extract subdomain
function extractSubdomain(host) {
  if (!host) return null;
  
  // Remove port if present
  host = host.split(':')[0];
  
  // Split by dots
  const parts = host.split('.');
  
  // For localhost, return null
  if (host.includes('localhost')) return null;
  
  // For domains like company.crm.trasealla.com, return 'company'
  if (parts.length >= 3) {
    return parts[0];
  }
  
  return null;
}

export default tenantMiddleware;


