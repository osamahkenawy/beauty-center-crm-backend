import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

async function ensureTables() {
  await execute(`
    CREATE TABLE IF NOT EXISTS audiences (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      type ENUM('static', 'dynamic', 'smart') DEFAULT 'static',
      segment_type ENUM('all_clients', 'new_clients', 'vip_clients', 'inactive_clients', 'birthday_month', 'service_based', 'spend_based', 'membership', 'loyalty_tier', 'custom') DEFAULT 'custom',
      criteria JSON,
      member_count INT DEFAULT 0,
      tags JSON,
      color VARCHAR(20),
      icon VARCHAR(50),
      is_active TINYINT(1) DEFAULT 1,
      last_synced_at DATETIME,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_segment (segment_type),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Add new columns if missing
  const cols = ['tenant_id', 'segment_type', 'color', 'icon'];
  for (const col of cols) {
    try {
      let def = 'VARCHAR(50)';
      if (col === 'tenant_id') def = 'INT';
      if (col === 'segment_type') def = "VARCHAR(50) DEFAULT 'custom'";
      await execute(`ALTER TABLE audiences ADD COLUMN ${col} ${def}`);
    } catch (e) {}
  }

  await execute(`
    CREATE TABLE IF NOT EXISTS audience_members (
      id INT AUTO_INCREMENT PRIMARY KEY,
      audience_id INT NOT NULL,
      tenant_id INT,
      contact_id INT,
      lead_id INT,
      email VARCHAR(255),
      phone VARCHAR(50),
      full_name VARCHAR(255),
      status ENUM('active', 'unsubscribed', 'bounced') DEFAULT 'active',
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audience (audience_id),
      INDEX idx_tenant (tenant_id),
      INDEX idx_contact (contact_id),
      INDEX idx_lead (lead_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Add columns if missing
  try { await execute('ALTER TABLE audience_members ADD COLUMN tenant_id INT'); } catch(e) {}
  try { await execute('ALTER TABLE audience_members ADD COLUMN full_name VARCHAR(255)'); } catch(e) {}
}

router.use(authMiddleware);

// ─── STATS ────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    await ensureTables();
    const tenantId = req.tenantId;

    const [totalRow] = await query('SELECT COUNT(*) as count FROM audiences WHERE tenant_id = ?', [tenantId]);
    const [activeRow] = await query('SELECT COUNT(*) as count FROM audiences WHERE tenant_id = ? AND is_active = 1', [tenantId]);
    const [totalMembersRow] = await query(
      'SELECT COUNT(DISTINCT am.contact_id) as count FROM audience_members am INNER JOIN audiences a ON am.audience_id = a.id WHERE a.tenant_id = ? AND am.status = ?',
      [tenantId, 'active']
    );
    const [totalContactsRow] = await query('SELECT COUNT(*) as count FROM contacts WHERE tenant_id = ?', [tenantId]);

    const bySegment = await query('SELECT segment_type, COUNT(*) as count FROM audiences WHERE tenant_id = ? GROUP BY segment_type', [tenantId]);

    res.json({
      success: true,
      data: {
        total_audiences: totalRow?.count || 0,
        active_audiences: activeRow?.count || 0,
        total_members: totalMembersRow?.count || 0,
        total_contacts: totalContactsRow?.count || 0,
        by_segment: bySegment
      }
    });
  } catch (error) {
    console.error('Audience stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ─── LIST ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    await ensureTables();
    const tenantId = req.tenantId;
    const { type, segment_type, active } = req.query;

    let sql = `
      SELECT a.*, s.full_name as created_by_name,
        (SELECT COUNT(*) FROM audience_members WHERE audience_id = a.id AND status = 'active') as active_count
      FROM audiences a
      LEFT JOIN staff s ON a.created_by = s.id
      WHERE a.tenant_id = ?
    `;
    const params = [tenantId];

    if (type) { sql += ' AND a.type = ?'; params.push(type); }
    if (segment_type) { sql += ' AND a.segment_type = ?'; params.push(segment_type); }
    if (active !== undefined) { sql += ' AND a.is_active = ?'; params.push(active === 'true' ? 1 : 0); }
    sql += ' ORDER BY a.name';

    const audiences = await query(sql, params);
    res.json({ success: true, data: audiences });
  } catch (error) {
    console.error('Fetch audiences error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch audiences' });
  }
});

// ─── GET SINGLE ──────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    await ensureTables();
    const [audience] = await query('SELECT * FROM audiences WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!audience) return res.status(404).json({ success: false, message: 'Audience not found' });

    const members = await query(
      `SELECT am.*, c.first_name, c.last_name, c.email as contact_email, c.phone as contact_phone
       FROM audience_members am
       LEFT JOIN contacts c ON am.contact_id = c.id
       WHERE am.audience_id = ?
       ORDER BY am.added_at DESC LIMIT 200`,
      [req.params.id]
    );

    res.json({ success: true, data: { ...audience, members } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch audience' });
  }
});

// ─── CREATE ──────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    await ensureTables();
    const tenantId = req.tenantId;
    const { name, description, type, segment_type, criteria, tags, color, icon } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'Audience name required' });

    const result = await execute(
      `INSERT INTO audiences (tenant_id, name, description, type, segment_type, criteria, tags, color, icon, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, name, description || null, type || 'static', segment_type || 'custom',
       criteria ? JSON.stringify(criteria) : null,
       tags ? JSON.stringify(tags) : null,
       color || null, icon || null, req.user?.id]
    );
    res.json({ success: true, message: 'Audience created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create audience error:', error);
    res.status(500).json({ success: false, message: 'Failed to create audience' });
  }
});

// ─── UPDATE ──────────────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const fields = ['name', 'description', 'type', 'segment_type', 'criteria', 'tags', 'color', 'icon', 'is_active'];
    const updates = [];
    const params = [];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        let value = req.body[f];
        if (f === 'is_active') value = value ? 1 : 0;
        if (f === 'criteria' || f === 'tags') value = value ? JSON.stringify(value) : null;
        params.push(value);
      }
    }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No updates' });

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE audiences SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    res.json({ success: true, message: 'Audience updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update audience' });
  }
});

// ─── ADD MEMBERS ─────────────────────────────────────────
router.post('/:id/members', async (req, res) => {
  try {
    const { members } = req.body;
    if (!members || !Array.isArray(members) || members.length === 0) {
      return res.status(400).json({ success: false, message: 'Members array required' });
    }

    let added = 0;
    for (const member of members) {
      try {
        await execute(
          'INSERT INTO audience_members (audience_id, tenant_id, contact_id, lead_id, email, phone, full_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [req.params.id, req.tenantId, member.contact_id || null, member.lead_id || null, member.email || null, member.phone || null, member.full_name || null]
        );
        added++;
      } catch (e) {}
    }

    await execute(
      'UPDATE audiences SET member_count = (SELECT COUNT(*) FROM audience_members WHERE audience_id = ? AND status = ?) WHERE id = ?',
      [req.params.id, 'active', req.params.id]
    );

    res.json({ success: true, message: `${added} members added`, data: { added } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to add members' });
  }
});

// ─── REMOVE MEMBER ───────────────────────────────────────
router.delete('/:id/members/:memberId', async (req, res) => {
  try {
    await execute('DELETE FROM audience_members WHERE id = ? AND audience_id = ?', [req.params.memberId, req.params.id]);
    await execute(
      'UPDATE audiences SET member_count = (SELECT COUNT(*) FROM audience_members WHERE audience_id = ? AND status = ?) WHERE id = ?',
      [req.params.id, 'active', req.params.id]
    );
    res.json({ success: true, message: 'Member removed' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to remove member' });
  }
});

// ─── SMART SYNC (Auto-populate from contacts) ────────────
router.post('/:id/sync', async (req, res) => {
  try {
    const [audience] = await query('SELECT * FROM audiences WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!audience) return res.status(404).json({ success: false, message: 'Audience not found' });

    const tenantId = req.tenantId;
    let contacts = [];
    const segType = audience.segment_type;

    // Smart segmentation queries
    if (segType === 'all_clients') {
      contacts = await query('SELECT id, first_name, last_name, email, phone FROM contacts WHERE tenant_id = ?', [tenantId]);
    } else if (segType === 'new_clients') {
      contacts = await query('SELECT id, first_name, last_name, email, phone FROM contacts WHERE tenant_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)', [tenantId]);
    } else if (segType === 'vip_clients') {
      contacts = await query(`
        SELECT c.id, c.first_name, c.last_name, c.email, c.phone
        FROM contacts c
        INNER JOIN invoices i ON c.id = i.customer_id AND i.tenant_id = ?
        WHERE c.tenant_id = ?
        GROUP BY c.id HAVING SUM(i.total) > 1000
      `, [tenantId, tenantId]);
    } else if (segType === 'inactive_clients') {
      contacts = await query(`
        SELECT c.id, c.first_name, c.last_name, c.email, c.phone FROM contacts c
        WHERE c.tenant_id = ? AND c.id NOT IN (
          SELECT DISTINCT customer_id FROM appointments WHERE tenant_id = ? AND date >= DATE_SUB(NOW(), INTERVAL 60 DAY)
        )
      `, [tenantId, tenantId]);
    } else if (segType === 'birthday_month') {
      contacts = await query(`
        SELECT id, first_name, last_name, email, phone FROM contacts
        WHERE tenant_id = ? AND MONTH(date_of_birth) = MONTH(NOW())
      `, [tenantId]);
    } else {
      // Custom criteria
      contacts = await query('SELECT id, first_name, last_name, email, phone FROM contacts WHERE tenant_id = ?', [tenantId]);
    }

    // Clear existing members and re-populate
    await execute('DELETE FROM audience_members WHERE audience_id = ?', [req.params.id]);

    let added = 0;
    for (const c of contacts) {
      try {
        await execute(
          'INSERT INTO audience_members (audience_id, tenant_id, contact_id, email, phone, full_name) VALUES (?, ?, ?, ?, ?, ?)',
          [req.params.id, tenantId, c.id, c.email, c.phone, `${c.first_name || ''} ${c.last_name || ''}`.trim()]
        );
        added++;
      } catch (e) {}
    }

    await execute(
      'UPDATE audiences SET member_count = ?, last_synced_at = NOW() WHERE id = ?',
      [added, req.params.id]
    );

    res.json({ success: true, message: `Audience synced: ${added} members`, data: { synced: added } });
  } catch (error) {
    console.error('Sync audience error:', error);
    res.status(500).json({ success: false, message: 'Failed to sync audience' });
  }
});

// ─── DELETE ──────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    await execute('DELETE FROM audience_members WHERE audience_id = ?', [req.params.id]);
    await execute('DELETE FROM audiences WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Audience deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete audience' });
  }
});

export default router;
