import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Ensure table exists
async function ensureTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS service_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      name_ar VARCHAR(100),
      icon VARCHAR(50) DEFAULT 'sparkles',
      color VARCHAR(20) DEFAULT '#E91E63',
      sort_order INT DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      UNIQUE KEY unique_tenant_category (tenant_id, name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// GET all categories (tenant-scoped)
router.get('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const tenantId = req.tenantId;
    const { active } = req.query;

    let sql = 'SELECT * FROM service_categories WHERE tenant_id = ?';
    const params = [tenantId];

    if (active !== undefined) {
      sql += ' AND is_active = ?';
      params.push(active === 'true' ? 1 : 0);
    }

    sql += ' ORDER BY sort_order ASC, name ASC';

    const categories = await query(sql, params);
    res.json({ success: true, data: categories });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch categories' });
  }
});

// PATCH reorder categories — MUST come before /:id
router.patch('/reorder/bulk', authMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ success: false, message: 'Items array required' });
    }

    for (const item of items) {
      await execute(
        'UPDATE service_categories SET sort_order = ? WHERE id = ? AND tenant_id = ?',
        [item.sort_order, item.id, req.tenantId]
      );
    }

    res.json({ success: true, message: 'Categories reordered' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to reorder' });
  }
});

// GET single category
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const [category] = await query(
      'SELECT * FROM service_categories WHERE id = ? AND tenant_id = ?',
      [req.params.id, tenantId]
    );
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
    res.json({ success: true, data: category });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch category' });
  }
});

// POST create category (admin/manager only)
router.post('/', authMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    await ensureTable();
    const { name, name_ar, icon, color, sort_order } = req.body;
    const tenantId = req.tenantId;

    if (!name) return res.status(400).json({ success: false, message: 'Category name is required' });

    // Check duplicate
    const existing = await query(
      'SELECT id FROM service_categories WHERE tenant_id = ? AND name = ?',
      [tenantId, name]
    );
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'Category already exists' });
    }

    // Get next sort_order if not provided
    let order = sort_order;
    if (order === undefined || order === null) {
      const [maxOrder] = await query(
        'SELECT MAX(sort_order) as max_order FROM service_categories WHERE tenant_id = ?',
        [tenantId]
      );
      order = (maxOrder?.max_order || 0) + 1;
    }

    const result = await execute(
      `INSERT INTO service_categories (tenant_id, name, name_ar, icon, color, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, name, name_ar || null, icon || '✨', color || '#E91E63', order, req.user.id]
    );

    res.json({ success: true, message: 'Category created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create category error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: 'Category name already exists' });
    }
    res.status(500).json({ success: false, message: 'Failed to create category' });
  }
});

// PATCH update category
router.patch('/:id', authMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const fields = ['name', 'name_ar', 'icon', 'color', 'sort_order', 'is_active'];
    const updates = [];
    const params = [];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(f === 'is_active' ? (req.body[f] ? 1 : 0) : req.body[f]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No updates' });

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE service_categories SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    res.json({ success: true, message: 'Category updated' });
  } catch (error) {
    console.error('Update category error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ success: false, message: 'Category name already exists' });
    }
    res.status(500).json({ success: false, message: 'Failed to update category' });
  }
});

// DELETE category (admin only)
router.delete('/:id', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const tenantId = req.tenantId;

    // Check if category has services
    const services = await query(
      'SELECT COUNT(*) as count FROM products WHERE tenant_id = ? AND category_id = ?',
      [tenantId, req.params.id]
    );
    if (services[0]?.count > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete: ${services[0].count} service(s) use this category. Reassign them first.`
      });
    }

    await execute(
      'DELETE FROM service_categories WHERE id = ? AND tenant_id = ?',
      [req.params.id, tenantId]
    );
    res.json({ success: true, message: 'Category deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete category' });
  }
});

export default router;
