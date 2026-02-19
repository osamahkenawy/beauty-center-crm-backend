import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

async function ensureTables() {
  await execute(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      branch_id INT,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(30) NOT NULL DEFAULT 'email',
      campaign_type VARCHAR(50) DEFAULT 'promotional',
      status VARCHAR(30) DEFAULT 'draft',
      subject VARCHAR(500),
      content TEXT,
      template_id INT,
      audience_id INT,
      start_date DATETIME,
      end_date DATETIME,
      scheduled_at DATETIME,
      sent_at DATETIME,
      budget DECIMAL(15, 2),
      actual_cost DECIMAL(15, 2) DEFAULT 0,
      target_audience JSON,
      description TEXT,
      total_recipients INT DEFAULT 0,
      total_sent INT DEFAULT 0,
      total_delivered INT DEFAULT 0,
      total_opened INT DEFAULT 0,
      total_clicked INT DEFAULT 0,
      total_converted INT DEFAULT 0,
      total_unsubscribed INT DEFAULT 0,
      total_bounced INT DEFAULT 0,
      open_rate DECIMAL(5,2) DEFAULT 0,
      click_rate DECIMAL(5,2) DEFAULT 0,
      conversion_rate DECIMAL(5,2) DEFAULT 0,
      revenue_generated DECIMAL(15,2) DEFAULT 0,
      tags JSON,
      settings JSON,
      owner_id INT,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_status (status),
      INDEX idx_type (type),
      INDEX idx_campaign_type (campaign_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Add new columns if missing
  const cols = ['tenant_id','branch_id','campaign_type','subject','content','template_id','audience_id',
    'scheduled_at','sent_at','total_recipients','total_delivered','total_unsubscribed','total_bounced',
    'open_rate','click_rate','conversion_rate','revenue_generated','tags','settings'];
  for (const col of cols) {
    try {
      let colDef = 'VARCHAR(255)';
      if (['tenant_id','branch_id','template_id','audience_id','total_recipients','total_delivered','total_unsubscribed','total_bounced'].includes(col)) colDef = 'INT DEFAULT 0';
      if (['open_rate','click_rate','conversion_rate'].includes(col)) colDef = 'DECIMAL(5,2) DEFAULT 0';
      if (['revenue_generated'].includes(col)) colDef = 'DECIMAL(15,2) DEFAULT 0';
      if (['scheduled_at','sent_at'].includes(col)) colDef = 'DATETIME';
      if (['subject'].includes(col)) colDef = 'VARCHAR(500)';
      if (['content'].includes(col)) colDef = 'TEXT';
      if (['tags','settings'].includes(col)) colDef = 'JSON';
      if (col === 'campaign_type') colDef = "VARCHAR(50) DEFAULT 'promotional'";
      await execute(`ALTER TABLE campaigns ADD COLUMN ${col} ${colDef}`);
    } catch(e) {}
  }

  // Campaign recipients tracking
  await execute(`
    CREATE TABLE IF NOT EXISTS campaign_recipients (
      id INT AUTO_INCREMENT PRIMARY KEY,
      campaign_id INT NOT NULL,
      tenant_id INT,
      contact_id INT,
      email VARCHAR(255),
      phone VARCHAR(50),
      full_name VARCHAR(255),
      status VARCHAR(30) DEFAULT 'pending',
      sent_at DATETIME,
      opened_at DATETIME,
      clicked_at DATETIME,
      converted_at DATETIME,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_campaign (campaign_id),
      INDEX idx_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Automation rules
  await execute(`
    CREATE TABLE IF NOT EXISTS marketing_automations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      trigger_type VARCHAR(50) NOT NULL,
      trigger_config JSON,
      action_type VARCHAR(50) NOT NULL DEFAULT 'send_email',
      action_config JSON,
      template_id INT,
      delay_minutes INT DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      total_triggered INT DEFAULT 0,
      total_successful INT DEFAULT 0,
      last_triggered_at DATETIME,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_trigger (trigger_type),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

router.use(authMiddleware);

// ─── STATS ────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    await ensureTables();
    const tenantId = req.tenantId;

    const [totalRow] = await query('SELECT COUNT(*) as count FROM campaigns WHERE tenant_id = ?', [tenantId]);
    const [draftRow] = await query("SELECT COUNT(*) as count FROM campaigns WHERE tenant_id = ? AND status = 'draft'", [tenantId]);
    const [activeRow] = await query("SELECT COUNT(*) as count FROM campaigns WHERE tenant_id = ? AND status IN ('scheduled', 'running')", [tenantId]);
    const [completedRow] = await query("SELECT COUNT(*) as count FROM campaigns WHERE tenant_id = ? AND status = 'completed'", [tenantId]);
    const [sentRow] = await query('SELECT COALESCE(SUM(total_sent), 0) as total FROM campaigns WHERE tenant_id = ?', [tenantId]);
    const [openedRow] = await query('SELECT COALESCE(SUM(total_opened), 0) as total FROM campaigns WHERE tenant_id = ?', [tenantId]);
    const [revenueRow] = await query('SELECT COALESCE(SUM(revenue_generated), 0) as total FROM campaigns WHERE tenant_id = ?', [tenantId]);

    const byType = await query('SELECT type, COUNT(*) as count FROM campaigns WHERE tenant_id = ? GROUP BY type', [tenantId]);
    const byCampaignType = await query('SELECT campaign_type, COUNT(*) as count FROM campaigns WHERE tenant_id = ? GROUP BY campaign_type', [tenantId]);

    const avgOpenRate = sentRow?.total > 0 ? ((openedRow?.total / sentRow?.total) * 100).toFixed(1) : 0;

    res.json({
      success: true,
      data: {
        total: totalRow?.count || 0,
        draft: draftRow?.count || 0,
        active: activeRow?.count || 0,
        completed: completedRow?.count || 0,
        total_sent: sentRow?.total || 0,
        total_opened: openedRow?.total || 0,
        avg_open_rate: parseFloat(avgOpenRate),
        total_revenue: revenueRow?.total || 0,
        by_type: byType,
        by_campaign_type: byCampaignType
      }
    });
  } catch (error) {
    console.error('Campaign stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ─── LIST ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const tenantId = req.tenantId;
    const { type, campaign_type, status, search, page = 1, limit = 20 } = req.query;

    let sql = `
      SELECT c.*, s.full_name as owner_name
      FROM campaigns c
      LEFT JOIN staff s ON c.owner_id = s.id
      WHERE c.tenant_id = ?
    `;
    const params = [tenantId];

    if (type) { sql += ' AND c.type = ?'; params.push(type); }
    if (campaign_type) { sql += ' AND c.campaign_type = ?'; params.push(campaign_type); }
    if (status) { sql += ' AND c.status = ?'; params.push(status); }
    if (search) { sql += ' AND (c.name LIKE ? OR c.description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    sql += ' ORDER BY c.created_at DESC';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    sql += ` LIMIT ${parseInt(limit)} OFFSET ${offset}`;

    const campaigns = await query(sql, params);

    // Count total
    let countSql = 'SELECT COUNT(*) as total FROM campaigns WHERE tenant_id = ?';
    const countParams = [tenantId];
    if (type) { countSql += ' AND type = ?'; countParams.push(type); }
    if (campaign_type) { countSql += ' AND campaign_type = ?'; countParams.push(campaign_type); }
    if (status) { countSql += ' AND status = ?'; countParams.push(status); }
    if (search) { countSql += ' AND (name LIKE ? OR description LIKE ?)'; countParams.push(`%${search}%`, `%${search}%`); }
    const [countRow] = await query(countSql, countParams);

    res.json({
      success: true,
      data: campaigns,
      pagination: { page: parseInt(page), limit: parseInt(limit), total: countRow?.total || 0 }
    });
  } catch (error) {
    console.error('Fetch campaigns error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch campaigns' });
  }
});

// ─── GET SINGLE ──────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    await ensureTables();
    const [campaign] = await query('SELECT c.*, s.full_name as owner_name FROM campaigns c LEFT JOIN staff s ON c.owner_id = s.id WHERE c.id = ? AND c.tenant_id = ?', [req.params.id, req.tenantId]);
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    // Get recipient stats
    const recipientStats = await query(`
      SELECT status, COUNT(*) as count 
      FROM campaign_recipients 
      WHERE campaign_id = ? AND tenant_id = ?
      GROUP BY status
    `, [req.params.id, req.tenantId]);

    // Get recent recipients
    const recipients = await query(`
      SELECT cr.*, c.first_name, c.last_name, c.email as contact_email
      FROM campaign_recipients cr
      LEFT JOIN contacts c ON cr.contact_id = c.id
      WHERE cr.campaign_id = ? AND cr.tenant_id = ?
      ORDER BY cr.created_at DESC LIMIT 50
    `, [req.params.id, req.tenantId]);

    res.json({ success: true, data: { ...campaign, recipient_stats: recipientStats, recipients } });
  } catch (error) {
    console.error('Get campaign error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch campaign' });
  }
});

// ─── CREATE ──────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    await ensureTables();
    const tenantId = req.tenantId;
    const { name, type, campaign_type, status, subject, content, template_id, audience_id,
      start_date, end_date, scheduled_at, budget, target_audience, description, tags, settings, branch_id } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'Campaign name required' });

    const cleanDate = (d) => d && d.trim && d.trim() !== '' ? d : null;
    const cleanNum = (n) => n && n !== '' ? parseFloat(n) : null;

    const result = await execute(
      `INSERT INTO campaigns (tenant_id, branch_id, name, type, campaign_type, status, subject, content, template_id, audience_id,
        start_date, end_date, scheduled_at, budget, target_audience, description, tags, settings, owner_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, branch_id || null, name, type || 'email', campaign_type || 'promotional', status || 'draft',
       subject || null, content || null, template_id || null, audience_id || null,
       cleanDate(start_date), cleanDate(end_date), cleanDate(scheduled_at), cleanNum(budget),
       target_audience ? JSON.stringify(target_audience) : null, description || null,
       tags ? JSON.stringify(tags) : null, settings ? JSON.stringify(settings) : null,
       req.user?.id, req.user?.id]
    );

    res.json({ success: true, message: 'Campaign created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Campaign creation error:', error);
    res.status(500).json({ success: false, message: 'Failed to create campaign' });
  }
});

// ─── UPDATE ──────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const dateFields = ['start_date', 'end_date', 'scheduled_at'];
    const numericFields = ['budget', 'actual_cost', 'total_sent', 'total_opened', 'total_clicked', 'total_converted', 'revenue_generated', 'total_recipients', 'total_delivered', 'total_unsubscribed', 'total_bounced'];
    const jsonFields = ['target_audience', 'tags', 'settings'];
    const fields = ['name', 'type', 'campaign_type', 'status', 'subject', 'content', 'template_id', 'audience_id', 'branch_id',
      ...dateFields, ...numericFields, ...jsonFields, 'description'];
    const updates = [];
    const params = [];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        let value = req.body[f];
        if (dateFields.includes(f) && (!value || (typeof value === 'string' && value.trim() === ''))) value = null;
        if (numericFields.includes(f) && (value === '' || value === null)) value = null;
        else if (numericFields.includes(f) && value) value = parseFloat(value);
        if (jsonFields.includes(f) && value) value = typeof value === 'string' ? value : JSON.stringify(value);
        params.push(value);
      }
    }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No updates' });

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE campaigns SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    res.json({ success: true, message: 'Campaign updated' });
  } catch (error) {
    console.error('Campaign update error:', error);
    res.status(500).json({ success: false, message: 'Failed to update campaign' });
  }
});

// ─── SEND / SCHEDULE ─────────────────────────────────────
router.post('/:id/send', async (req, res) => {
  try {
    await ensureTables();
    const tenantId = req.tenantId;
    const [campaign] = await query('SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    // Get audience contacts
    let contacts = [];
    if (campaign.audience_id) {
      contacts = await query(`
        SELECT am.contact_id, am.email, am.phone, c.first_name, c.last_name, c.email as contact_email, c.phone as contact_phone
        FROM audience_members am
        LEFT JOIN contacts c ON am.contact_id = c.id
        WHERE am.audience_id = ? AND am.status = 'active'
      `, [campaign.audience_id]);
    } else {
      // All active contacts
      contacts = await query('SELECT id as contact_id, first_name, last_name, email, phone FROM contacts WHERE tenant_id = ? LIMIT 1000', [tenantId]);
    }

    // Alter campaigns status to VARCHAR if it's still ENUM
    try { await execute("ALTER TABLE campaigns MODIFY COLUMN status VARCHAR(30) DEFAULT 'draft'"); } catch (e) {}

    // Create recipient records
    let recipientCount = 0;
    for (const contact of contacts) {
      try {
        const email = contact.email || contact.contact_email || null;
        const phone = contact.phone || contact.contact_phone || null;
        const fullName = `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || null;
        await execute(
          `INSERT INTO campaign_recipients (campaign_id, tenant_id, contact_id, email, phone, full_name, status)
           VALUES (?, ?, ?, ?, ?, ?, 'sent')`,
          [req.params.id, tenantId, contact.contact_id || null, email, phone, fullName]
        );
        recipientCount++;
      } catch (e) {
        // skip failed inserts
      }
    }

    // Update campaign status & stats
    await execute(
      "UPDATE campaigns SET status = 'running', total_recipients = ?, total_sent = ?, sent_at = NOW() WHERE id = ? AND tenant_id = ?",
      [recipientCount, recipientCount, req.params.id, tenantId]
    );

    res.json({ success: true, message: `Campaign sent to ${recipientCount} recipients`, data: { recipients: recipientCount } });
  } catch (error) {
    console.error('Send campaign error:', error.message, error.sql || '');
    res.status(500).json({ success: false, message: 'Failed to send campaign' });
  }
});

// ─── PAUSE / RESUME ──────────────────────────────────────
router.post('/:id/pause', async (req, res) => {
  try {
    const [campaign] = await query('SELECT status FROM campaigns WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    const newStatus = campaign.status === 'paused' ? 'running' : 'paused';
    await execute('UPDATE campaigns SET status = ? WHERE id = ? AND tenant_id = ?', [newStatus, req.params.id, req.tenantId]);
    res.json({ success: true, message: `Campaign ${newStatus}` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update campaign status' });
  }
});

// ─── COMPLETE ────────────────────────────────────────────
router.post('/:id/complete', async (req, res) => {
  try {
    await execute("UPDATE campaigns SET status = 'completed', end_date = NOW() WHERE id = ? AND tenant_id = ?", [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Campaign completed' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to complete campaign' });
  }
});

// ─── DELETE ──────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await execute('DELETE FROM campaign_recipients WHERE campaign_id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    await execute('DELETE FROM campaigns WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Campaign deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete campaign' });
  }
});

// ═══════════════════════════════════════════════════════════
// MARKETING AUTOMATIONS
// ═══════════════════════════════════════════════════════════

router.get('/automations/list', async (req, res) => {
  try {
    await ensureTables();
    const automations = await query('SELECT * FROM marketing_automations WHERE tenant_id = ? ORDER BY created_at DESC', [req.tenantId]);
    res.json({ success: true, data: automations });
  } catch (error) {
    console.error('Fetch automations error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch automations' });
  }
});

router.get('/automations/stats', async (req, res) => {
  try {
    await ensureTables();
    const tenantId = req.tenantId;
    const [totalRow] = await query('SELECT COUNT(*) as count FROM marketing_automations WHERE tenant_id = ?', [tenantId]);
    const [activeRow] = await query('SELECT COUNT(*) as count FROM marketing_automations WHERE tenant_id = ? AND is_active = 1', [tenantId]);
    const [triggeredRow] = await query('SELECT COALESCE(SUM(total_triggered), 0) as total FROM marketing_automations WHERE tenant_id = ?', [tenantId]);
    const [successRow] = await query('SELECT COALESCE(SUM(total_successful), 0) as total FROM marketing_automations WHERE tenant_id = ?', [tenantId]);

    res.json({
      success: true,
      data: {
        total: totalRow?.count || 0,
        active: activeRow?.count || 0,
        total_triggered: triggeredRow?.total || 0,
        total_successful: successRow?.total || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch automation stats' });
  }
});

router.post('/automations', async (req, res) => {
  try {
    await ensureTables();
    const { name, description, trigger_type, trigger_config, action_type, action_config, template_id, delay_minutes, is_active } = req.body;
    if (!name || !trigger_type) return res.status(400).json({ success: false, message: 'Name and trigger type required' });

    const result = await execute(
      `INSERT INTO marketing_automations (tenant_id, name, description, trigger_type, trigger_config, action_type, action_config, template_id, delay_minutes, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.tenantId, name, description || null, trigger_type,
       trigger_config ? JSON.stringify(trigger_config) : null,
       action_type || 'send_email',
       action_config ? JSON.stringify(action_config) : null,
       template_id || null, delay_minutes || 0, is_active !== false ? 1 : 0, req.user?.id]
    );
    res.json({ success: true, message: 'Automation created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create automation error:', error);
    res.status(500).json({ success: false, message: 'Failed to create automation' });
  }
});

router.patch('/automations/:id', async (req, res) => {
  try {
    const fields = ['name', 'description', 'trigger_type', 'trigger_config', 'action_type', 'action_config', 'template_id', 'delay_minutes', 'is_active'];
    const updates = [];
    const params = [];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        let value = req.body[f];
        if (f === 'is_active') value = value ? 1 : 0;
        if (['trigger_config', 'action_config'].includes(f)) value = value ? JSON.stringify(value) : null;
        params.push(value);
      }
    }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No updates' });

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE marketing_automations SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    res.json({ success: true, message: 'Automation updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update automation' });
  }
});

router.post('/automations/:id/toggle', async (req, res) => {
  try {
    const [automation] = await query('SELECT is_active FROM marketing_automations WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!automation) return res.status(404).json({ success: false, message: 'Automation not found' });

    const newActive = automation.is_active ? 0 : 1;
    await execute('UPDATE marketing_automations SET is_active = ? WHERE id = ? AND tenant_id = ?', [newActive, req.params.id, req.tenantId]);
    res.json({ success: true, message: `Automation ${newActive ? 'activated' : 'deactivated'}` });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to toggle automation' });
  }
});

router.delete('/automations/:id', async (req, res) => {
  try {
    await execute('DELETE FROM marketing_automations WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Automation deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete automation' });
  }
});

export default router;
