import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

async function ensureTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS documents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      file_path VARCHAR(512) NOT NULL,
      file_type VARCHAR(50),
      file_size INT,
      related_type ENUM('account', 'contact', 'deal', 'lead', 'quote', 'other'),
      related_id INT,
      version VARCHAR(20) DEFAULT '1.0',
      description TEXT,
      is_private TINYINT(1) DEFAULT 0,
      owner_id INT,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

router.get('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { related_type, related_id } = req.query;
    let sql = `
      SELECT d.*, s.full_name as owner_name
      FROM documents d
      LEFT JOIN staff s ON d.owner_id = s.id
      WHERE 1=1
    `;
    const params = [];
    
    if (related_type && related_id) {
      sql += ' AND d.related_type = ? AND d.related_id = ?';
      params.push(related_type, related_id);
    }
    sql += ' ORDER BY d.created_at DESC';
    
    const documents = await query(sql, params);
    res.json({ success: true, data: documents });
  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch documents' });
  }
});

router.post('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { title, file_name, file_path, file_type, file_size, related_type, related_id, version, description, is_private } = req.body;
    
    if (!title || !file_name || !file_path) {
      return res.status(400).json({ success: false, message: 'Title, file name, and file path required' });
    }
    
    const result = await execute(
      `INSERT INTO documents (title, file_name, file_path, file_type, file_size, related_type, related_id, version, description, is_private, owner_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [title, file_name, file_path, file_type || null, file_size || null, related_type || null, related_id || null,
       version || '1.0', description || null, is_private ? 1 : 0, req.user.id, req.user.id]
    );
    res.json({ success: true, message: 'Document created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create document error:', error);
    res.status(500).json({ success: false, message: 'Failed to create document' });
  }
});

router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const fields = ['title', 'file_name', 'file_path', 'file_type', 'file_size', 'related_type', 'related_id', 'version', 'description', 'is_private'];
    const updates = [];
    const params = [];
    
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        let value = req.body[f];
        if (f === 'is_private') value = value ? 1 : 0;
        params.push(value);
      }
    }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No updates' });
    
    params.push(req.params.id);
    await execute(`UPDATE documents SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true, message: 'Document updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update document' });
  }
});

router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await execute('DELETE FROM documents WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Document deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete document' });
  }
});

export default router;


