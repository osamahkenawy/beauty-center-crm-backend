/**
 * Billing Cron Jobs
 * Runs daily to handle:
 *   1. Trial expiration → suspend tenants 1 day after trial ends
 *   2. Past-due grace expiration → suspend tenants after 3-day grace
 *   3. Send trial expiry reminder emails (3 days, 1 day before)
 */
import { query, execute } from '../lib/database.js';
import { sendNotificationEmail } from '../lib/email.js';

// ─── 1. Expire trials ─────────────────────────────────────────
// Finds tenants whose trial ended more than 1 day ago and suspends them
export async function expireTrials() {
  try {
    const expired = await query(`
      SELECT id, name, email, trial_ends_at
      FROM tenants
      WHERE status = 'trial'
        AND trial_ends_at IS NOT NULL
        AND trial_ends_at < DATE_SUB(NOW(), INTERVAL 1 DAY)
        AND (plan IS NULL OR plan = 'trial')
    `);

    if (expired.length === 0) return { suspended: 0 };

    for (const tenant of expired) {
      await execute(
        `UPDATE tenants SET status = 'suspended', updated_at = NOW() WHERE id = ?`,
        [tenant.id]
      );

      // Send lockout notification email
      try {
        await sendNotificationEmail({
          to: tenant.email,
          subject: 'Your Trasealla CRM trial has expired',
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
              <div style="background:linear-gradient(135deg,#244066,#1a3050);padding:32px;border-radius:12px 12px 0 0;text-align:center">
                <h1 style="color:#fff;margin:0;font-size:22px">Trial Period Ended</h1>
              </div>
              <div style="padding:28px;background:#fff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 12px 12px">
                <p>Dear <strong>${tenant.name}</strong>,</p>
                <p>Your 14-day free trial has ended. Your account has been temporarily suspended.</p>
                <p>To continue using Trasealla CRM, please choose a subscription plan:</p>
                <div style="text-align:center;margin:24px 0">
                  <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/billing"
                     style="display:inline-block;background:#244066;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">
                    Choose a Plan & Subscribe
                  </a>
                </div>
                <p style="color:#6b7280;font-size:13px">Your data is safe and will be available once you subscribe.</p>
              </div>
            </div>
          `
        });
      } catch (emailErr) {
        console.error(`[Billing Cron] Failed to send trial expiry email to ${tenant.email}:`, emailErr.message);
      }
    }

    console.log(`[Billing Cron] Suspended ${expired.length} trial-expired tenants`);
    return { suspended: expired.length, tenants: expired.map(t => t.name) };
  } catch (error) {
    console.error('[Billing Cron] expireTrials error:', error);
    return { error: error.message };
  }
}

// ─── 2. Expire past-due grace periods ─────────────────────────
// Finds tenants whose grace period ended and suspends them
export async function expirePastDueGrace() {
  try {
    const pastDue = await query(`
      SELECT id, name, email
      FROM tenants
      WHERE subscription_status = 'past_due'
        AND grace_period_ends_at IS NOT NULL
        AND grace_period_ends_at < NOW()
        AND status != 'suspended'
    `);

    if (pastDue.length === 0) return { suspended: 0 };

    for (const tenant of pastDue) {
      await execute(
        `UPDATE tenants SET status = 'suspended', updated_at = NOW() WHERE id = ?`,
        [tenant.id]
      );

      try {
        await sendNotificationEmail({
          to: tenant.email,
          subject: 'Urgent: Your Trasealla CRM account has been suspended',
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
              <div style="background:linear-gradient(135deg,#dc2626,#991b1b);padding:32px;border-radius:12px 12px 0 0;text-align:center">
                <h1 style="color:#fff;margin:0;font-size:22px">Account Suspended</h1>
              </div>
              <div style="padding:28px;background:#fff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 12px 12px">
                <p>Dear <strong>${tenant.name}</strong>,</p>
                <p>Your subscription payment has not been received and the 3-day grace period has ended. Your account has been suspended.</p>
                <p>Please update your payment method immediately to restore access:</p>
                <div style="text-align:center;margin:24px 0">
                  <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/billing"
                     style="display:inline-block;background:#dc2626;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">
                    Update Payment Method
                  </a>
                </div>
                <p style="color:#6b7280;font-size:13px">Your data is safe and will be available once payment is resolved.</p>
              </div>
            </div>
          `
        });
      } catch (emailErr) {
        console.error(`[Billing Cron] Failed to send suspension email to ${tenant.email}:`, emailErr.message);
      }
    }

    console.log(`[Billing Cron] Suspended ${pastDue.length} past-due grace-expired tenants`);
    return { suspended: pastDue.length };
  } catch (error) {
    console.error('[Billing Cron] expirePastDueGrace error:', error);
    return { error: error.message };
  }
}

// ─── 3. Send trial reminder emails ────────────────────────────
// 3 days before and 1 day before trial expiry
export async function sendTrialReminders() {
  try {
    // 3 days before expiry
    const threeDayWarning = await query(`
      SELECT id, name, email, trial_ends_at
      FROM tenants
      WHERE status = 'trial'
        AND trial_ends_at IS NOT NULL
        AND DATE(trial_ends_at) = DATE(DATE_ADD(NOW(), INTERVAL 3 DAY))
        AND (plan IS NULL OR plan = 'trial')
    `);

    // 1 day before expiry
    const oneDayWarning = await query(`
      SELECT id, name, email, trial_ends_at
      FROM tenants
      WHERE status = 'trial'
        AND trial_ends_at IS NOT NULL
        AND DATE(trial_ends_at) = DATE(DATE_ADD(NOW(), INTERVAL 1 DAY))
        AND (plan IS NULL OR plan = 'trial')
    `);

    let sent = 0;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    for (const tenant of threeDayWarning) {
      try {
        await sendNotificationEmail({
          to: tenant.email,
          subject: '3 days left on your Trasealla CRM trial',
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
              <div style="background:linear-gradient(135deg,#d97706,#b45309);padding:28px;border-radius:12px 12px 0 0;text-align:center">
                <h1 style="color:#fff;margin:0;font-size:20px">⏰ 3 Days Remaining</h1>
              </div>
              <div style="padding:28px;background:#fff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 12px 12px">
                <p>Hi <strong>${tenant.name}</strong>,</p>
                <p>Your free trial expires in <strong>3 days</strong>. Upgrade now to keep your data and avoid any interruption.</p>
                <div style="text-align:center;margin:20px 0">
                  <a href="${frontendUrl}/billing" style="display:inline-block;background:#244066;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">
                    Upgrade Now
                  </a>
                </div>
              </div>
            </div>
          `
        });
        sent++;
      } catch (e) { /* skip */ }
    }

    for (const tenant of oneDayWarning) {
      try {
        await sendNotificationEmail({
          to: tenant.email,
          subject: 'LAST DAY — Your Trasealla CRM trial expires tomorrow',
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
              <div style="background:linear-gradient(135deg,#dc2626,#991b1b);padding:28px;border-radius:12px 12px 0 0;text-align:center">
                <h1 style="color:#fff;margin:0;font-size:20px">⚠️ Trial Expires Tomorrow!</h1>
              </div>
              <div style="padding:28px;background:#fff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 12px 12px">
                <p>Hi <strong>${tenant.name}</strong>,</p>
                <p>Your free trial expires <strong>tomorrow</strong>. After that, your account will be locked until you subscribe.</p>
                <p style="color:#dc2626;font-weight:700">Don't lose access to your data — upgrade now!</p>
                <div style="text-align:center;margin:20px 0">
                  <a href="${frontendUrl}/billing" style="display:inline-block;background:#dc2626;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">
                    Upgrade Now — Keep Your Data
                  </a>
                </div>
              </div>
            </div>
          `
        });
        sent++;
      } catch (e) { /* skip */ }
    }

    if (sent > 0) console.log(`[Billing Cron] Sent ${sent} trial reminder emails`);
    return { sent, threeDay: threeDayWarning.length, oneDay: oneDayWarning.length };
  } catch (error) {
    console.error('[Billing Cron] sendTrialReminders error:', error);
    return { error: error.message };
  }
}

// ─── Master function — run all billing jobs ───────────────────
export async function runBillingCron() {
  console.log('[Billing Cron] Running daily billing checks...');
  const results = {
    trialExpiry: await expireTrials(),
    pastDueGrace: await expirePastDueGrace(),
    reminders: await sendTrialReminders(),
    timestamp: new Date().toISOString(),
  };
  console.log('[Billing Cron] Complete:', JSON.stringify(results));
  return results;
}
