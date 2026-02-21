import { query, execute } from './database.js';
import { sendEmail, sendNotificationEmail } from './email.js';
import { notify } from './notify.js';

/**
 * Reminder Service
 * Handles scheduling, sending, and tracking appointment reminders
 */

// ─── Reminder Timing Configurations ────────────────────────────────
const REMINDER_TIMINGS = {
  '24h': 24 * 60 * 60 * 1000,  // 24 hours in milliseconds
  '2h': 2 * 60 * 60 * 1000,    // 2 hours
  '30m': 30 * 60 * 1000,       // 30 minutes
};

const RETRY_BACKOFF_MINUTES = [5, 15, 60];

/**
 * Calculate send_at time for a reminder based on appointment start_time
 * @param {Date|string} appointmentStart - Appointment start time
 * @param {string} timing - '24h', '2h', or '30m'
 * @returns {Date} - Calculated send_at time
 */
function calculateSendAt(appointmentStart, timing) {
  const start = new Date(appointmentStart);
  let ms = REMINDER_TIMINGS[timing];

  if (ms === undefined && typeof timing === 'number' && Number.isFinite(timing)) {
    ms = timing * 60 * 60 * 1000;
  }

  if (ms === undefined && typeof timing === 'string') {
    const hMatch = timing.match(/^(\d+(?:\.\d+)?)h$/i);
    const mMatch = timing.match(/^(\d+(?:\.\d+)?)m$/i);
    if (hMatch) ms = Number(hMatch[1]) * 60 * 60 * 1000;
    if (mMatch) ms = Number(mMatch[1]) * 60 * 1000;
  }

  if (ms === undefined) ms = REMINDER_TIMINGS['24h'];
  return new Date(start.getTime() - ms);
}

function parseTimingOptions(setting) {
  const defaultUpcomingTimings = [24, 2, 0.5];

  try {
    if (setting?.timing_options) {
      const parsed = typeof setting.timing_options === 'string'
        ? JSON.parse(setting.timing_options)
        : setting.timing_options;

      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
          .map(Number)
          .filter(hours => Number.isFinite(hours) && hours >= 0)
          .sort((a, b) => b - a);
      }
    }
  } catch (error) {
    // Ignore malformed timing_options and fallback
  }

  const hours = Number(setting?.hours_before);
  if (Number.isFinite(hours) && hours >= 0) return [hours];

  if (setting?.reminder_type === 'appointment_upcoming') {
    return defaultUpcomingTimings;
  }

  return [24];
}

function getTimingLabelFromHours(hours) {
  if (hours >= 1) return `${Math.round(hours)}h`;
  const minutes = Math.round(hours * 60);
  return `${minutes}m`;
}

function getNextRetryAt(retryCount) {
  const minutes = RETRY_BACKOFF_MINUTES[Math.min(retryCount - 1, RETRY_BACKOFF_MINUTES.length - 1)];
  return new Date(Date.now() + minutes * 60 * 1000);
}

async function markReminderFailed(reminderId, retryCount, errorMessage) {
  const status = retryCount >= 3 ? 'failed' : 'pending';
  const nextRetryAt = status === 'pending' ? getNextRetryAt(retryCount) : null;

  await execute(
    `UPDATE appointment_reminders
     SET retry_count = ?, status = ?, next_retry_at = ?, last_error_at = NOW(), error_message = ?
     WHERE id = ?`,
    [retryCount, status, toMySQLDateTime(nextRetryAt), errorMessage || 'Unknown error', reminderId]
  );
}

/**
 * Convert Date to MySQL DATETIME format
 */
function toMySQLDateTime(date) {
  if (!date) return null;
  const d = new Date(date);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Schedule reminders for an appointment
 * Creates reminder records based on tenant's reminder settings
 * 
 * @param {number} tenantId - Tenant ID
 * @param {number} appointmentId - Appointment ID
 * @param {Date|string} appointmentStart - Appointment start time
 * @param {number} customerId - Customer ID
 */
export async function scheduleAppointmentReminders(tenantId, appointmentId, appointmentStart, customerId) {
  try {
    // Get reminder settings for this tenant
    const settings = await query(
      `SELECT * FROM reminder_settings 
       WHERE tenant_id = ? AND reminder_type = 'appointment_upcoming' AND is_enabled = 1`,
      [tenantId]
    );
    
    if (!settings || settings.length === 0) {
      // No settings: create 24h / 2h / 30m email reminders by default
      const fallbackTimings = ['24h', '2h', '30m'];
      for (const timing of fallbackTimings) {
        const sendAt = calculateSendAt(appointmentStart, timing);
        await execute(
          `INSERT INTO appointment_reminders
           (tenant_id, appointment_id, reminder_type, send_at, method, status)
           VALUES (?, ?, 'appointment_upcoming', ?, 'email', 'pending')`,
          [tenantId, appointmentId, toMySQLDateTime(sendAt)]
        );
      }
      return;
    }
    
    const setting = settings[0];
    const channels = typeof setting.channels === 'string' 
      ? JSON.parse(setting.channels) 
      : setting.channels || ['email'];
    
    const timingOptions = parseTimingOptions(setting);

    // Create reminder for each timing + enabled channel
    for (const timingHours of timingOptions) {
      const timingLabel = getTimingLabelFromHours(timingHours);
      const sendAt = calculateSendAt(appointmentStart, timingLabel);

      for (const channel of channels) {
        if (channel === 'in_app') {
          // In-app notifications are handled separately via notify.js
          continue;
        }

        if (channel === 'sms') {
          // SMS is intentionally disabled for now
          continue;
        }

        await execute(
          `INSERT INTO appointment_reminders
           (tenant_id, appointment_id, reminder_type, send_at, method, status)
           VALUES (?, ?, 'appointment_upcoming', ?, ?, 'pending')`,
          [tenantId, appointmentId, toMySQLDateTime(sendAt), channel]
        );
      }
    }
    
    // Also create in-app notification if enabled
    if (channels.includes('in_app')) {
      await notify({
        tenantId,
        userId: null, // Will be linked to customer later if needed
        type: 'reminder',
        category: 'reminder',
        title: setting.template_subject || 'Appointment Reminder',
        message: setting.template_body || 'Your appointment is coming up soon.',
        data: {
          appointment_id: appointmentId,
          customer_id: customerId,
          reminder_type: 'appointment_upcoming',
        },
        icon: 'calendar',
      });
    }
    
  } catch (error) {
    console.error('Error scheduling reminders:', error);
    // Don't throw - reminder scheduling shouldn't break appointment creation
  }
}

/**
 * Get appointment details with customer and service info
 */
async function getAppointmentDetails(appointmentId) {
  const appointments = await query(
    `SELECT 
      a.*,
      c.first_name, c.last_name, c.email, c.phone,
      p.name as service_name, p.duration,
      s.full_name as staff_name,
      t.name as tenant_name, t.settings as tenant_settings
    FROM appointments a
    LEFT JOIN contacts c ON a.customer_id = c.id
    LEFT JOIN products p ON a.service_id = p.id
    LEFT JOIN staff s ON a.staff_id = s.id
    LEFT JOIN tenants t ON a.tenant_id = t.id
    WHERE a.id = ?`,
    [appointmentId]
  );
  
  return appointments[0] || null;
}

/**
 * Replace placeholders in template with actual values
 */
function replacePlaceholders(template, data) {
  if (!template) return '';
  
  let result = template;
  const placeholders = {
    '{client_name}': data.clientName || data.customerName || 'Valued Client',
    '{first_name}': data.firstName || data.clientName?.split(' ')[0] || 'Valued Client',
    '{customer_name}': data.clientName || data.customerName || 'Valued Client',
    '{service_name}': data.serviceName || 'your service',
    '{appointment_date}': data.appointmentDate || '',
    '{appointment_time}': data.appointmentTime || '',
    '{staff_name}': data.staffName || 'our team',
    '{business_name}': data.businessName || 'our business',
    '{company_name}': data.businessName || 'our business',
    '{hours}': data.hours || '24',
    '{days}': data.days || '7',
  };
  
  for (const [placeholder, value] of Object.entries(placeholders)) {
    result = result.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'gi'), value);
  }
  
  return result;
}

/**
 * Send a single reminder (email or SMS)
 * 
 * @param {Object} reminder - Reminder record from database
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function sendReminder(reminder) {
  try {
    const appointment = await getAppointmentDetails(reminder.appointment_id);
    
    if (!appointment) {
      return { success: false, error: 'Appointment not found' };
    }
    
    // Check if appointment is still valid (not cancelled, not completed)
    if (appointment.status === 'cancelled' || appointment.status === 'completed' || appointment.status === 'no_show') {
      // Mark reminder as cancelled
      await execute(
        `UPDATE appointment_reminders SET status = 'sent', error_message = 'Appointment cancelled or completed' 
         WHERE id = ?`,
        [reminder.id]
      );
      return { success: true, skipped: true };
    }
    
    // Get reminder settings for template
    const settings = await query(
      `SELECT * FROM reminder_settings 
       WHERE tenant_id = ? AND reminder_type = ? LIMIT 1`,
      [reminder.tenant_id, reminder.reminder_type]
    );
    
    const setting = settings[0] || {};
    const subject = setting.template_subject || 'Appointment Reminder';
    const body = setting.template_body || 'Your appointment is coming up soon.';
    
    // Format appointment date/time
    const appointmentDate = new Date(appointment.start_time);
    const dateStr = appointmentDate.toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    const timeStr = appointmentDate.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    });
    
    const clientName = `${appointment.first_name || ''} ${appointment.last_name || ''}`.trim() || 'Valued Client';
    const staffName = appointment.staff_name || 'our team';
    
    // Get business name from tenant settings
    let businessName = appointment.tenant_name || 'our business';
    try {
      if (appointment.tenant_settings) {
        const settings = typeof appointment.tenant_settings === 'string' 
          ? JSON.parse(appointment.tenant_settings) 
          : appointment.tenant_settings;
        if (settings.company_name) {
          businessName = settings.company_name;
        }
      }
    } catch (e) {
      // Ignore
    }
    
    const templateData = {
      clientName,
      customerName: clientName,
      firstName: appointment.first_name || clientName.split(' ')[0],
      serviceName: appointment.service_name || 'your service',
      appointmentDate: dateStr,
      appointmentTime: timeStr,
      staffName,
      businessName,
      companyName: businessName,
      hours: '24',
      days: '7',
    };
    
    const finalSubject = replacePlaceholders(subject, templateData);
    const finalBody = replacePlaceholders(body, templateData);
    
    // Send based on method
    if (reminder.method === 'email') {
      if (!appointment.email) {
        return { success: false, error: 'Customer email not found' };
      }
      
      const result = await sendNotificationEmail({
        to: appointment.email,
        subject: finalSubject,
        title: finalSubject,
        body: finalBody.replace(/\n/g, '<br>'),
        tenantId: reminder.tenant_id,
      });
      
      if (result.success) {
        await execute(
          `UPDATE appointment_reminders 
           SET status = 'sent', sent_at = NOW(), error_message = NULL 
           WHERE id = ?`,
          [reminder.id]
        );
        return { success: true };
      } else {
        const newRetryCount = (reminder.retry_count || 0) + 1;
        await markReminderFailed(reminder.id, newRetryCount, result.error || 'Failed to send email');
        return { success: false, error: result.error };
      }
      
    } else if (reminder.method === 'sms') {
      await execute(
        `UPDATE appointment_reminders
         SET status = 'sent', sent_at = NOW(), error_message = 'SMS disabled'
         WHERE id = ?`,
        [reminder.id]
      );
      return { success: true, skipped: true };
    }
    
    return { success: false, error: 'Unknown reminder method' };
    
  } catch (error) {
    console.error('Error sending reminder:', error);
    
    const newRetryCount = (reminder.retry_count || 0) + 1;
    await markReminderFailed(reminder.id, newRetryCount, error.message || 'Unknown error');
    
    return { success: false, error: error.message };
  }
}

/**
 * Process pending reminders
 * Called by cron job to send reminders that are due
 * 
 * @returns {Promise<{processed: number, sent: number, failed: number}>}
 */
export async function processPendingReminders() {
  try {
    // Get all pending reminders that are due (send_at <= now)
    const reminders = await query(
      `SELECT * FROM appointment_reminders 
       WHERE status = 'pending' 
       AND send_at <= NOW()
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())
       ORDER BY send_at ASC
       LIMIT 50`
    );
    
    if (reminders.length === 0) {
      return { processed: 0, sent: 0, failed: 0 };
    }
    
    let sent = 0;
    let failed = 0;
    
    for (const reminder of reminders) {
      const result = await sendReminder(reminder);
      if (result.success && !result.skipped) {
        sent++;
      } else if (!result.success) {
        failed++;
      }
    }
    
    return { processed: reminders.length, sent, failed };
    
  } catch (error) {
    console.error('Error processing reminders:', error);
    return { processed: 0, sent: 0, failed: 0, error: error.message };
  }
}

/**
 * Cancel/delete reminders for an appointment
 * Called when appointment is cancelled or rescheduled
 */
export async function cancelAppointmentReminders(appointmentId) {
  try {
    await execute(
      `UPDATE appointment_reminders 
       SET status = 'sent', error_message = 'Appointment cancelled' 
       WHERE appointment_id = ? AND status = 'pending'`,
      [appointmentId]
    );
  } catch (error) {
    console.error('Error cancelling reminders:', error);
  }
}

/**
 * Reschedule reminders for an appointment
 * Called when appointment time is changed
 */
export async function rescheduleAppointmentReminders(tenantId, appointmentId, newStartTime) {
  try {
    // Cancel existing pending reminders
    await cancelAppointmentReminders(appointmentId);
    
    // Get appointment to get customer_id
    const appointments = await query(
      `SELECT customer_id FROM appointments WHERE id = ?`,
      [appointmentId]
    );
    
    if (appointments.length > 0) {
      // Schedule new reminders
      await scheduleAppointmentReminders(
        tenantId,
        appointmentId,
        newStartTime,
        appointments[0].customer_id
      );
    }
  } catch (error) {
    console.error('Error rescheduling reminders:', error);
  }
}

export default {
  scheduleAppointmentReminders,
  processPendingReminders,
  cancelAppointmentReminders,
  rescheduleAppointmentReminders,
};
