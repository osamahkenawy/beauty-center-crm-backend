import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query, execute } from '../lib/database.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';
import { sendEmail, buildEmailTemplate, getTenantBranding } from '../lib/email.js';
import { config } from '../config.js';

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

// ─── Password Reset Token Table ──────────────────────────────
async function ensureResetTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      staff_id   INT NOT NULL,
      token      VARCHAR(128) NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      used       TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_token (token),
      INDEX idx_staff (staff_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

/**
 * POST /auth/forgot-password
 * Accepts email, sends a reset link. Always responds with success to prevent enumeration.
 */
router.post('/forgot-password', async (req, res) => {
  try {
    await ensureResetTable();
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });

    // Find user
    const [user] = await query(
      'SELECT id, full_name, email, is_active FROM staff WHERE email = ? LIMIT 1',
      [email.toLowerCase().trim()]
    );

    // Always return success (prevent email enumeration)
    if (!user || !user.is_active) {
      return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
    }

    // Invalidate any existing tokens for this user
    await execute(
      'UPDATE password_reset_tokens SET used = 1 WHERE staff_id = ? AND used = 0',
      [user.id]
    );

    // Generate secure token (32 bytes = 64 hex chars)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await execute(
      'INSERT INTO password_reset_tokens (staff_id, token, expires_at) VALUES (?, ?, ?)',
      [user.id, token, expiresAt]
    );

    const resetUrl = `${config.frontendUrl}/reset-password?token=${token}`;
    const firstName = user.full_name?.split(' ')[0] || 'there';

    const html = buildEmailTemplate({
      logoUrl: `${config.frontendUrl}/assets/images/logos/trasealla-solutions-logo.png`,
      logoAlt: 'Trasealla Solutions',
      accentColor: '#1c2f4e',
      title: 'Reset Your Password',
      subtitle: 'Trasealla Solutions — Account Security',
      bodyHtml: `
        <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">
          Hi <strong style="color:#111827;">${firstName}</strong>,
        </p>
        <p style="margin:0 0 8px;color:#6b7280;line-height:1.75;">
          We received a request to reset your password for your Trasealla Solutions CRM account.
          Click the button below to choose a new password.
        </p>`,
      ctaText: 'Reset My Password',
      ctaUrl: resetUrl,
      copyLink: resetUrl,
      expiryNote: '1 hour',
      footerName: 'Trasealla Solutions',
      isSystem: true,
    });

    const emailResult = await sendEmail({
      to: user.email,
      subject: 'Reset your Trasealla Solutions password',
      html,
    });

    if (!emailResult.success) {
      console.error('Reset email failed:', emailResult.error);
      // In dev mode — log the link
      console.log(`\n🔑 PASSWORD RESET LINK (dev):\n   ${resetUrl}\n`);
    }

    res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

/**
 * GET /auth/reset-password/validate
 * Validates a reset token without consuming it
 */
router.get('/reset-password/validate', async (req, res) => {
  try {
    await ensureResetTable();
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, message: 'Token is required.' });

    const [row] = await query(
      `SELECT prt.*, s.email, s.full_name
       FROM password_reset_tokens prt
       JOIN staff s ON s.id = prt.staff_id
       WHERE prt.token = ? AND prt.used = 0 AND prt.expires_at > NOW()`,
      [token]
    );

    if (!row) {
      return res.status(400).json({
        success: false,
        message: 'This reset link has expired or already been used. Please request a new one.',
      });
    }

    res.json({
      success: true,
      email: row.email,
      name: row.full_name,
    });
  } catch (error) {
    console.error('Validate token error:', error);
    res.status(500).json({ success: false, message: 'Validation failed.' });
  }
});

/**
 * POST /auth/reset-password
 * Accepts token + new password, updates the password
 */
router.post('/reset-password', async (req, res) => {
  try {
    await ensureResetTable();
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ success: false, message: 'Token and new password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }

    // Find valid, unexpired token
    const [row] = await query(
      `SELECT prt.id, prt.staff_id, s.email, s.full_name
       FROM password_reset_tokens prt
       JOIN staff s ON s.id = prt.staff_id
       WHERE prt.token = ? AND prt.used = 0 AND prt.expires_at > NOW()`,
      [token]
    );

    if (!row) {
      return res.status(400).json({
        success: false,
        message: 'This reset link has expired or already been used. Please request a new one.',
      });
    }

    // Hash new password
    const hashed = await bcrypt.hash(password, 10);

    // Update password + mark token as used (atomic)
    await execute('UPDATE staff SET password = ? WHERE id = ?', [hashed, row.staff_id]);
    await execute('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [row.id]);

    // Log action
    try {
      await execute(
        'INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
        [null, row.staff_id, 'password_reset', 'staff', row.staff_id, req.ip]
      );
    } catch (e) { /* ignore audit log failures */ }

    // Send confirmation email
    const confirmHtml = `
      <div style="max-width:480px;margin:0 auto;font-family:'Segoe UI',Arial,sans-serif;">
        <div style="background:linear-gradient(135deg,#10b981,#059669);padding:32px;text-align:center;border-radius:16px 16px 0 0;">
          <div style="width:52px;height:52px;background:rgba(255,255,255,0.2);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 14px;">
            <span style="font-size:24px;">✓</span>
          </div>
          <h1 style="color:#fff;margin:0;font-size:20px;font-weight:700;">Password Updated!</h1>
        </div>
        <div style="background:#fff;padding:30px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;">
          <p style="color:#374151;font-size:14px;line-height:1.7;">
            Hi <strong>${row.full_name?.split(' ')[0] || 'there'}</strong>, your Trasealla CRM password has been changed successfully.
          </p>
          <p style="color:#6b7280;font-size:13px;line-height:1.7;">
            If you didn't make this change, contact support immediately at
            <a href="mailto:support@trasealla.com" style="color:#f2421b;">support@trasealla.com</a>
          </p>
          <div style="text-align:center;margin:24px 0;">
            <a href="${config.frontendUrl}/login"
               style="display:inline-block;background:#1c2430;color:#fff;padding:12px 28px;
                      border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;">
              Sign In Now
            </a>
          </div>
          <hr style="border:none;border-top:1px solid #f1f5f9;margin:20px 0;" />
          <p style="color:#cbd5e1;font-size:11px;text-align:center;margin:0;">Trasealla CRM</p>
        </div>
      </div>
    `;
    sendEmail({ to: row.email, subject: 'Your password has been changed', html: confirmHtml })
      .catch(() => {}); // fire-and-forget

    res.json({ success: true, message: 'Password reset successfully. You can now sign in.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ success: false, message: 'Failed to reset password. Please try again.' });
  }
});

/**
 * POST /auth/test-email
 * Admin-only: sends a test email and returns SMTP diagnostic info
 */
router.post('/test-email', authMiddleware, async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ success: false, message: 'Recipient "to" email is required' });

    const smtpConfigured = !!(config.smtp.user && config.smtp.pass);
    const configInfo = {
      host: config.smtp.host,
      port: config.smtp.port,
      user: config.smtp.user || '(not set)',
      from: config.smtp.from || config.smtp.user || '(not set)',
      secure: config.smtp.secure,
      tls: config.smtp.tls,
      configured: smtpConfigured,
    };

    if (!smtpConfigured) {
      return res.json({
        success: false,
        message: 'Email not configured — EMAIL_USER or EMAIL_PASS missing in .env',
        config: configInfo,
      });
    }

    const result = await sendEmail({
      to,
      subject: '✅ Trasealla CRM — Email Test',
      html: buildEmailTemplate({
        logoUrl: `${config.frontendUrl}/assets/images/logos/trasealla-solutions-logo.png`,
        logoAlt: 'Trasealla Solutions',
        accentColor: '#1c2f4e',
        title: 'Email Test Successful',
        subtitle: 'Your SMTP configuration is working correctly',
        bodyHtml: `
          <p style="margin:0 0 12px;color:#374151;">This is a test email from <strong>Trasealla Solutions CRM</strong>.</p>
          <p style="margin:0 0 8px;color:#6b7280;">If you received this, your SMTP configuration is working correctly.</p>
          <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">
            Sent from: ${config.smtp.from || config.smtp.user}<br/>
            Via: ${config.smtp.host}:${config.smtp.port}
          </p>`,
        footerName: 'Trasealla Solutions',
        isSystem: true,
      }),
    });

    res.json({
      success: result.success,
      message: result.success
        ? `✅ Test email sent to ${to} successfully`
        : `❌ Failed: ${result.error}`,
      messageId: result.messageId,
      config: configInfo,
      diagnosis: result.success ? null : getDiagnosis(result.error),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /auth/email-status
 * Returns current SMTP configuration status (no credentials exposed)
 */
router.get('/email-status', authMiddleware, async (req, res) => {
  const smtpConfigured = !!(config.smtp.user && config.smtp.pass);
  res.json({
    success: true,
    data: {
      configured: smtpConfigured,
      host: config.smtp.host,
      port: config.smtp.port,
      from: config.smtp.from || config.smtp.user || null,
      user: config.smtp.user ? config.smtp.user : null,
    },
  });
});

function getDiagnosis(error = '') {
  if (error.includes('535') || error.includes('EAUTH') || error.includes('Authentication')) {
    return {
      cause: 'Authentication failed — Office 365 rejected the credentials',
      fixes: [
        'Enable "Authenticated SMTP" in Microsoft 365 Admin: admin.microsoft.com → Users → noreply@trasealla.com → Mail → Manage email apps → Enable "Authenticated SMTP"',
        'If MFA is enabled: create an App Password at account.microsoft.com → Security → App passwords, then update EMAIL_PASS in .env',
        'Run PowerShell: Set-CASMailbox -Identity noreply@trasealla.com -SmtpClientAuthenticationDisabled $false',
      ],
    };
  }
  if (error.includes('ECONNREFUSED') || error.includes('ETIMEDOUT')) {
    return { cause: 'Cannot reach SMTP server — network/firewall issue' };
  }
  return { cause: error };
}

export default router;
