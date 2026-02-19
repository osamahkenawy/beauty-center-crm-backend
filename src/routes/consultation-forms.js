import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

async function ensureTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS consultation_forms (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      form_type ENUM('intake','medical','consent','patch_test','consultation','custom') DEFAULT 'custom',
      fields JSON,
      is_required TINYINT(1) DEFAULT 0,
      applies_to_services JSON,
      is_active TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id)
    )
  `);
  await execute(`
    CREATE TABLE IF NOT EXISTS form_responses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      form_id INT NOT NULL,
      tenant_id INT NOT NULL,
      customer_id INT,
      appointment_id INT,
      responses JSON,
      signed_at DATETIME,
      signature_data TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_form (form_id),
      INDEX idx_tenant (tenant_id),
      INDEX idx_customer (customer_id)
    )
  `);
}

// ── List forms ──
router.get('/', async (req, res) => {
  try {
    await ensureTable();
    const { form_type, active } = req.query;
    let where = 'WHERE tenant_id = ?';
    const params = [req.tenantId];

    if (form_type) { where += ' AND form_type = ?'; params.push(form_type); }
    if (active !== undefined) { where += ' AND is_active = ?'; params.push(active === 'true' ? 1 : 0); }

    const forms = await query(`SELECT * FROM consultation_forms ${where} ORDER BY created_at DESC`, params);
    const data = forms.map(f => ({
      ...f,
      fields: typeof f.fields === 'string' ? JSON.parse(f.fields) : f.fields,
      applies_to_services: typeof f.applies_to_services === 'string' ? JSON.parse(f.applies_to_services) : f.applies_to_services
    }));

    res.json({ success: true, data });
  } catch (error) {
    console.error('List forms error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch forms' });
  }
});

// ── Get single form ──
router.get('/:id', async (req, res) => {
  try {
    await ensureTable();
    const [form] = await query('SELECT * FROM consultation_forms WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!form) return res.status(404).json({ success: false, message: 'Form not found' });

    form.fields = typeof form.fields === 'string' ? JSON.parse(form.fields) : form.fields;
    form.applies_to_services = typeof form.applies_to_services === 'string' ? JSON.parse(form.applies_to_services) : form.applies_to_services;

    // Get response count
    const [cnt] = await query('SELECT COUNT(*) as count FROM form_responses WHERE form_id = ?', [form.id]);
    form.response_count = cnt?.count || 0;

    res.json({ success: true, data: form });
  } catch (error) {
    console.error('Get form error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch form' });
  }
});

// ── Create form ──
router.post('/', async (req, res) => {
  try {
    await ensureTable();
    const { name, description, form_type, fields, is_required, applies_to_services, is_active } = req.body;

    if (!name) return res.status(400).json({ success: false, message: 'Form name required' });

    const result = await execute(`
      INSERT INTO consultation_forms (tenant_id, name, description, form_type, fields, is_required, applies_to_services, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.tenantId, name, description || null, form_type || 'custom',
      fields ? JSON.stringify(fields) : '[]',
      is_required ? 1 : 0,
      applies_to_services ? JSON.stringify(applies_to_services) : null,
      is_active !== false ? 1 : 0
    ]);

    res.status(201).json({ success: true, message: 'Form created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create form error:', error);
    res.status(500).json({ success: false, message: 'Failed to create form' });
  }
});

// ── Update form ──
router.patch('/:id', async (req, res) => {
  try {
    await ensureTable();
    const updates = [];
    const params = [];
    const fields = ['name', 'description', 'form_type', 'is_required', 'is_active'];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        if (f === 'is_required' || f === 'is_active') {
          updates.push(`${f} = ?`);
          params.push(req.body[f] ? 1 : 0);
        } else {
          updates.push(`${f} = ?`);
          params.push(req.body[f]);
        }
      }
    }
    if (req.body.fields !== undefined) {
      updates.push('fields = ?');
      params.push(JSON.stringify(req.body.fields));
    }
    if (req.body.applies_to_services !== undefined) {
      updates.push('applies_to_services = ?');
      params.push(req.body.applies_to_services ? JSON.stringify(req.body.applies_to_services) : null);
    }

    if (updates.length === 0) return res.json({ success: true, message: 'No changes' });

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE consultation_forms SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);

    res.json({ success: true, message: 'Form updated' });
  } catch (error) {
    console.error('Update form error:', error);
    res.status(500).json({ success: false, message: 'Failed to update form' });
  }
});

// ── Delete form ──
router.delete('/:id', async (req, res) => {
  try {
    await ensureTable();
    const [cnt] = await query('SELECT COUNT(*) as count FROM form_responses WHERE form_id = ?', [req.params.id]);
    if (cnt?.count > 0) {
      return res.status(400).json({ success: false, message: `Cannot delete: ${cnt.count} responses exist` });
    }
    await execute('DELETE FROM consultation_forms WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Form deleted' });
  } catch (error) {
    console.error('Delete form error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete form' });
  }
});

// ══════════════════════════════
// Form Responses
// ══════════════════════════════

// ── Submit response ──
router.post('/:id/responses', async (req, res) => {
  try {
    await ensureTable();
    const { customer_id, appointment_id, responses, signature_data } = req.body;

    const result = await execute(`
      INSERT INTO form_responses (form_id, tenant_id, customer_id, appointment_id, responses, signed_at, signature_data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      req.params.id, req.tenantId, customer_id || null, appointment_id || null,
      responses ? JSON.stringify(responses) : '{}',
      signature_data ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
      signature_data || null
    ]);

    res.status(201).json({ success: true, message: 'Response submitted', data: { id: result.insertId } });
  } catch (error) {
    console.error('Submit response error:', error);
    res.status(500).json({ success: false, message: 'Failed to submit response' });
  }
});

// ── List responses for a form ──
router.get('/:id/responses', async (req, res) => {
  try {
    await ensureTable();
    const { customer_id, page = 1, limit = 20 } = req.query;
    let where = 'WHERE fr.form_id = ? AND fr.tenant_id = ?';
    const params = [req.params.id, req.tenantId];

    if (customer_id) { where += ' AND fr.customer_id = ?'; params.push(customer_id); }

    const [countRow] = await query(`SELECT COUNT(*) as cnt FROM form_responses fr ${where}`, params);
    const total = countRow?.cnt || 0;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const rows = await query(`
      SELECT fr.*, c.first_name as customer_first_name, c.last_name as customer_last_name
      FROM form_responses fr
      LEFT JOIN contacts c ON fr.customer_id = c.id
      ${where}
      ORDER BY fr.created_at DESC
      LIMIT ${parseInt(limit)} OFFSET ${offset}
    `, params);

    const data = rows.map(r => ({
      ...r,
      responses: typeof r.responses === 'string' ? JSON.parse(r.responses) : r.responses
    }));

    res.json({
      success: true,
      data,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (error) {
    console.error('List responses error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch responses' });
  }
});

// ── Customer's form history ──
router.get('/customer/:customerId/responses', async (req, res) => {
  try {
    await ensureTable();
    const rows = await query(`
      SELECT fr.*, cf.name as form_name, cf.form_type
      FROM form_responses fr
      LEFT JOIN consultation_forms cf ON fr.form_id = cf.id
      WHERE fr.customer_id = ? AND fr.tenant_id = ?
      ORDER BY fr.created_at DESC
    `, [req.params.customerId, req.tenantId]);

    const data = rows.map(r => ({
      ...r,
      responses: typeof r.responses === 'string' ? JSON.parse(r.responses) : r.responses
    }));

    res.json({ success: true, data });
  } catch (error) {
    console.error('Customer responses error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch customer responses' });
  }
});

export default router;
