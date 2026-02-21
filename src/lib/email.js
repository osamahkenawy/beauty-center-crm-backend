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
      if (err.code === 'EAUTH' || err.message.includes('535') || err.message.includes('Authentication')) {
        console.error('\n═══════════════════════════════════════════════════════════');
        console.error('  EMAIL AUTH FAILED — noreply@trasealla.com cannot log in');
        console.error('═══════════════════════════════════════════════════════════');
        console.error('  Most likely cause: SMTP AUTH is disabled in Microsoft 365');
        console.error('\n  To fix — Microsoft 365 Admin Center steps:');
        console.error('  1. Go to https://admin.microsoft.com');
        console.error('  2. Users → Active users → noreply@trasealla.com');
        console.error('  3. Click "Mail" tab → "Manage email apps"');
        console.error('  4. Enable "Authenticated SMTP" checkbox → Save');
        console.error('\n  OR if MFA/Modern Auth is enabled:');
        console.error('  1. Sign in as noreply@trasealla.com at account.microsoft.com');
        console.error('  2. Security → Advanced security options → App passwords');
        console.error('  3. Create an App Password → put it in EMAIL_PASS in .env');
        console.error('\n  OR enable via PowerShell (fastest):');
        console.error('  Set-CASMailbox -Identity noreply@trasealla.com -SmtpClientAuthenticationDisabled $false');
        console.error('═══════════════════════════════════════════════════════════\n');
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        console.error('  💡 Network issue — cannot reach smtp.office365.com:587');
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
      const rows = await query('SELECT name, settings FROM tenants WHERE id = ?', [tenantId]);
      if (rows.length > 0) {
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
 * Get tenant branding (name + logo URL).
 * For system emails (no tenantId), returns Trasealla Solutions branding.
 */
async function getTenantBranding(tenantId) {
  const systemLogoUrl = `${config.frontendUrl}/assets/images/logos/trasealla-solutions-logo.png`;
  if (tenantId) {
    try {
      const rows = await query('SELECT name, logo_url, settings FROM tenants WHERE id = ?', [tenantId]);
      if (rows.length > 0) {
        let settings = {};
        try {
          settings = rows[0].settings
            ? (typeof rows[0].settings === 'string' ? JSON.parse(rows[0].settings) : rows[0].settings)
            : {};
        } catch (e) { /* ignore */ }
        const name = settings.company_name || rows[0].name || 'Trasealla Solutions';
        const logoUrl = rows[0].logo_url || systemLogoUrl;
        return { name, logoUrl, isSystem: false };
      }
    } catch (e) { /* ignore */ }
  }
  return { name: 'Trasealla Solutions', logoUrl: systemLogoUrl, isSystem: true };
}

/**
 * Build a branded HTML email.
 *
 * @param {Object} opts
 * @param {string}  opts.logoUrl      – URL of the logo image
 * @param {string}  opts.logoAlt      – Alt text for logo
 * @param {string}  opts.accentColor  – Top accent bar color (default: #f2421b)
 * @param {string}  opts.title        – Card heading
 * @param {string}  opts.subtitle     – Small subtitle under heading (optional)
 * @param {string}  opts.bodyHtml     – Main body HTML (injected as-is)
 * @param {string}  opts.ctaText      – CTA button label (optional)
 * @param {string}  opts.ctaUrl       – CTA button link (optional)
 * @param {string}  opts.copyLink     – "Or copy this link" value (optional)
 * @param {string}  opts.expiryNote   – Expiry note text e.g. "1 hour" (optional)
 * @param {string}  opts.footerName   – Name shown in footer
 * @param {boolean} opts.isSystem     – If true, footer says "Trasealla Solutions"; else "footerName · Powered by Trasealla"
 */
function buildEmailTemplate({
  logoUrl, logoAlt = 'Logo', accentColor = '#1c2f4e',
  title, subtitle, bodyHtml,
  ctaText, ctaUrl, copyLink, expiryNote,
  footerName = 'Trasealla Solutions', isSystem = true,
}) {
  const logoBlock = `
    <table cellpadding="0" cellspacing="0" style="display:inline-table;">
      <tr>
        <td style="background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;
                   box-shadow:0 2px 12px rgba(0,0,0,0.08);padding:14px 28px;text-align:center;">
          <img src="${logoUrl}" alt="${logoAlt}" height="44"
               style="display:block;height:44px;width:auto;max-width:220px;" />
        </td>
      </tr>
    </table>`;

  const ctaBlock = ctaText && ctaUrl ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
      <tr>
        <td align="center">
          <a href="${ctaUrl}"
             style="display:inline-block;background-color:${accentColor};color:#ffffff !important;
                    text-decoration:none;padding:15px 44px;border-radius:10px;
                    font-size:15px;font-weight:700;letter-spacing:0.02em;
                    font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
            &#8594;&nbsp; ${ctaText}
          </a>
        </td>
      </tr>
    </table>` : '';

  const copyLinkBlock = copyLink ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
      <tr>
        <td style="background:#f8fafc;border:1px solid #e9edf2;border-radius:10px;padding:14px 18px;">
          <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;">Or copy this link</p>
          <p style="margin:0;font-size:12px;color:#475569;word-break:break-all;font-family:'Courier New',monospace;line-height:1.6;">${copyLink}</p>
        </td>
      </tr>
    </table>` : '';

  const expiryBlock = expiryNote ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
      <tr>
        <td style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;">
          <p style="margin:0;font-size:13px;color:#92400e;">
            &#9203; This link expires in <strong>${expiryNote}</strong>.
          </p>
        </td>
      </tr>
    </table>` : '';

  const footerHtml = isSystem
    ? `Trasealla Solutions &nbsp;&bull;&nbsp; <a href="https://trasealla.com" style="color:#f2421b;text-decoration:none;font-weight:500;">trasealla.com</a>`
    : `${footerName} &nbsp;&bull;&nbsp; Powered by <a href="https://trasealla.com" style="color:#f2421b;text-decoration:none;font-weight:500;">Trasealla</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 16px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">

        <!-- Logo -->
        <tr><td align="center" style="padding:0 0 28px;">${logoBlock}</td></tr>

        <!-- Card -->
        <tr>
          <td style="background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;
                     box-shadow:0 4px 24px rgba(0,0,0,0.06);overflow:hidden;">

            <!-- Top accent bar -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="background-color:${accentColor};height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>
            </table>

            <!-- Body -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:40px 40px 32px;">
                  <h1 style="margin:0 0 ${subtitle ? '8' : '28'}px;font-size:22px;font-weight:700;color:#111827;">${title}</h1>
                  ${subtitle ? `<p style="margin:0 0 28px;font-size:14px;color:#6b7280;">${subtitle}</p>` : ''}
                  <div style="font-size:14px;color:#6b7280;line-height:1.75;">${bodyHtml}</div>
                  ${ctaBlock}
                  ${copyLinkBlock}
                  ${expiryBlock}
                </td>
              </tr>
            </table>

            <!-- Footer -->
            <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #f1f5f9;">
              <tr>
                <td style="padding:20px 40px;text-align:center;">
                  <p style="margin:0;font-size:12px;color:#9ca3af;">${footerHtml}</p>
                </td>
              </tr>
            </table>

          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
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
export async function sendEmail({ to, subject, html, text, tenantId, fromName, attachments }) {
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
      attachments: Array.isArray(attachments) ? attachments : undefined,
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
 */
export async function sendInviteEmail(member, inviteToken, tenantId, tenantName) {
  const branding = await getTenantBranding(tenantId);
  const displayName = tenantName || branding.name;
  const inviteUrl = `${config.frontendUrl}/set-password?token=${inviteToken}`;

  const html = buildEmailTemplate({
    logoUrl: branding.logoUrl,
    logoAlt: displayName,
    accentColor: '#1c2f4e',
    title: 'Welcome to the Team!',
    subtitle: `You have been invited to join ${displayName}`,
    bodyHtml: `
      <p style="margin:0 0 12px;font-size:15px;color:#374151;line-height:1.6;">
        Hi <strong style="color:#111827;">${member.full_name || 'there'}</strong>,
      </p>
      <p style="margin:0 0 32px;color:#6b7280;line-height:1.75;">
        You have been invited to join <strong style="color:#111827;">${displayName}</strong> as a
        <strong style="color:#1c2f4e;">${member.role || 'team member'}</strong>.
        Click the button below to set your password and activate your account.
      </p>`,
    ctaText: 'Set Your Password',
    ctaUrl: inviteUrl,
    expiryNote: '7 days',
    footerName: displayName,
    isSystem: branding.isSystem,
  });

  const result = await sendEmail({
    to: member.email,
    subject: `You're invited to join ${displayName}!`,
    html,
    tenantId,
    fromName: displayName,
  });

  if (result.success) return true;
  if (result.error === 'Email not configured (no SMTP credentials)') {
    console.log(`\n📧 INVITE EMAIL (dev mode):\n   To: ${member.email}\n   Link: ${inviteUrl}\n`);
    return 'dev';
  }
  return false;
}

/**
 * Send a generic notification email (appointment confirmations, reminders, etc.)
 */
export async function sendNotificationEmail({ to, subject, title, body, ctaText, ctaUrl, tenantId, attachments }) {
  const branding = await getTenantBranding(tenantId);

  const html = buildEmailTemplate({
    logoUrl: branding.logoUrl,
    logoAlt: branding.name,
    accentColor: '#1c2f4e',
    title: title || subject,
    bodyHtml: `<div style="color:#6b7280;line-height:1.75;">${body}</div>`,
    ctaText,
    ctaUrl,
    footerName: branding.name,
    isSystem: branding.isSystem,
  });

  return sendEmail({ to, subject, html, tenantId, fromName: branding.name, attachments });
}

export { buildEmailTemplate, getTenantBranding };
export default { sendEmail, sendInviteEmail, sendNotificationEmail, buildEmailTemplate, getTenantBranding };
