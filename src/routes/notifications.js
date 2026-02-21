import { Router } from 'express';
import { execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

// ─── Ensure tables exist ────────────────────────────────────────
async function ensureTables() {
  await execute(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      user_id INT DEFAULT NULL,
      type VARCHAR(50) DEFAULT 'general',
      category VARCHAR(30) DEFAULT 'info',
      title VARCHAR(255) NOT NULL,
      message TEXT,
      data JSON,
      link VARCHAR(500) DEFAULT NULL,
      icon VARCHAR(50) DEFAULT NULL,
      is_read TINYINT(1) DEFAULT 0,
      is_archived TINYINT(1) DEFAULT 0,
      expires_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_user (user_id),
      INDEX idx_read (is_read),
      INDEX idx_type (type),
      INDEX idx_created (created_at)
    )
  `);

  // Migrate ENUM → VARCHAR if table was created with old schema
  try {
    const [col] = await execute(`SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'type'`);
    if (col && col.COLUMN_TYPE && col.COLUMN_TYPE.startsWith('enum')) {
      await execute(`ALTER TABLE notifications MODIFY COLUMN type VARCHAR(50) DEFAULT 'general'`);
    }
    const [col2] = await execute(`SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'category'`);
    if (col2 && col2.COLUMN_TYPE && col2.COLUMN_TYPE.startsWith('enum')) {
      await execute(`ALTER TABLE notifications MODIFY COLUMN category VARCHAR(30) DEFAULT 'info'`);
    }
  } catch (_) {}

  await execute(`
    CREATE TABLE IF NOT EXISTS reminder_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      reminder_type ENUM('appointment_upcoming','appointment_followup','review_request','birthday','inactive_client','payment_due','membership_expiry','package_expiry','stock_low') NOT NULL,
      is_enabled TINYINT(1) DEFAULT 1,
      hours_before INT DEFAULT 24,
      timing_options JSON DEFAULT NULL,
      channels JSON DEFAULT NULL,
      template_subject VARCHAR(255) DEFAULT NULL,
      template_body TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_tenant_type (tenant_id, reminder_type)
    )
  `);

  try {
    await execute(`ALTER TABLE reminder_settings ADD COLUMN timing_options JSON DEFAULT NULL AFTER hours_before`);
  } catch (_) {
    // Column already exists
  }

  await execute(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      user_id INT NOT NULL,
      email_enabled TINYINT(1) DEFAULT 1,
      push_enabled TINYINT(1) DEFAULT 1,
      sms_enabled TINYINT(1) DEFAULT 0,
      appointment_notifications TINYINT(1) DEFAULT 1,
      payment_notifications TINYINT(1) DEFAULT 1,
      promotion_notifications TINYINT(1) DEFAULT 1,
      review_notifications TINYINT(1) DEFAULT 1,
      inventory_notifications TINYINT(1) DEFAULT 1,
      system_notifications TINYINT(1) DEFAULT 1,
      quiet_hours_start TIME DEFAULT NULL,
      quiet_hours_end TIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_tenant_user (tenant_id, user_id)
    )
  `);
}

ensureTables().catch(err => console.error('Notification tables error:', err));

// ─── GET /notifications ─ List notifications ────────────────────
router.get('/', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id || null;
    const { type, category, is_read, page = 1, limit = 50, search } = req.query;

    let where = 'WHERE n.tenant_id = ? AND n.is_archived = 0';
    const params = [tenantId];

    // Show user-specific + broadcast (user_id IS NULL) notifications
    if (userId) {
      where += ' AND (n.user_id = ? OR n.user_id IS NULL)';
      params.push(userId);
    }

    if (type) { where += ' AND n.type = ?'; params.push(type); }
    if (category) { where += ' AND n.category = ?'; params.push(category); }
    if (is_read !== undefined && is_read !== '') {
      where += ' AND n.is_read = ?';
      params.push(Number(is_read));
    }
    if (search) {
      where += ' AND (n.title LIKE ? OR n.message LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    // Remove expired
    where += ' AND (n.expires_at IS NULL OR n.expires_at > NOW())';

    const offset = (Number(page) - 1) * Number(limit);

    const [countResult] = await execute(
      `SELECT COUNT(*) as total FROM notifications n ${where}`, params
    );

    const rows = await execute(
      `SELECT n.* FROM notifications n ${where} ORDER BY n.created_at DESC LIMIT ${Number(limit)} OFFSET ${offset}`,
      params
    );

    // Unread count
    const [unreadResult] = await execute(
      `SELECT COUNT(*) as unread FROM notifications n ${where} AND n.is_read = 0`,
      params
    );

    res.json({
      success: true,
      data: rows,
      unread_count: unreadResult?.unread || 0,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: countResult?.total || 0,
        pages: Math.ceil((countResult?.total || 0) / Number(limit))
      }
    });
  } catch (error) {
    console.error('List notifications error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /notifications/stats ─ Notification stats ──────────────
router.get('/stats', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id || null;

    let userFilter = '';
    const params = [tenantId];
    if (userId) {
      userFilter = 'AND (user_id = ? OR user_id IS NULL)';
      params.push(userId);
    }

    const [total] = await execute(
      `SELECT COUNT(*) as c FROM notifications WHERE tenant_id = ? ${userFilter} AND is_archived = 0`, params
    );
    const [unread] = await execute(
      `SELECT COUNT(*) as c FROM notifications WHERE tenant_id = ? ${userFilter} AND is_read = 0 AND is_archived = 0`, params
    );

    const byType = await execute(
      `SELECT type, COUNT(*) as count FROM notifications WHERE tenant_id = ? ${userFilter} AND is_archived = 0 GROUP BY type`, params
    );

    const byCategory = await execute(
      `SELECT category, COUNT(*) as count FROM notifications WHERE tenant_id = ? ${userFilter} AND is_archived = 0 GROUP BY category`, params
    );

    // Today's notifications
    const [today] = await execute(
      `SELECT COUNT(*) as c FROM notifications WHERE tenant_id = ? ${userFilter} AND is_archived = 0 AND DATE(created_at) = CURDATE()`, params
    );

    res.json({
      success: true,
      data: {
        total: total?.c || 0,
        unread: unread?.c || 0,
        today: today?.c || 0,
        by_type: byType,
        by_category: byCategory
      }
    });
  } catch (error) {
    console.error('Notification stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET /notifications/unread-count ─ Quick badge count ─────────
router.get('/unread-count', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id || null;

    let userFilter = '';
    const params = [tenantId];
    if (userId) {
      userFilter = 'AND (user_id = ? OR user_id IS NULL)';
      params.push(userId);
    }

    const [result] = await execute(
      `SELECT COUNT(*) as c FROM notifications WHERE tenant_id = ? ${userFilter} AND is_read = 0 AND is_archived = 0 AND (expires_at IS NULL OR expires_at > NOW())`,
      params
    );

    res.json({ success: true, count: result?.c || 0 });
  } catch (error) {
    console.error('Unread count error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /notifications ─ Create notification ──────────────────
router.post('/', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { user_id, type, category, title, message, data, link, icon, expires_at } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }

    const result = await execute(
      `INSERT INTO notifications (tenant_id, user_id, type, category, title, message, data, link, icon, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, user_id || null, type || 'general', category || 'info', title, message || null,
       data ? JSON.stringify(data) : null, link || null, icon || null, expires_at || null]
    );

    res.json({ success: true, data: { id: result.insertId }, message: 'Notification created' });
  } catch (error) {
    console.error('Create notification error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PATCH /notifications/read-all ─ Mark all as read ───────────
router.patch('/read-all', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id || null;

    let userFilter = '';
    const params = [tenantId];
    if (userId) {
      userFilter = 'AND (user_id = ? OR user_id IS NULL)';
      params.push(userId);
    }

    const result = await execute(
      `UPDATE notifications SET is_read = 1 WHERE tenant_id = ? ${userFilter} AND is_read = 0`,
      params
    );

    res.json({ success: true, message: `${result.affectedRows} notifications marked as read` });
  } catch (error) {
    console.error('Mark all read error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PATCH /notifications/:id/read ─ Mark single as read ────────
router.patch('/:id/read', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    await execute(
      'UPDATE notifications SET is_read = 1 WHERE id = ? AND tenant_id = ?',
      [req.params.id, tenantId]
    );
    res.json({ success: true, message: 'Marked as read' });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE /notifications/clear-all ─ Archive all read ──────────
router.delete('/clear-all', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id || null;

    let userFilter = '';
    const params = [tenantId];
    if (userId) {
      userFilter = 'AND (user_id = ? OR user_id IS NULL)';
      params.push(userId);
    }

    const result = await execute(
      `UPDATE notifications SET is_archived = 1 WHERE tenant_id = ? ${userFilter} AND is_read = 1`,
      params
    );

    res.json({ success: true, message: `${result.affectedRows} notifications cleared` });
  } catch (error) {
    console.error('Clear all error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE /notifications/:id ─ Archive notification ────────────
router.delete('/:id', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    await execute(
      'UPDATE notifications SET is_archived = 1 WHERE id = ? AND tenant_id = ?',
      [req.params.id, tenantId]
    );
    res.json({ success: true, message: 'Notification archived' });
  } catch (error) {
    console.error('Archive notification error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════
// REMINDER SETTINGS
// ════════════════════════════════════════════════════════════════

// ─── GET /notifications/reminders ─ Get reminder settings ───────
router.get('/reminders', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const rows = await execute(
      'SELECT * FROM reminder_settings WHERE tenant_id = ? ORDER BY reminder_type',
      [tenantId]
    );

    // If no settings exist, create defaults
    if (rows.length === 0) {
      const defaults = [
        { type: 'appointment_upcoming', hours: 24, timings: [24, 2, 0.5], channels: ['in_app','email'], subject: 'Appointment Reminder', body: 'Your appointment is coming up in {hours} hours.' },
        { type: 'appointment_followup', hours: 48, channels: ['in_app','email'], subject: 'How was your visit?', body: 'We hope you enjoyed your visit! Please leave us a review.' },
        { type: 'review_request', hours: 24, channels: ['in_app'], subject: 'Share Your Experience', body: 'Please take a moment to review your recent service.' },
        { type: 'birthday', hours: 0, channels: ['in_app','email'], subject: 'Happy Birthday! 🎂', body: 'Wishing you a wonderful birthday! Here\'s a special gift for you.' },
        { type: 'inactive_client', hours: 720, channels: ['in_app','email'], subject: 'We miss you!', body: 'It\'s been a while since your last visit. Book now and get a special discount!' },
        { type: 'payment_due', hours: 48, channels: ['in_app','email'], subject: 'Payment Reminder', body: 'You have an outstanding invoice. Please complete your payment.' },
        { type: 'membership_expiry', hours: 168, channels: ['in_app','email'], subject: 'Membership Expiring Soon', body: 'Your membership is expiring in {days} days. Renew now!' },
        { type: 'package_expiry', hours: 168, channels: ['in_app'], subject: 'Package Expiring', body: 'Your package is expiring soon. Use your remaining sessions!' },
        { type: 'stock_low', hours: 0, channels: ['in_app'], subject: 'Low Stock Alert', body: 'Product {product_name} is running low on stock.' },
      ];

      for (const d of defaults) {
        await execute(
          `INSERT INTO reminder_settings (tenant_id, reminder_type, is_enabled, hours_before, timing_options, channels, template_subject, template_body)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
          [tenantId, d.type, d.hours, d.timings ? JSON.stringify(d.timings) : null, JSON.stringify(d.channels), d.subject, d.body]
        );
      }

      const newRows = await execute(
        'SELECT * FROM reminder_settings WHERE tenant_id = ? ORDER BY reminder_type',
        [tenantId]
      );
      return res.json({ success: true, data: newRows });
    }

    // Backfill timing options for existing appointment reminder rows
    for (const row of rows) {
      if (row.reminder_type === 'appointment_upcoming' && !row.timing_options) {
        await execute(
          'UPDATE reminder_settings SET timing_options = ? WHERE id = ? AND tenant_id = ?',
          [JSON.stringify([24, 2, 0.5]), row.id, tenantId]
        );
        row.timing_options = JSON.stringify([24, 2, 0.5]);
      }
    }

    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Get reminders error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PATCH /notifications/reminders/:id ─ Update reminder ───────
router.patch('/reminders/:id', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { is_enabled, hours_before, timing_options, channels, template_subject, template_body } = req.body;

    const fields = [];
    const params = [];

    if (is_enabled !== undefined) { fields.push('is_enabled = ?'); params.push(is_enabled ? 1 : 0); }
    if (hours_before !== undefined) { fields.push('hours_before = ?'); params.push(hours_before); }
    if (timing_options !== undefined) { fields.push('timing_options = ?'); params.push(JSON.stringify(timing_options)); }
    if (channels) { fields.push('channels = ?'); params.push(JSON.stringify(channels)); }
    if (template_subject !== undefined) { fields.push('template_subject = ?'); params.push(template_subject); }
    if (template_body !== undefined) { fields.push('template_body = ?'); params.push(template_body); }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    params.push(req.params.id, tenantId);
    await execute(
      `UPDATE reminder_settings SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`,
      params
    );

    res.json({ success: true, message: 'Reminder updated' });
  } catch (error) {
    console.error('Update reminder error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════
// NOTIFICATION PREFERENCES (per user)
// ════════════════════════════════════════════════════════════════

// ─── GET /notifications/preferences ─ Get user preferences ──────
router.get('/preferences', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id || null;

    const [row] = await execute(
      'SELECT * FROM notification_preferences WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );

    if (!row) {
      // Create defaults
      await execute(
        `INSERT INTO notification_preferences (tenant_id, user_id) VALUES (?, ?)`,
        [tenantId, userId]
      );
      const [newRow] = await execute(
        'SELECT * FROM notification_preferences WHERE tenant_id = ? AND user_id = ?',
        [tenantId, userId]
      );
      return res.json({ success: true, data: newRow });
    }

    res.json({ success: true, data: row });
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PATCH /notifications/preferences ─ Update preferences ──────
router.patch('/preferences', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id || null;
    const allowed = [
      'email_enabled', 'push_enabled', 'sms_enabled',
      'appointment_notifications', 'payment_notifications',
      'promotion_notifications', 'review_notifications',
      'inventory_notifications', 'system_notifications',
      'quiet_hours_start', 'quiet_hours_end'
    ];

    const fields = [];
    const params = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(typeof req.body[key] === 'boolean' ? (req.body[key] ? 1 : 0) : req.body[key]);
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    // Upsert
    const [existing] = await execute(
      'SELECT id FROM notification_preferences WHERE tenant_id = ? AND user_id = ?',
      [tenantId, userId]
    );

    if (existing) {
      params.push(tenantId, userId);
      await execute(
        `UPDATE notification_preferences SET ${fields.join(', ')} WHERE tenant_id = ? AND user_id = ?`,
        params
      );
    } else {
      await execute(
        `INSERT INTO notification_preferences (tenant_id, user_id) VALUES (?, ?)`,
        [tenantId, userId]
      );
      params.push(tenantId, userId);
      await execute(
        `UPDATE notification_preferences SET ${fields.join(', ')} WHERE tenant_id = ? AND user_id = ?`,
        params
      );
    }

    res.json({ success: true, message: 'Preferences updated' });
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ════════════════════════════════════════════════════════════════
// AUTO-GENERATE: Check & create reminder notifications
// ════════════════════════════════════════════════════════════════

// ─── POST /notifications/test-email ─ Send test email ──
router.post('/test-email', async (req, res) => {
  try {
    const { to = 'osamaalaa133@gmail.com', subject, body } = req.body;
    const tenantId = req.tenantId;
    
    const { sendNotificationEmail } = await import('../lib/email.js');
    
    const result = await sendNotificationEmail({
      to,
      subject: subject || 'Test Email - Appointment Reminder',
      title: subject || 'Test Email - Appointment Reminder',
      body: body || `
        <h2>This is a test email from Trasealla CRM</h2>
        <p>If you received this email, the email system is working correctly!</p>
        <p><strong>Test Details:</strong></p>
        <ul>
          <li>Date: ${new Date().toLocaleString()}</li>
          <li>Tenant ID: ${tenantId}</li>
          <li>Email System: Office 365 SMTP</li>
        </ul>
        <p>This email confirms that appointment reminders will be sent successfully.</p>
      `,
      tenantId,
    });
    
    if (result.success) {
      res.json({
        success: true,
        message: `Test email sent successfully to ${to}`,
        data: { messageId: result.messageId },
      });
    } else {
      res.status(500).json({
        success: false,
        message: `Failed to send test email: ${result.error}`,
        error: result.error,
      });
    }
  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

// ─── POST /notifications/process-reminders ─ Process pending appointment reminders ──
router.post('/process-reminders', async (req, res) => {
  try {
    const { processPendingReminders } = await import('../lib/reminders.js');
    const result = await processPendingReminders();
    
    res.json({
      success: true,
      message: `Processed ${result.processed} reminders`,
      data: result,
    });
  } catch (error) {
    console.error('Process reminders error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /notifications/generate-reminders ─ Trigger manually ──
router.post('/generate-reminders', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    let generated = 0;

    // 1. Upcoming appointments (next 24h that haven't been reminded)
    const settings = await execute(
      'SELECT * FROM reminder_settings WHERE tenant_id = ? AND is_enabled = 1',
      [tenantId]
    );

    const appointmentSetting = settings.find(s => s.reminder_type === 'appointment_upcoming');
    if (appointmentSetting) {
      const hours = appointmentSetting.hours_before || 24;
      const upcoming = await execute(
        `SELECT a.id, a.appointment_date, a.start_time, a.customer_id,
                c.first_name, c.last_name,
                p.name as service_name,
                s.full_name as staff_name
         FROM appointments a
         LEFT JOIN contacts c ON a.customer_id = c.id
         LEFT JOIN products p ON a.service_id = p.id
         LEFT JOIN staff s ON a.staff_id = s.id
         WHERE a.tenant_id = ?
           AND a.status IN ('confirmed','pending')
           AND a.appointment_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? HOUR)
           AND a.id NOT IN (
             SELECT JSON_UNQUOTE(JSON_EXTRACT(data, '$.appointment_id'))
             FROM notifications
             WHERE tenant_id = ? AND type = 'reminder'
             AND JSON_EXTRACT(data, '$.reminder_type') = '"appointment_upcoming"'
           )`,
        [tenantId, hours, tenantId]
      );

      for (const appt of upcoming) {
        await execute(
          `INSERT INTO notifications (tenant_id, user_id, type, category, title, message, data, link, icon)
           VALUES (?, NULL, 'reminder', 'reminder', ?, ?, ?, ?, 'calendar')`,
          [
            tenantId,
            `Upcoming: ${appt.first_name || 'Client'} ${appt.last_name || ''}`,
            `${appt.service_name || 'Service'} with ${appt.staff_name || 'Staff'} at ${appt.start_time || ''}`,
            JSON.stringify({ appointment_id: appt.id, reminder_type: 'appointment_upcoming', customer_id: appt.customer_id }),
            `/appointments`
          ]
        );
        generated++;
      }
    }

    // 2. Payment due (unpaid invoices)
    const paymentSetting = settings.find(s => s.reminder_type === 'payment_due');
    if (paymentSetting) {
      try {
        const unpaid = await execute(
          `SELECT i.id, i.invoice_number, i.total, i.customer_id,
                  c.first_name, c.last_name
           FROM invoices i
           LEFT JOIN contacts c ON i.customer_id = c.id
           WHERE i.tenant_id = ?
             AND i.status IN ('sent','overdue','partial')
             AND i.id NOT IN (
               SELECT JSON_UNQUOTE(JSON_EXTRACT(data, '$.invoice_id'))
               FROM notifications
               WHERE tenant_id = ? AND type = 'payment'
               AND DATE(created_at) = CURDATE()
             )
           LIMIT 50`,
          [tenantId, tenantId]
        );

        for (const inv of unpaid) {
          await execute(
            `INSERT INTO notifications (tenant_id, user_id, type, category, title, message, data, link, icon)
             VALUES (?, NULL, 'payment', 'warning', ?, ?, ?, ?, 'credit-card')`,
            [
              tenantId,
              `Payment Due: Invoice #${inv.invoice_number}`,
              `${inv.first_name || 'Client'} ${inv.last_name || ''} owes ${inv.total}`,
              JSON.stringify({ invoice_id: inv.id, customer_id: inv.customer_id }),
              `/beauty-payments`
            ]
          );
          generated++;
        }
      } catch (e) {
        // invoices table might not exist
      }
    }

    // 3. Low stock alerts
    const stockSetting = settings.find(s => s.reminder_type === 'stock_low');
    if (stockSetting) {
      try {
        const lowStock = await execute(
          `SELECT i.id, i.name, i.stock_quantity, i.low_stock_threshold
           FROM inventory i
           WHERE i.tenant_id = ?
             AND i.is_active = 1
             AND i.stock_quantity <= i.low_stock_threshold
             AND i.id NOT IN (
               SELECT JSON_UNQUOTE(JSON_EXTRACT(data, '$.inventory_id'))
               FROM notifications
               WHERE tenant_id = ? AND type = 'inventory'
               AND DATE(created_at) = CURDATE()
             )
           LIMIT 50`,
          [tenantId, tenantId]
        );

        for (const item of lowStock) {
          await execute(
            `INSERT INTO notifications (tenant_id, user_id, type, category, title, message, data, link, icon)
             VALUES (?, NULL, 'inventory', 'warning', ?, ?, ?, ?, 'package')`,
            [
              tenantId,
              `Low Stock: ${item.name}`,
              `Only ${item.stock_quantity} left (threshold: ${item.low_stock_threshold})`,
              JSON.stringify({ inventory_id: item.id }),
              `/inventory`
            ]
          );
          generated++;
        }
      } catch (e) {
        // inventory table might not exist
      }
    }

    // 4. Membership expiry (within 7 days)
    const memberSetting = settings.find(s => s.reminder_type === 'membership_expiry');
    if (memberSetting) {
      try {
        const expiring = await execute(
          `SELECT cm.id, cm.customer_id, cm.end_date,
                  mp.name as plan_name,
                  c.first_name, c.last_name
           FROM customer_memberships cm
           JOIN membership_plans mp ON cm.plan_id = mp.id
           LEFT JOIN contacts c ON cm.customer_id = c.id
           WHERE cm.tenant_id = ?
             AND cm.status = 'active'
             AND cm.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 7 DAY)
             AND cm.id NOT IN (
               SELECT JSON_UNQUOTE(JSON_EXTRACT(data, '$.membership_id'))
               FROM notifications
               WHERE tenant_id = ? AND type = 'reminder'
               AND JSON_EXTRACT(data, '$.reminder_type') = '"membership_expiry"'
             )
           LIMIT 50`,
          [tenantId, tenantId]
        );

        for (const m of expiring) {
          await execute(
            `INSERT INTO notifications (tenant_id, user_id, type, category, title, message, data, link, icon)
             VALUES (?, NULL, 'reminder', 'warning', ?, ?, ?, ?, 'user')`,
            [
              tenantId,
              `Membership Expiring: ${m.first_name || ''} ${m.last_name || ''}`,
              `${m.plan_name} expires on ${new Date(m.end_date).toLocaleDateString()}`,
              JSON.stringify({ membership_id: m.id, customer_id: m.customer_id, reminder_type: 'membership_expiry' }),
              `/memberships`
            ]
          );
          generated++;
        }
      } catch (e) {
        // membership tables might not exist
      }
    }

    res.json({ success: true, message: `Generated ${generated} reminder notifications`, generated });
  } catch (error) {
    console.error('Generate reminders error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── POST /notifications/send-test ─ Send test notification ─────
router.post('/send-test', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const userId = req.user?.id || null;

    await execute(
      `INSERT INTO notifications (tenant_id, user_id, type, category, title, message, icon, link)
       VALUES (?, ?, 'system', 'info', 'Test Notification 🔔', 'This is a test notification to verify your notification system is working correctly.', 'bell', '/notifications')`,
      [tenantId, userId || null]
    );

    res.json({ success: true, message: 'Test notification sent!' });
  } catch (error) {
    console.error('Send test error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
