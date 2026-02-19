import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { query } from './database.js';

// ─── Singleton transporter ──────────────────────────────────
let transporter = null;

/**
 * Get or create the Nodemailer transporter.
 * Handles Office 365, Gmail, and generic SMTP.
 */
function getTransporter() {
  if (transporter) return transporter;

  const { host, port, user, pass, secure, tls } = config.smtp;

  if (!user || !pass) {
    console.warn('⚠️  Email not configured — no EMAIL_USER / EMAIL_PASS in .env');
    return null;
  }

  const opts = {
    host,
    port,
    secure,                         // true for 465, false for 587
    auth: { user, pass },
    // Connection timeouts
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  };

  // Office 365 / Outlook needs STARTTLS on port 587
  if (tls && !secure) {
    opts.requireTLS = true;
    opts.tls = {
      ciphers: 'SSLv3',
      rejectUnauthorized: false,    // Allow self-signed in dev
    };
  }

  transporter = nodemailer.createTransport(opts);

  // Verify connection on first creation
  transporter.verify()
    .then(() => console.log('✅ Email transporter verified — ready to send'))
    .catch((err) => {
      console.error('❌ Email transporter verification failed:', err.message);
      if (err.message.includes('535') || err.message.includes('Authentication')) {
        console.error('   💡 FIX: Enable "Authenticated SMTP" in Microsoft 365 Admin Center:');
        console.error('      1. Go to admin.microsoft.com → Users → Active users');
        console.error('      2. Select the noreply@trasealla.com user');
        console.error('      3. Mail tab → Manage email apps → Enable "Authenticated SMTP"');
        console.error('      4. If MFA is on, create an App Password instead');
      }
    });

  return transporter;
}

/**
 * Get the "From" display name for a tenant.
 * Falls back to: tenant.name → EMAIL_NAME env → "Trasealla Solutions"
 */
async function getFromName(tenantId) {
  if (tenantId) {
    try {
      const rows = await query(
        'SELECT name, settings FROM tenants WHERE id = ?',
        [tenantId]
      );
      if (rows.length > 0) {
        // Check if tenant has a custom business name in settings
        let settings = {};
        try {
          settings = rows[0].settings
            ? (typeof rows[0].settings === 'string' ? JSON.parse(rows[0].settings) : rows[0].settings)
            : {};
        } catch (e) { /* ignore */ }

        if (settings.company_name) return settings.company_name;
        if (rows[0].name) return rows[0].name;
      }
    } catch (e) { /* ignore, use fallback */ }
  }
  return config.smtp.fromName || 'Trasealla Solutions';
}

/**
 * Send an email.
 *
 * @param {Object} opts
 * @param {string} opts.to          – Recipient email
 * @param {string} opts.subject     – Email subject
 * @param {string} opts.html        – HTML body
 * @param {string} [opts.text]      – Plain-text body (auto-generated from html if omitted)
 * @param {number} [opts.tenantId]  – Tenant ID for dynamic "From" name
 * @param {string} [opts.fromName]  – Override "From" display name
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendEmail({ to, subject, html, text, tenantId, fromName }) {
  const transport = getTransporter();
  if (!transport) {
    console.log(`📧 EMAIL (not configured — dev mode):\n   To: ${to}\n   Subject: ${subject}\n`);
    return { success: false, error: 'Email not configured (no SMTP credentials)' };
  }

  const displayName = fromName || await getFromName(tenantId);
  const fromAddress = config.smtp.from || config.smtp.user;

  try {
    const info = await transport.sendMail({
      from: `"${displayName}" <${fromAddress}>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ''),   // strip HTML for plain text fallback
    });

    console.log(`✅ Email sent to ${to} (messageId: ${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`❌ Failed to send email to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send a staff invite email with a beautiful branded template.
 *
 * @param {Object} member       – { email, full_name, role }
 * @param {string} inviteToken  – Invite token
 * @param {number} tenantId     – Tenant ID for dynamic branding
 * @param {string} [tenantName] – Explicit override for tenant name
 * @returns {Promise<boolean|'dev'>}
 */
export async function sendInviteEmail(member, inviteToken, tenantId, tenantName) {
  const displayName = tenantName || await getFromName(tenantId);
  const inviteUrl = `${config.frontendUrl}/set-password?token=${inviteToken}`;

  const html = `
    <div style="max-width:520px;margin:0 auto;font-family:'Segoe UI',Arial,sans-serif;">
      <div style="background:#f2421b;padding:30px;text-align:center;border-radius:12px 12px 0 0;">
        <h1 style="color:#fff;margin:0;font-size:24px;">Welcome to the Team! 🎉</h1>
      </div>
      <div style="background:#fff;padding:30px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;">
        <p style="color:#333;font-size:16px;">Hi <strong>${member.full_name || 'there'}</strong>,</p>
        <p style="color:#555;font-size:14px;line-height:1.6;">
          You've been invited to join <strong>${displayName}</strong> as a
          <strong style="color:#f2421b;">${member.role || 'team member'}</strong>.
        </p>
        <p style="color:#555;font-size:14px;line-height:1.6;">
          Click the button below to set your password and activate your account:
        </p>
        <div style="text-align:center;margin:30px 0;">
          <a href="${inviteUrl}"
             style="background:#f2421b;color:#fff;padding:14px 36px;border-radius:8px;
                    text-decoration:none;font-weight:bold;font-size:16px;display:inline-block;
                    box-shadow:0 4px 12px rgba(242,66,27,0.3);">
            Set Your Password
          </a>
        </div>
        <p style="color:#aaa;font-size:12px;line-height:1.4;">
          This link expires in <strong>7 days</strong>.
          If you didn't expect this invite, please ignore this email.
        </p>
        <hr style="border:none;border-top:1px solid #f0f0f0;margin:24px 0;" />
        <p style="color:#bbb;font-size:11px;text-align:center;">
          Powered by <a href="https://trasealla.com" style="color:#f2421b;text-decoration:none;">Trasealla</a>
        </p>
      </div>
    </div>
  `;

  const result = await sendEmail({
    to: member.email,
    subject: `You're invited to join ${displayName}!`,
    html,
    tenantId,
    fromName: displayName,
  });

  if (result.success) return true;

  // If email is not configured, log the link for development
  if (result.error === 'Email not configured (no SMTP credentials)') {
    console.log(`\n📧 INVITE EMAIL (dev mode):\n   To: ${member.email}\n   Link: ${inviteUrl}\n`);
    return 'dev';
  }

  return false;
}

/**
 * Send a generic notification email (appointment confirmations, reminders, etc.)
 */
export async function sendNotificationEmail({ to, subject, title, body, ctaText, ctaUrl, tenantId }) {
  const displayName = await getFromName(tenantId);

  const html = `
    <div style="max-width:520px;margin:0 auto;font-family:'Segoe UI',Arial,sans-serif;">
      <div style="background:#f2421b;padding:24px;text-align:center;border-radius:12px 12px 0 0;">
        <h1 style="color:#fff;margin:0;font-size:22px;">${title || subject}</h1>
      </div>
      <div style="background:#fff;padding:28px;border:1px solid #eee;border-top:none;border-radius:0 0 12px 12px;">
        <div style="color:#555;font-size:14px;line-height:1.7;">${body}</div>
        ${ctaText && ctaUrl ? `
          <div style="text-align:center;margin:28px 0;">
            <a href="${ctaUrl}"
               style="background:#f2421b;color:#fff;padding:12px 28px;border-radius:8px;
                      text-decoration:none;font-weight:bold;font-size:15px;display:inline-block;">
              ${ctaText}
            </a>
          </div>
        ` : ''}
        <hr style="border:none;border-top:1px solid #f0f0f0;margin:24px 0;" />
        <p style="color:#bbb;font-size:11px;text-align:center;">
          ${displayName} · Powered by <a href="https://trasealla.com" style="color:#f2421b;text-decoration:none;">Trasealla</a>
        </p>
      </div>
    </div>
  `;

  return sendEmail({ to, subject, html, tenantId, fromName: displayName });
}

export default { sendEmail, sendInviteEmail, sendNotificationEmail };
