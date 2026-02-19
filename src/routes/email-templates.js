import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

async function ensureTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      subject VARCHAR(500) NOT NULL,
      body TEXT NOT NULL,
      category VARCHAR(50) DEFAULT 'general',
      template_type ENUM('email', 'sms', 'whatsapp', 'push') DEFAULT 'email',
      design_json JSON,
      preview_text VARCHAR(500),
      placeholders JSON,
      thumbnail_url VARCHAR(500),
      is_default TINYINT(1) DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      usage_count INT DEFAULT 0,
      last_used_at DATETIME,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_category (category),
      INDEX idx_type (template_type),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Add new columns if missing
  const cols = ['tenant_id', 'template_type', 'design_json', 'preview_text', 'thumbnail_url', 'is_default', 'usage_count', 'last_used_at'];
  for (const col of cols) {
    try {
      let def = 'VARCHAR(500)';
      if (col === 'tenant_id') def = 'INT';
      if (col === 'template_type') def = "VARCHAR(20) DEFAULT 'email'";
      if (col === 'design_json') def = 'JSON';
      if (col === 'is_default') def = 'TINYINT(1) DEFAULT 0';
      if (col === 'usage_count') def = 'INT DEFAULT 0';
      if (col === 'last_used_at') def = 'DATETIME';
      await execute(`ALTER TABLE email_templates ADD COLUMN ${col} ${def}`);
    } catch (e) {}
  }

  // Migrate category ENUM to VARCHAR if needed
  try {
    await execute(`ALTER TABLE email_templates MODIFY COLUMN category VARCHAR(50) DEFAULT 'general'`);
  } catch (e) {}
}

router.use(authMiddleware);

// ─── STATS ────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    await ensureTable();
    const tenantId = req.tenantId;

    const [totalRow] = await query('SELECT COUNT(*) as count FROM email_templates WHERE tenant_id = ? OR tenant_id IS NULL', [tenantId]);
    const [activeRow] = await query('SELECT COUNT(*) as count FROM email_templates WHERE (tenant_id = ? OR tenant_id IS NULL) AND is_active = 1', [tenantId]);
    const byCategory = await query('SELECT category, COUNT(*) as count FROM email_templates WHERE tenant_id = ? OR tenant_id IS NULL GROUP BY category', [tenantId]);
    const byType = await query('SELECT template_type, COUNT(*) as count FROM email_templates WHERE tenant_id = ? OR tenant_id IS NULL GROUP BY template_type', [tenantId]);

    res.json({
      success: true,
      data: {
        total: totalRow?.count || 0,
        active: activeRow?.count || 0,
        by_category: byCategory,
        by_type: byType
      }
    });
  } catch (error) {
    console.error('Template stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ─── LIST ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    await ensureTable();
    const tenantId = req.tenantId;
    const { category, template_type, active, search } = req.query;

    let sql = `
      SELECT et.*, s.full_name as created_by_name
      FROM email_templates et
      LEFT JOIN staff s ON et.created_by = s.id
      WHERE (et.tenant_id = ? OR et.tenant_id IS NULL)
    `;
    const params = [tenantId];

    if (category) { sql += ' AND et.category = ?'; params.push(category); }
    if (template_type) { sql += ' AND et.template_type = ?'; params.push(template_type); }
    if (active !== undefined) { sql += ' AND et.is_active = ?'; params.push(active === 'true' ? 1 : 0); }
    if (search) { sql += ' AND (et.name LIKE ? OR et.subject LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY et.is_default DESC, et.name';

    const templates = await query(sql, params);
    res.json({ success: true, data: templates });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch email templates' });
  }
});

// ─── GET SINGLE ──────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    await ensureTable();
    const [template] = await query('SELECT * FROM email_templates WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)', [req.params.id, req.tenantId]);
    if (!template) return res.status(404).json({ success: false, message: 'Template not found' });
    res.json({ success: true, data: template });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch template' });
  }
});

// ─── CREATE ──────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    await ensureTable();
    const tenantId = req.tenantId;
    const { name, subject, body, category, template_type, design_json, preview_text, placeholders, is_active } = req.body;

    if (!name || !subject || !body) {
      return res.status(400).json({ success: false, message: 'Name, subject, and body required' });
    }

    const result = await execute(
      `INSERT INTO email_templates (tenant_id, name, subject, body, category, template_type, design_json, preview_text, placeholders, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, name, subject, body, category || 'general', template_type || 'email',
       design_json ? JSON.stringify(design_json) : null, preview_text || null,
       placeholders ? JSON.stringify(placeholders) : null, is_active !== false ? 1 : 0, req.user?.id]
    );
    res.json({ success: true, message: 'Template created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create template error:', error);
    res.status(500).json({ success: false, message: 'Failed to create template' });
  }
});

// ─── UPDATE ──────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const fields = ['name', 'subject', 'body', 'category', 'template_type', 'design_json', 'preview_text', 'placeholders', 'is_active'];
    const updates = [];
    const params = [];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        let value = req.body[f];
        if (f === 'is_active') value = value ? 1 : 0;
        if (['placeholders', 'design_json'].includes(f)) value = value ? JSON.stringify(value) : null;
        params.push(value);
      }
    }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No updates' });

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE email_templates SET ${updates.join(', ')} WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)`, params);
    res.json({ success: true, message: 'Template updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update template' });
  }
});

// ─── DUPLICATE ───────────────────────────────────────────
router.post('/:id/duplicate', async (req, res) => {
  try {
    const [template] = await query('SELECT * FROM email_templates WHERE id = ?', [req.params.id]);
    if (!template) return res.status(404).json({ success: false, message: 'Template not found' });

    const result = await execute(
      `INSERT INTO email_templates (tenant_id, name, subject, body, category, template_type, design_json, preview_text, placeholders, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.tenantId, `${template.name} (Copy)`, template.subject, template.body, template.category,
       template.template_type, template.design_json, template.preview_text, template.placeholders,
       1, req.user?.id]
    );
    res.json({ success: true, message: 'Template duplicated', data: { id: result.insertId } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to duplicate template' });
  }
});

// ─── PREVIEW ─────────────────────────────────────────────
router.post('/:id/preview', async (req, res) => {
  try {
    const [template] = await query('SELECT * FROM email_templates WHERE id = ?', [req.params.id]);
    if (!template) return res.status(404).json({ success: false, message: 'Template not found' });

    // Replace placeholders with sample data
    let preview = template.body;
    const sampleData = {
      '{{client_name}}': 'Sarah Johnson',
      '{{first_name}}': 'Sarah',
      '{{business_name}}': 'Beauty Center',
      '{{service_name}}': 'Hair Cut & Style',
      '{{appointment_date}}': 'March 15, 2026',
      '{{appointment_time}}': '2:00 PM',
      '{{staff_name}}': 'Emma Wilson',
      '{{promo_code}}': 'SPRING20',
      '{{discount}}': '20%',
      '{{invoice_number}}': 'INV-0042',
      '{{total}}': '150.00',
      '{{review_link}}': '#',
      '{{booking_link}}': '#',
      ...req.body.variables
    };

    for (const [key, val] of Object.entries(sampleData)) {
      preview = preview.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), val);
    }

    res.json({ success: true, data: { subject: template.subject, body: preview } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to preview template' });
  }
});

// ─── DELETE ──────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    // Don't allow deleting default templates
    const [template] = await query('SELECT is_default FROM email_templates WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)', [req.params.id, req.tenantId]);
    if (template?.is_default) {
      return res.status(400).json({ success: false, message: 'Cannot delete default templates' });
    }
    await execute('DELETE FROM email_templates WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL)', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Template deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete template' });
  }
});

// ─── SEED DEFAULT TEMPLATES ──────────────────────────────
router.post('/seed-defaults', async (req, res) => {
  try {
    await ensureTable();
    const tenantId = req.tenantId;

    const defaults = [
      {
        name: 'Appointment Confirmation',
        subject: 'Your appointment is confirmed! ✨',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
<h2 style="color: #f2421b;">Appointment Confirmed!</h2>
<p>Hi {{client_name}},</p>
<p>Your appointment has been confirmed:</p>
<div style="background: #f8f9fa; padding: 20px; border-radius: 12px; margin: 16px 0;">
<p><strong>Service:</strong> {{service_name}}</p>
<p><strong>Date:</strong> {{appointment_date}}</p>
<p><strong>Time:</strong> {{appointment_time}}</p>
<p><strong>Stylist:</strong> {{staff_name}}</p>
</div>
<p>We look forward to seeing you! 💇‍♀️</p>
<p>— {{business_name}}</p>
</div>`,
        category: 'appointment',
        template_type: 'email'
      },
      {
        name: 'Appointment Reminder',
        subject: 'Reminder: Your appointment is tomorrow! 📅',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
<h2 style="color: #f2421b;">Appointment Reminder</h2>
<p>Hi {{client_name}},</p>
<p>Just a friendly reminder about your upcoming appointment:</p>
<div style="background: #f8f9fa; padding: 20px; border-radius: 12px; margin: 16px 0;">
<p><strong>Service:</strong> {{service_name}}</p>
<p><strong>Date:</strong> {{appointment_date}}</p>
<p><strong>Time:</strong> {{appointment_time}}</p>
</div>
<p>Need to reschedule? <a href="{{booking_link}}" style="color: #f2421b;">Click here</a></p>
<p>— {{business_name}}</p>
</div>`,
        category: 'reminder',
        template_type: 'email'
      },
      {
        name: 'Welcome New Client',
        subject: 'Welcome to {{business_name}}! 🎉',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
<h2 style="color: #f2421b;">Welcome!</h2>
<p>Hi {{first_name}},</p>
<p>Welcome to {{business_name}}! We're thrilled to have you as part of our family.</p>
<p>As a welcome gift, enjoy <strong>{{discount}} off</strong> your next appointment with code: <strong>{{promo_code}}</strong></p>
<a href="{{booking_link}}" style="display: inline-block; background: #f2421b; color: white; padding: 12px 30px; border-radius: 25px; text-decoration: none; margin: 16px 0;">Book Now</a>
<p>— {{business_name}}</p>
</div>`,
        category: 'welcome',
        template_type: 'email'
      },
      {
        name: 'Review Request',
        subject: 'How was your visit? ⭐',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
<h2 style="color: #f2421b;">We'd Love Your Feedback!</h2>
<p>Hi {{client_name}},</p>
<p>Thank you for visiting {{business_name}}! We hope you enjoyed your {{service_name}}.</p>
<p>Would you mind leaving us a quick review? Your feedback helps us improve!</p>
<a href="{{review_link}}" style="display: inline-block; background: #f2421b; color: white; padding: 12px 30px; border-radius: 25px; text-decoration: none; margin: 16px 0;">Leave a Review</a>
<p>— {{business_name}}</p>
</div>`,
        category: 'review',
        template_type: 'email'
      },
      {
        name: 'Birthday Greeting',
        subject: 'Happy Birthday, {{first_name}}! 🎂🎁',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
<h2 style="color: #f2421b;">Happy Birthday! 🎉</h2>
<p>Hi {{first_name}},</p>
<p>Wishing you a wonderful birthday from everyone at {{business_name}}!</p>
<p>As our birthday gift to you, enjoy <strong>{{discount}} off</strong> any service this month!</p>
<p>Use code: <strong>{{promo_code}}</strong></p>
<a href="{{booking_link}}" style="display: inline-block; background: #f2421b; color: white; padding: 12px 30px; border-radius: 25px; text-decoration: none; margin: 16px 0;">Book & Celebrate</a>
<p>— {{business_name}}</p>
</div>`,
        category: 'birthday',
        template_type: 'email'
      },
      {
        name: 'Promotional Offer',
        subject: '✨ Special Offer Just For You!',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
<h2 style="color: #f2421b;">Exclusive Deal! ✨</h2>
<p>Hi {{client_name}},</p>
<p>We have a special offer waiting for you at {{business_name}}!</p>
<div style="background: linear-gradient(135deg, #f2421b, #ff6b4a); color: white; padding: 25px; border-radius: 12px; margin: 16px 0; text-align: center;">
<h3 style="color: white; margin: 0;">{{discount}} OFF</h3>
<p style="margin: 8px 0;">Use code: <strong>{{promo_code}}</strong></p>
</div>
<a href="{{booking_link}}" style="display: inline-block; background: #f2421b; color: white; padding: 12px 30px; border-radius: 25px; text-decoration: none; margin: 16px 0;">Book Now</a>
<p>— {{business_name}}</p>
</div>`,
        category: 'promotion',
        template_type: 'email'
      },
      {
        name: 'We Miss You!',
        subject: 'We miss you, {{first_name}}! 💕',
        body: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
<h2 style="color: #f2421b;">We Miss You! 💕</h2>
<p>Hi {{first_name}},</p>
<p>It's been a while since your last visit to {{business_name}}. We'd love to see you again!</p>
<p>Come back and enjoy <strong>{{discount}} off</strong> your next appointment:</p>
<p>Use code: <strong>{{promo_code}}</strong></p>
<a href="{{booking_link}}" style="display: inline-block; background: #f2421b; color: white; padding: 12px 30px; border-radius: 25px; text-decoration: none; margin: 16px 0;">Book Your Visit</a>
<p>We can't wait to pamper you again! ✨</p>
<p>— {{business_name}}</p>
</div>`,
        category: 'marketing',
        template_type: 'email'
      },
      {
        name: 'SMS Appointment Reminder',
        subject: 'Appointment Reminder',
        body: 'Hi {{first_name}}! Reminder: {{service_name}} on {{appointment_date}} at {{appointment_time}} with {{staff_name}} at {{business_name}}. Reply CANCEL to cancel.',
        category: 'reminder',
        template_type: 'sms'
      }
    ];

    let seeded = 0;
    for (const tpl of defaults) {
      const [existing] = await query('SELECT id FROM email_templates WHERE tenant_id = ? AND name = ?', [tenantId, tpl.name]);
      if (!existing) {
        await execute(
          `INSERT INTO email_templates (tenant_id, name, subject, body, category, template_type, is_default, is_active, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`,
          [tenantId, tpl.name, tpl.subject, tpl.body, tpl.category, tpl.template_type, req.user?.id]
        );
        seeded++;
      }
    }

    res.json({ success: true, message: `${seeded} default templates seeded` });
  } catch (error) {
    console.error('Seed templates error:', error);
    res.status(500).json({ success: false, message: 'Failed to seed templates' });
  }
});

export default router;
