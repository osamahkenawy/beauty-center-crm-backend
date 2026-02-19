import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

// ── Ensure tables ──
async function ensureTables(tenantId) {
  await execute(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      branch_id INT,
      name VARCHAR(200) NOT NULL,
      name_ar VARCHAR(200),
      sku VARCHAR(50),
      barcode VARCHAR(50),
      category VARCHAR(100),
      brand VARCHAR(100),
      description TEXT,
      cost_price DECIMAL(10,2) DEFAULT 0,
      retail_price DECIMAL(10,2) DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'AED',
      stock_quantity INT DEFAULT 0,
      low_stock_threshold INT DEFAULT 5,
      unit VARCHAR(20) DEFAULT 'piece',
      image_url VARCHAR(500),
      supplier VARCHAR(200),
      supplier_contact VARCHAR(200),
      is_active TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_branch (branch_id),
      INDEX idx_sku (sku),
      INDEX idx_barcode (barcode),
      INDEX idx_category (category),
      INDEX idx_active (is_active)
    )
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      inventory_id INT NOT NULL,
      type ENUM('purchase','sale','adjustment','transfer','return','damage','expired') DEFAULT 'adjustment',
      quantity INT NOT NULL,
      previous_quantity INT DEFAULT 0,
      new_quantity INT DEFAULT 0,
      unit_cost DECIMAL(10,2),
      total_cost DECIMAL(10,2),
      reference_type VARCHAR(50),
      reference_id INT,
      from_branch_id INT,
      to_branch_id INT,
      notes TEXT,
      created_by INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_inventory (inventory_id),
      INDEX idx_type (type),
      INDEX idx_date (created_at)
    )
  `);

  // Low stock alerts table
  await execute(`
    CREATE TABLE IF NOT EXISTS stock_alerts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      inventory_id INT NOT NULL,
      alert_type ENUM('low_stock','out_of_stock','expiring') DEFAULT 'low_stock',
      message TEXT,
      is_read TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_read (is_read)
    )
  `);
}

// ── GET /stats ──
router.get('/stats', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    await ensureTables(tenantId);

    const [stats] = await query(`
      SELECT 
        COUNT(*) as total_products,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_products,
        SUM(CASE WHEN stock_quantity <= low_stock_threshold AND stock_quantity > 0 THEN 1 ELSE 0 END) as low_stock,
        SUM(CASE WHEN stock_quantity = 0 THEN 1 ELSE 0 END) as out_of_stock,
        SUM(stock_quantity) as total_units,
        SUM(stock_quantity * cost_price) as total_cost_value,
        SUM(stock_quantity * retail_price) as total_retail_value,
        COUNT(DISTINCT category) as total_categories,
        COUNT(DISTINCT brand) as total_brands
      FROM inventory
      WHERE tenant_id = ?
    `, [tenantId]);

    // Recent movements count
    const [movementStats] = await query(`
      SELECT 
        COUNT(*) as total_movements,
        SUM(CASE WHEN type = 'purchase' THEN 1 ELSE 0 END) as purchases,
        SUM(CASE WHEN type = 'sale' THEN 1 ELSE 0 END) as sales,
        SUM(CASE WHEN type = 'adjustment' THEN 1 ELSE 0 END) as adjustments,
        SUM(CASE WHEN type = 'return' THEN 1 ELSE 0 END) as returns
      FROM stock_movements
      WHERE tenant_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    `, [tenantId]);

    // Unread alerts
    const [alertStats] = await query(`
      SELECT COUNT(*) as unread_alerts
      FROM stock_alerts
      WHERE tenant_id = ? AND is_read = 0
    `, [tenantId]);

    res.json({
      success: true,
      data: {
        ...stats,
        ...movementStats,
        unread_alerts: alertStats?.unread_alerts || 0
      }
    });
  } catch (err) {
    console.error('Inventory stats error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET / (list) ──
router.get('/', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    await ensureTables(tenantId);

    const { search, category, brand, branch_id, status, low_stock, page = 1, limit = 50, sort = 'name', order = 'ASC' } = req.query;

    let where = 'WHERE i.tenant_id = ?';
    const params = [tenantId];

    if (search) {
      where += ' AND (i.name LIKE ? OR i.name_ar LIKE ? OR i.sku LIKE ? OR i.barcode LIKE ? OR i.brand LIKE ?)';
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }
    if (category) {
      where += ' AND i.category = ?';
      params.push(category);
    }
    if (brand) {
      where += ' AND i.brand = ?';
      params.push(brand);
    }
    if (branch_id) {
      where += ' AND i.branch_id = ?';
      params.push(branch_id);
    }
    if (status === 'active') {
      where += ' AND i.is_active = 1';
    } else if (status === 'inactive') {
      where += ' AND i.is_active = 0';
    }
    if (low_stock === 'true') {
      where += ' AND i.stock_quantity <= i.low_stock_threshold';
    }

    const allowedSorts = ['name', 'sku', 'stock_quantity', 'retail_price', 'cost_price', 'created_at', 'category', 'brand'];
    const sortCol = allowedSorts.includes(sort) ? `i.${sort}` : 'i.name';
    const sortOrder = order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const limitInt = parseInt(limit) || 50;
    const pageInt = parseInt(page) || 1;
    const offsetInt = (pageInt - 1) * limitInt;

    const rows = await query(`
      SELECT i.*, b.name as branch_name
      FROM inventory i
      LEFT JOIN branches b ON b.id = i.branch_id
      ${where}
      ORDER BY ${sortCol} ${sortOrder}
      LIMIT ${limitInt} OFFSET ${offsetInt}
    `, params);

    const [countResult] = await query(`
      SELECT COUNT(*) as total FROM inventory i ${where}
    `, params);

    // Get categories and brands for filters
    const categories = await query(`
      SELECT DISTINCT category FROM inventory WHERE tenant_id = ? AND category IS NOT NULL AND category != '' ORDER BY category
    `, [tenantId]);

    const brands = await query(`
      SELECT DISTINCT brand FROM inventory WHERE tenant_id = ? AND brand IS NOT NULL AND brand != '' ORDER BY brand
    `, [tenantId]);

    res.json({
      success: true,
      data: rows,
      pagination: {
        total: countResult?.total || 0,
        page: pageInt,
        limit: limitInt,
        pages: Math.ceil((countResult?.total || 0) / limitInt)
      },
      filters: {
        categories: categories.map(c => c.category),
        brands: brands.map(b => b.brand)
      }
    });
  } catch (err) {
    console.error('Inventory list error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /low-stock ──
router.get('/low-stock', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    await ensureTables(tenantId);

    const rows = await query(`
      SELECT i.*, b.name as branch_name
      FROM inventory i
      LEFT JOIN branches b ON b.id = i.branch_id
      WHERE i.tenant_id = ? AND i.is_active = 1 AND i.stock_quantity <= i.low_stock_threshold
      ORDER BY i.stock_quantity ASC
    `, [tenantId]);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Low stock error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /alerts ──
router.get('/alerts', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    await ensureTables(tenantId);

    const rows = await query(`
      SELECT sa.*, i.name as product_name, i.sku, i.stock_quantity
      FROM stock_alerts sa
      LEFT JOIN inventory i ON i.id = sa.inventory_id
      WHERE sa.tenant_id = ?
      ORDER BY sa.is_read ASC, sa.created_at DESC
      LIMIT 50
    `, [tenantId]);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Alerts error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /alerts/mark-read ──
router.post('/alerts/mark-read', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { alert_ids } = req.body;

    if (alert_ids && alert_ids.length > 0) {
      const placeholders = alert_ids.map(() => '?').join(',');
      await execute(`
        UPDATE stock_alerts SET is_read = 1 WHERE tenant_id = ? AND id IN (${placeholders})
      `, [tenantId, ...alert_ids]);
    } else {
      await execute(`
        UPDATE stock_alerts SET is_read = 1 WHERE tenant_id = ?
      `, [tenantId]);
    }

    res.json({ success: true, message: 'Alerts marked as read' });
  } catch (err) {
    console.error('Mark alerts error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /:id ──
router.get('/:id', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    await ensureTables(tenantId);

    const [item] = await query(`
      SELECT i.*, b.name as branch_name
      FROM inventory i
      LEFT JOIN branches b ON b.id = i.branch_id
      WHERE i.id = ? AND i.tenant_id = ?
    `, [req.params.id, tenantId]);

    if (!item) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    // Get recent stock movements
    const movements = await query(`
      SELECT sm.*, s.full_name as staff_name
      FROM stock_movements sm
      LEFT JOIN staff s ON s.id = sm.created_by
      WHERE sm.inventory_id = ? AND sm.tenant_id = ?
      ORDER BY sm.created_at DESC
      LIMIT 20
    `, [req.params.id, tenantId]);

    res.json({ success: true, data: { ...item, movements } });
  } catch (err) {
    console.error('Inventory detail error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST / (create) ──
router.post('/', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    await ensureTables(tenantId);

    const {
      name, name_ar, sku, barcode, category, brand, description,
      cost_price, retail_price, currency, stock_quantity, low_stock_threshold,
      unit, image_url, supplier, supplier_contact, branch_id, is_active
    } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, message: 'Product name is required' });
    }

    // Check for duplicate SKU
    if (sku) {
      const [existing] = await query(
        'SELECT id FROM inventory WHERE tenant_id = ? AND sku = ?',
        [tenantId, sku]
      );
      if (existing) {
        return res.status(400).json({ success: false, message: 'SKU already exists' });
      }
    }

    const result = await execute(`
      INSERT INTO inventory (tenant_id, name, name_ar, sku, barcode, category, brand,
        description, cost_price, retail_price, currency, stock_quantity, low_stock_threshold,
        unit, image_url, supplier, supplier_contact, branch_id, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      tenantId, name, name_ar || null, sku || null, barcode || null,
      category || null, brand || null, description || null,
      cost_price || 0, retail_price || 0, currency || 'AED',
      stock_quantity || 0, low_stock_threshold || 5,
      unit || 'piece', image_url || null,
      supplier || null, supplier_contact || null,
      branch_id || null, is_active !== undefined ? is_active : 1
    ]);

    // Record initial stock if any
    const initQty = parseInt(stock_quantity) || 0;
    if (initQty > 0) {
      await execute(`
        INSERT INTO stock_movements (tenant_id, inventory_id, type, quantity, previous_quantity, new_quantity, notes, created_by)
        VALUES (?, ?, 'purchase', ?, 0, ?, 'Initial stock', ?)
      `, [tenantId, result.insertId, initQty, initQty, req.user?.id || null]);
    }

    const [created] = await query('SELECT * FROM inventory WHERE id = ?', [result.insertId]);
    res.json({ success: true, data: created, message: 'Product created successfully' });
  } catch (err) {
    console.error('Create inventory error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /:id (update) ──
router.patch('/:id', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const itemId = req.params.id;

    const [existing] = await query(
      'SELECT * FROM inventory WHERE id = ? AND tenant_id = ?',
      [itemId, tenantId]
    );
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const fields = [];
    const values = [];
    const allowedFields = [
      'name', 'name_ar', 'sku', 'barcode', 'category', 'brand', 'description',
      'cost_price', 'retail_price', 'currency', 'low_stock_threshold',
      'unit', 'image_url', 'supplier', 'supplier_contact', 'branch_id', 'is_active'
    ];

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    values.push(itemId, tenantId);
    await execute(`UPDATE inventory SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`, values);

    const [updated] = await query('SELECT * FROM inventory WHERE id = ?', [itemId]);
    res.json({ success: true, data: updated, message: 'Product updated successfully' });
  } catch (err) {
    console.error('Update inventory error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /:id/stock (adjust stock) ──
router.post('/:id/stock', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const itemId = req.params.id;

    const [item] = await query(
      'SELECT * FROM inventory WHERE id = ? AND tenant_id = ?',
      [itemId, tenantId]
    );
    if (!item) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const { type, quantity, unit_cost, notes, from_branch_id, to_branch_id, reference_type, reference_id } = req.body;

    if (!type || !quantity) {
      return res.status(400).json({ success: false, message: 'Type and quantity are required' });
    }

    const qty = parseInt(quantity);
    const prevQty = item.stock_quantity;
    let newQty = prevQty;

    switch (type) {
      case 'purchase':
      case 'return':
        newQty = prevQty + Math.abs(qty);
        break;
      case 'sale':
      case 'damage':
      case 'expired':
        newQty = prevQty - Math.abs(qty);
        if (newQty < 0) newQty = 0;
        break;
      case 'adjustment':
        newQty = qty; // Direct set
        break;
      case 'transfer':
        newQty = prevQty - Math.abs(qty);
        if (newQty < 0) {
          return res.status(400).json({ success: false, message: 'Insufficient stock for transfer' });
        }
        break;
      default:
        return res.status(400).json({ success: false, message: 'Invalid movement type' });
    }

    // Update stock quantity
    await execute(
      'UPDATE inventory SET stock_quantity = ? WHERE id = ? AND tenant_id = ?',
      [newQty, itemId, tenantId]
    );

    // Record movement
    const totalCost = unit_cost ? (Math.abs(qty) * parseFloat(unit_cost)) : null;
    await execute(`
      INSERT INTO stock_movements (tenant_id, inventory_id, type, quantity, previous_quantity,
        new_quantity, unit_cost, total_cost, from_branch_id, to_branch_id,
        reference_type, reference_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      tenantId, itemId, type, Math.abs(qty), prevQty, newQty,
      unit_cost || null, totalCost, from_branch_id || null, to_branch_id || null,
      reference_type || null, reference_id || null, notes || null, req.user?.id || null
    ]);

    // Check for low stock alert
    if (newQty <= item.low_stock_threshold && newQty > 0 && prevQty > item.low_stock_threshold) {
      await execute(`
        INSERT INTO stock_alerts (tenant_id, inventory_id, alert_type, message)
        VALUES (?, ?, 'low_stock', ?)
      `, [tenantId, itemId, `Low stock alert: ${item.name} has only ${newQty} ${item.unit}(s) remaining`]);
    }

    // Check for out of stock alert
    if (newQty === 0 && prevQty > 0) {
      await execute(`
        INSERT INTO stock_alerts (tenant_id, inventory_id, alert_type, message)
        VALUES (?, ?, 'out_of_stock', ?)
      `, [tenantId, itemId, `Out of stock: ${item.name} is now out of stock`]);
    }

    const [updated] = await query('SELECT * FROM inventory WHERE id = ?', [itemId]);
    res.json({
      success: true,
      data: updated,
      message: `Stock ${type}: ${prevQty} → ${newQty}`,
      movement: { type, quantity: Math.abs(qty), previous: prevQty, new: newQty }
    });
  } catch (err) {
    console.error('Stock adjustment error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /:id/movements (stock history) ──
router.get('/:id/movements', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { page = 1, limit = 20 } = req.query;
    const limitInt = parseInt(limit) || 20;
    const pageInt = parseInt(page) || 1;
    const offsetInt = (pageInt - 1) * limitInt;

    const movements = await query(`
      SELECT sm.*, 
        s.full_name as staff_name,
        i.name as product_name, i.sku
      FROM stock_movements sm
      LEFT JOIN staff s ON s.id = sm.created_by
      LEFT JOIN inventory i ON i.id = sm.inventory_id
      WHERE sm.inventory_id = ? AND sm.tenant_id = ?
      ORDER BY sm.created_at DESC
      LIMIT ${limitInt} OFFSET ${offsetInt}
    `, [req.params.id, tenantId]);

    const [countResult] = await query(
      'SELECT COUNT(*) as total FROM stock_movements WHERE inventory_id = ? AND tenant_id = ?',
      [req.params.id, tenantId]
    );

    res.json({
      success: true,
      data: movements,
      pagination: {
        total: countResult?.total || 0,
        page: pageInt,
        limit: limitInt
      }
    });
  } catch (err) {
    console.error('Movement history error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /bulk-stock (bulk stock update) ──
router.post('/bulk-stock', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const { items } = req.body; // [{ id, quantity, type, notes }]

    if (!items || !items.length) {
      return res.status(400).json({ success: false, message: 'Items array is required' });
    }

    const results = [];
    for (const item of items) {
      const [product] = await query(
        'SELECT * FROM inventory WHERE id = ? AND tenant_id = ?',
        [item.id, tenantId]
      );
      if (!product) continue;

      const prevQty = product.stock_quantity;
      let newQty = item.type === 'adjustment' ? item.quantity : prevQty + item.quantity;
      if (newQty < 0) newQty = 0;

      await execute(
        'UPDATE inventory SET stock_quantity = ? WHERE id = ? AND tenant_id = ?',
        [newQty, item.id, tenantId]
      );

      await execute(`
        INSERT INTO stock_movements (tenant_id, inventory_id, type, quantity, previous_quantity, new_quantity, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [tenantId, item.id, item.type || 'adjustment', Math.abs(item.quantity), prevQty, newQty, item.notes || 'Bulk update', req.user?.id || null]);

      results.push({ id: item.id, name: product.name, previous: prevQty, new: newQty });
    }

    res.json({ success: true, data: results, message: `${results.length} products updated` });
  } catch (err) {
    console.error('Bulk stock error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /:id ──
router.delete('/:id', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const itemId = req.params.id;

    const [item] = await query(
      'SELECT * FROM inventory WHERE id = ? AND tenant_id = ?',
      [itemId, tenantId]
    );
    if (!item) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    // Soft check — if it has movements, just deactivate
    const [movementCount] = await query(
      'SELECT COUNT(*) as cnt FROM stock_movements WHERE inventory_id = ? AND tenant_id = ?',
      [itemId, tenantId]
    );

    if (movementCount?.cnt > 0) {
      await execute(
        'UPDATE inventory SET is_active = 0 WHERE id = ? AND tenant_id = ?',
        [itemId, tenantId]
      );
      res.json({ success: true, message: 'Product deactivated (has stock history)' });
    } else {
      await execute('DELETE FROM inventory WHERE id = ? AND tenant_id = ?', [itemId, tenantId]);
      res.json({ success: true, message: 'Product deleted' });
    }
  } catch (err) {
    console.error('Delete inventory error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
