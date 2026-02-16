import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

async function ensureTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS workflows (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      entity_type ENUM('lead', 'contact', 'account', 'deal', 'activity') NOT NULL,
      trigger_event ENUM('created', 'updated', 'stage_changed', 'status_changed', 'field_changed', 'assigned') NOT NULL,
      trigger_field VARCHAR(100),
      conditions JSON,
      actions JSON NOT NULL,
      is_active TINYINT(1) DEFAULT 1,
      execution_count INT DEFAULT 0,
      last_executed_at TIMESTAMP NULL,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  
  await execute(`
    CREATE TABLE IF NOT EXISTS workflow_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      workflow_id INT NOT NULL,
      entity_type VARCHAR(50),
      entity_id INT,
      trigger_event VARCHAR(50),
      status ENUM('success', 'failed', 'skipped') DEFAULT 'success',
      result JSON,
      error_message TEXT,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { entity_type, active } = req.query;
    let sql = 'SELECT * FROM workflows WHERE 1=1';
    const params = [];
    
    if (entity_type) { sql += ' AND entity_type = ?'; params.push(entity_type); }
    if (active !== undefined) { sql += ' AND is_active = ?'; params.push(active === 'true' ? 1 : 0); }
    sql += ' ORDER BY name';
    
    const workflows = await query(sql, params);
    const parsed = workflows.map(w => ({
      ...w,
      conditions: typeof w.conditions === 'string' ? JSON.parse(w.conditions) : (w.conditions || []),
      actions: typeof w.actions === 'string' ? JSON.parse(w.actions) : (w.actions || [])
    }));
    
    res.json({ success: true, data: parsed });
  } catch (error) {
    console.error('Get workflows error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch workflows' });
  }
});

router.get('/logs', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { workflow_id, limit = 50 } = req.query;
    let sql = `
      SELECT wl.*, w.name as workflow_name
      FROM workflow_logs wl
      LEFT JOIN workflows w ON wl.workflow_id = w.id
      WHERE 1=1
    `;
    const params = [];
    if (workflow_id) { sql += ' AND wl.workflow_id = ?'; params.push(workflow_id); }
    sql += ` ORDER BY wl.executed_at DESC LIMIT ${parseInt(limit)}`;
    
    const logs = await query(sql, params);
    res.json({ success: true, data: logs });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch workflow logs' });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { name, description, entity_type, trigger_event, trigger_field, conditions, actions, is_active } = req.body;
    
    if (!name || !entity_type || !trigger_event || !actions || actions.length === 0) {
      return res.status(400).json({ success: false, message: 'Name, entity type, trigger event, and at least one action required' });
    }
    
    const result = await execute(
      `INSERT INTO workflows (name, description, entity_type, trigger_event, trigger_field, conditions, actions, is_active, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, description || null, entity_type, trigger_event, trigger_field || null,
       conditions ? JSON.stringify(conditions) : null, JSON.stringify(actions), is_active !== false ? 1 : 0, req.user.id]
    );
    res.json({ success: true, message: 'Workflow created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create workflow error:', error);
    res.status(500).json({ success: false, message: 'Failed to create workflow' });
  }
});

router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const fields = ['name', 'description', 'entity_type', 'trigger_event', 'trigger_field', 'conditions', 'actions', 'is_active'];
    const updates = [];
    const params = [];
    
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        let value = req.body[f];
        if (f === 'is_active') value = value ? 1 : 0;
        if (f === 'conditions' || f === 'actions') value = JSON.stringify(value);
        params.push(value);
      }
    }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No updates' });
    
    params.push(req.params.id);
    await execute(`UPDATE workflows SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true, message: 'Workflow updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update workflow' });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await execute('DELETE FROM workflow_logs WHERE workflow_id = ?', [req.params.id]);
    await execute('DELETE FROM workflows WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Workflow deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete workflow' });
  }
});

export default router;


