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

  // Suppliers table
  await execute(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      name VARCHAR(200) NOT NULL,
      contact_name VARCHAR(150),
      email VARCHAR(150),
      phone VARCHAR(50),
      address TEXT,
      city VARCHAR(100),
      country VARCHAR(100),
      payment_terms ENUM('immediate','net_15','net_30','net_60') DEFAULT 'net_30',
      notes TEXT,
      is_active TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_active (is_active)
    )
  `);

  // Purchase orders header
  await execute(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      supplier_id INT,
      po_number VARCHAR(50),
      status ENUM('draft','ordered','partial','received','cancelled') DEFAULT 'draft',
      ordered_by INT,
      ordered_at DATE,
      expected_at DATE,
      received_at DATE,
      subtotal DECIMAL(12,2) DEFAULT 0,
      tax_amount DECIMAL(12,2) DEFAULT 0,
      shipping_cost DECIMAL(12,2) DEFAULT 0,
      total_amount DECIMAL(12,2) DEFAULT 0,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_status (status),
      INDEX idx_supplier (supplier_id)
    )
  `);

  // Purchase order line items
  await execute(`
    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      po_id INT NOT NULL,
      inventory_id INT NOT NULL,
      quantity_ordered INT NOT NULL DEFAULT 0,
      quantity_received INT DEFAULT 0,
      unit_cost DECIMAL(10,2) DEFAULT 0,
      total_cost DECIMAL(12,2) DEFAULT 0,
      batch_number VARCHAR(100),
      expiry_date DATE,
      notes TEXT,
      INDEX idx_tenant (tenant_id),
      INDEX idx_po (po_id),
      INDEX idx_inv (inventory_id)
    )
  `);

  // Add new columns to inventory if they don't exist
  const cols = await execute(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory'
  `);
  const existing = (cols || []).map(c => c.COLUMN_NAME);
  if (!existing.includes('expiry_date'))
    await execute(`ALTER TABLE inventory ADD COLUMN expiry_date DATE NULL`);
  if (!existing.includes('batch_number'))
    await execute(`ALTER TABLE inventory ADD COLUMN batch_number VARCHAR(100) NULL`);
  if (!existing.includes('supplier_id'))
    await execute(`ALTER TABLE inventory ADD COLUMN supplier_id INT NULL`);
  if (!existing.includes('reorder_point'))
    await execute(`ALTER TABLE inventory ADD COLUMN reorder_point INT DEFAULT 0`);
  if (!existing.includes('reorder_quantity'))
    await execute(`ALTER TABLE inventory ADD COLUMN reorder_quantity INT DEFAULT 0`);

  // Add lat/lng to suppliers if not present
  const suppCols = await execute(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'suppliers'
  `);
  const suppExisting = (suppCols || []).map(c => c.COLUMN_NAME);
  if (!suppExisting.includes('latitude'))
    await execute(`ALTER TABLE suppliers ADD COLUMN latitude DECIMAL(10,8) NULL`);
  if (!suppExisting.includes('longitude'))
    await execute(`ALTER TABLE suppliers ADD COLUMN longitude DECIMAL(11,8) NULL`);
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

// ── GET /reorder-suggestions ──
router.get('/reorder-suggestions', async (req, res) => {
  try {
    const t = req.tenantId;
    await ensureTables(t);
    const rows = await query(`
      SELECT i.*,
        COALESCE(s.name, i.supplier) as supplier_name,
        s.email as supplier_email, s.phone as supplier_phone,
        COALESCE(
          (SELECT SUM(ABS(sm.quantity)) FROM stock_movements sm
           WHERE sm.inventory_id = i.id AND sm.type = 'sale'
             AND sm.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)), 0
        ) as sold_last_30d
      FROM inventory i
      LEFT JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.tenant_id = ? AND i.is_active = 1
        AND i.stock_quantity <= i.reorder_point AND i.reorder_point > 0
      ORDER BY (i.reorder_point - i.stock_quantity) DESC
    `, [t]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Reorder suggestions error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /expiring-soon ──
router.get('/expiring-soon', async (req, res) => {
  try {
    const t = req.tenantId;
    const days = parseInt(req.query.days) || 90;
    await ensureTables(t);
    const rows = await query(`
      SELECT i.*, DATEDIFF(i.expiry_date, CURDATE()) as days_until_expiry
      FROM inventory i
      WHERE i.tenant_id = ? AND i.is_active = 1
        AND i.expiry_date IS NOT NULL
        AND i.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY)
      ORDER BY i.expiry_date ASC
    `, [t, days]);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Expiring soon error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── SUPPLIERS ──────────────────────────────────────────────────────────────

// GET /suppliers
router.get('/suppliers', async (req, res) => {
  try {
    const t = req.tenantId;
    await ensureTables(t);
    const { search } = req.query;
    let where = 'WHERE s.tenant_id = ?';
    const params = [t];
    if (search) {
      where += ' AND (s.name LIKE ? OR s.contact_name LIKE ? OR s.email LIKE ? OR s.phone LIKE ?)';
      const q = `%${search}%`;
      params.push(q, q, q, q);
    }
    const rows = await query(`
      SELECT s.*,
        COUNT(DISTINCT i.id) as product_count,
        COUNT(DISTINCT po.id) as order_count,
        COALESCE(SUM(po.total_amount), 0) as total_ordered
      FROM suppliers s
      LEFT JOIN inventory i ON i.supplier_id = s.id AND i.tenant_id = s.tenant_id
      LEFT JOIN purchase_orders po ON po.supplier_id = s.id AND po.tenant_id = s.tenant_id
      ${where}
      GROUP BY s.id
      ORDER BY s.name ASC
    `, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Suppliers list error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /suppliers
router.post('/suppliers', async (req, res) => {
  try {
    const t = req.tenantId;
    await ensureTables(t);
    const { name, contact_name, email, phone, address, city, country, payment_terms, notes, latitude, longitude } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Supplier name is required' });
    const result = await execute(`
      INSERT INTO suppliers (tenant_id, name, contact_name, email, phone, address, city, country, payment_terms, notes, latitude, longitude)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [t, name, contact_name || null, email || null, phone || null,
        address || null, city || null, country || null,
        payment_terms || 'net_30', notes || null,
        latitude || null, longitude || null]);
    const [created] = await query('SELECT * FROM suppliers WHERE id = ?', [result.insertId]);
    res.json({ success: true, data: created, message: 'Supplier created' });
  } catch (err) {
    console.error('Create supplier error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /suppliers/:id
router.patch('/suppliers/:id', async (req, res) => {
  try {
    const t = req.tenantId;
    const [sup] = await query('SELECT id FROM suppliers WHERE id = ? AND tenant_id = ?', [req.params.id, t]);
    if (!sup) return res.status(404).json({ success: false, message: 'Supplier not found' });
    const fields = [];
    const vals = [];
    const allowed = ['name', 'contact_name', 'email', 'phone', 'address', 'city', 'country', 'payment_terms', 'notes', 'is_active', 'latitude', 'longitude'];
    for (const f of allowed) {
      if (req.body[f] !== undefined) { fields.push(`${f} = ?`); vals.push(req.body[f]); }
    }
    if (!fields.length) return res.status(400).json({ success: false, message: 'Nothing to update' });
    vals.push(req.params.id, t);
    await execute(`UPDATE suppliers SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`, vals);
    const [updated] = await query('SELECT * FROM suppliers WHERE id = ?', [req.params.id]);
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('Update supplier error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /suppliers/:id
router.delete('/suppliers/:id', async (req, res) => {
  try {
    const t = req.tenantId;
    await execute('UPDATE suppliers SET is_active = 0 WHERE id = ? AND tenant_id = ?', [req.params.id, t]);
    res.json({ success: true, message: 'Supplier deactivated' });
  } catch (err) {
    console.error('Delete supplier error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PURCHASE ORDERS ────────────────────────────────────────────────────────

// GET /purchase-orders
router.get('/purchase-orders', async (req, res) => {
  try {
    const t = req.tenantId;
    await ensureTables(t);
    const { status, supplier_id, page = 1, limit = 30 } = req.query;
    let where = 'WHERE po.tenant_id = ?';
    const params = [t];
    if (status) { where += ' AND po.status = ?'; params.push(status); }
    if (supplier_id) { where += ' AND po.supplier_id = ?'; params.push(supplier_id); }

    const limitInt = parseInt(limit) || 30;
    const offset = (parseInt(page) - 1) * limitInt;
    const rows = await query(`
      SELECT po.*, s.name as supplier_name, s.email as supplier_email,
        COUNT(poi.id) as item_count,
        st.full_name as ordered_by_name
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id
      LEFT JOIN purchase_order_items poi ON poi.po_id = po.id
      LEFT JOIN staff st ON st.id = po.ordered_by
      ${where}
      GROUP BY po.id
      ORDER BY po.created_at DESC
      LIMIT ${limitInt} OFFSET ${offset}
    `, params);

    const [cnt] = await query(`SELECT COUNT(*) as total FROM purchase_orders po ${where}`, params);
    res.json({ success: true, data: rows, pagination: { total: cnt?.total || 0, page: parseInt(page), limit: limitInt } });
  } catch (err) {
    console.error('PO list error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /purchase-orders
router.post('/purchase-orders', async (req, res) => {
  try {
    const t = req.tenantId;
    await ensureTables(t);
    const { supplier_id, ordered_at, expected_at, notes, items = [], shipping_cost = 0, tax_amount = 0 } = req.body;
    if (!items.length) return res.status(400).json({ success: false, message: 'At least one item is required' });

    const subtotal = items.reduce((s, i) => s + (parseFloat(i.unit_cost) * parseInt(i.quantity_ordered)), 0);
    const total_amount = subtotal + parseFloat(tax_amount) + parseFloat(shipping_cost);
    const poNum = `PO-${Date.now()}`;

    const result = await execute(`
      INSERT INTO purchase_orders (tenant_id, supplier_id, po_number, status, ordered_by, ordered_at, expected_at, subtotal, tax_amount, shipping_cost, total_amount, notes)
      VALUES (?, ?, ?, 'ordered', ?, ?, ?, ?, ?, ?, ?, ?)
    `, [t, supplier_id || null, poNum, req.user?.id || null,
        ordered_at || null, expected_at || null,
        subtotal, tax_amount, shipping_cost, total_amount, notes || null]);

    const poId = result.insertId;
    for (const item of items) {
      const tc = parseFloat(item.unit_cost) * parseInt(item.quantity_ordered);
      await execute(`
        INSERT INTO purchase_order_items (tenant_id, po_id, inventory_id, quantity_ordered, unit_cost, total_cost, batch_number, expiry_date, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [t, poId, item.inventory_id, item.quantity_ordered, item.unit_cost, tc,
          item.batch_number || null, item.expiry_date || null, item.notes || null]);

      // Update product cost price with latest purchase price
      await execute(`UPDATE inventory SET cost_price = ? WHERE id = ? AND tenant_id = ?`,
        [item.unit_cost, item.inventory_id, t]);
    }

    const [po] = await query('SELECT * FROM purchase_orders WHERE id = ?', [poId]);
    res.json({ success: true, data: po, message: 'Purchase order created' });
  } catch (err) {
    console.error('Create PO error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /purchase-orders/:id
router.get('/purchase-orders/:id', async (req, res) => {
  try {
    const t = req.tenantId;
    const [po] = await query(`
      SELECT po.*, s.name as supplier_name, s.email as supplier_email, s.phone as supplier_phone
      FROM purchase_orders po
      LEFT JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.id = ? AND po.tenant_id = ?
    `, [req.params.id, t]);
    if (!po) return res.status(404).json({ success: false, message: 'PO not found' });

    const items = await query(`
      SELECT poi.*, i.name as product_name, i.sku, i.unit
      FROM purchase_order_items poi
      LEFT JOIN inventory i ON i.id = poi.inventory_id
      WHERE poi.po_id = ? AND poi.tenant_id = ?
    `, [req.params.id, t]);

    res.json({ success: true, data: { ...po, items } });
  } catch (err) {
    console.error('PO detail error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /purchase-orders/:id/receive  — receive all or partial
router.post('/purchase-orders/:id/receive', async (req, res) => {
  try {
    const t = req.tenantId;
    const poId = req.params.id;

    const [po] = await query('SELECT * FROM purchase_orders WHERE id = ? AND tenant_id = ?', [poId, t]);
    if (!po) return res.status(404).json({ success: false, message: 'PO not found' });
    if (po.status === 'cancelled') return res.status(400).json({ success: false, message: 'Cannot receive cancelled PO' });

    const { received_items } = req.body; // [{ poi_id, quantity_received }] or empty = receive all
    const items = await query('SELECT * FROM purchase_order_items WHERE po_id = ? AND tenant_id = ?', [poId, t]);

    for (const poi of items) {
      const override = received_items?.find(r => r.poi_id === poi.id);
      const qtyToReceive = override ? parseInt(override.quantity_received) : (poi.quantity_ordered - poi.quantity_received);
      if (qtyToReceive <= 0) continue;

      // Update inventory stock
      const [inv] = await query('SELECT * FROM inventory WHERE id = ? AND tenant_id = ?', [poi.inventory_id, t]);
      if (!inv) continue;
      const newQty = inv.stock_quantity + qtyToReceive;
      await execute('UPDATE inventory SET stock_quantity = ?, cost_price = ? WHERE id = ? AND tenant_id = ?',
        [newQty, poi.unit_cost, poi.inventory_id, t]);

      // Update expiry and batch on product if provided
      if (poi.expiry_date) await execute('UPDATE inventory SET expiry_date = ?, batch_number = ? WHERE id = ? AND tenant_id = ?',
        [poi.expiry_date, poi.batch_number || inv.batch_number, poi.inventory_id, t]);

      // Record stock movement
      await execute(`
        INSERT INTO stock_movements (tenant_id, inventory_id, type, quantity, previous_quantity, new_quantity,
          unit_cost, total_cost, reference_type, reference_id, notes, created_by)
        VALUES (?, ?, 'purchase', ?, ?, ?, ?, ?, 'purchase_order', ?, ?, ?)
      `, [t, poi.inventory_id, qtyToReceive, inv.stock_quantity, newQty,
          poi.unit_cost, qtyToReceive * poi.unit_cost, poId,
          `Received from PO ${po.po_number}`, req.user?.id || null]);

      // Update line item
      await execute('UPDATE purchase_order_items SET quantity_received = quantity_received + ? WHERE id = ?',
        [qtyToReceive, poi.id]);
    }

    // Determine new PO status
    const updatedItems = await query('SELECT * FROM purchase_order_items WHERE po_id = ?', [poId]);
    const allReceived = updatedItems.every(i => i.quantity_received >= i.quantity_ordered);
    const anyReceived = updatedItems.some(i => i.quantity_received > 0);
    const newStatus = allReceived ? 'received' : anyReceived ? 'partial' : po.status;

    await execute('UPDATE purchase_orders SET status = ?, received_at = ? WHERE id = ? AND tenant_id = ?',
      [newStatus, newStatus === 'received' ? new Date() : null, poId, t]);

    res.json({ success: true, message: `PO ${newStatus === 'received' ? 'fully received' : 'partially received'}` });
  } catch (err) {
    console.error('Receive PO error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /purchase-orders/:id/cancel
router.post('/purchase-orders/:id/cancel', async (req, res) => {
  try {
    const t = req.tenantId;
    await execute("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ? AND tenant_id = ?", [req.params.id, t]);
    res.json({ success: true, message: 'Purchase order cancelled' });
  } catch (err) {
    console.error('Cancel PO error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── INVENTORY REPORTS ──────────────────────────────────────────────────────

// GET /reports/turnover  — movement velocity per product
router.get('/reports/turnover', async (req, res) => {
  try {
    const t = req.tenantId;
    const days = parseInt(req.query.days) || 30;
    const rows = await query(`
      SELECT
        i.id, i.name, i.sku, i.category, i.brand,
        i.stock_quantity, i.cost_price, i.retail_price,
        i.stock_quantity * i.cost_price as stock_value,
        COALESCE(SUM(CASE WHEN sm.type = 'sale' THEN ABS(sm.quantity) ELSE 0 END), 0) as units_sold,
        COALESCE(SUM(CASE WHEN sm.type = 'purchase' THEN sm.quantity ELSE 0 END), 0) as units_purchased,
        COALESCE(SUM(CASE WHEN sm.type = 'sale' THEN ABS(sm.quantity) * sm.unit_cost ELSE 0 END), 0) as cogs,
        COALESCE(SUM(CASE WHEN sm.type IN ('damage','expired') THEN ABS(sm.quantity) ELSE 0 END), 0) as losses
      FROM inventory i
      LEFT JOIN stock_movements sm ON sm.inventory_id = i.id
        AND sm.tenant_id = i.tenant_id
        AND sm.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      WHERE i.tenant_id = ? AND i.is_active = 1
      GROUP BY i.id
      ORDER BY units_sold DESC
      LIMIT 100
    `, [days, t]);

    res.json({ success: true, data: rows, period_days: days });
  } catch (err) {
    console.error('Turnover report error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /reports/valuation  — stock value by category
router.get('/reports/valuation', async (req, res) => {
  try {
    const t = req.tenantId;
    const byCategory = await query(`
      SELECT
        COALESCE(category, 'Uncategorized') as category,
        COUNT(*) as product_count,
        SUM(stock_quantity) as total_units,
        SUM(stock_quantity * cost_price) as cost_value,
        SUM(stock_quantity * retail_price) as retail_value,
        AVG(CASE WHEN cost_price > 0 AND retail_price > 0
          THEN ((retail_price - cost_price) / retail_price * 100) END) as avg_margin_pct
      FROM inventory
      WHERE tenant_id = ? AND is_active = 1
      GROUP BY category
      ORDER BY retail_value DESC
    `, [t]);

    const [totals] = await query(`
      SELECT
        COUNT(*) as total_products,
        SUM(stock_quantity) as total_units,
        SUM(stock_quantity * cost_price) as total_cost_value,
        SUM(stock_quantity * retail_price) as total_retail_value,
        SUM(stock_quantity * (retail_price - cost_price)) as potential_profit
      FROM inventory WHERE tenant_id = ? AND is_active = 1
    `, [t]);

    res.json({ success: true, data: { byCategory, totals } });
  } catch (err) {
    console.error('Valuation report error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /reports/aging  — how long stock has been sitting (slow movers)
router.get('/reports/aging', async (req, res) => {
  try {
    const t = req.tenantId;
    const rows = await query(`
      SELECT
        i.id, i.name, i.sku, i.category, i.brand,
        i.stock_quantity, i.cost_price, i.retail_price,
        i.stock_quantity * i.cost_price as tied_up_capital,
        MAX(CASE WHEN sm.type = 'sale' THEN sm.created_at END) as last_sold_at,
        DATEDIFF(NOW(), MAX(CASE WHEN sm.type = 'sale' THEN sm.created_at END)) as days_since_last_sale,
        MIN(CASE WHEN sm.type = 'purchase' THEN sm.created_at END) as first_purchased_at,
        DATEDIFF(NOW(), MIN(CASE WHEN sm.type = 'purchase' THEN sm.created_at END)) as days_in_stock
      FROM inventory i
      LEFT JOIN stock_movements sm ON sm.inventory_id = i.id AND sm.tenant_id = i.tenant_id
      WHERE i.tenant_id = ? AND i.is_active = 1 AND i.stock_quantity > 0
      GROUP BY i.id
      ORDER BY days_since_last_sale DESC
      LIMIT 100
    `, [t]);

    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('Aging report error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /:id (detail) ──
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
      unit, image_url, supplier, supplier_contact, branch_id, is_active,
      supplier_id, expiry_date, batch_number, reorder_point, reorder_quantity
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
        unit, image_url, supplier, supplier_contact, branch_id, is_active,
        supplier_id, expiry_date, batch_number, reorder_point, reorder_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      tenantId, name, name_ar || null, sku || null, barcode || null,
      category || null, brand || null, description || null,
      cost_price || 0, retail_price || 0, currency || 'AED',
      stock_quantity || 0, low_stock_threshold || 5,
      unit || 'piece', image_url || null,
      supplier || null, supplier_contact || null,
      branch_id || null, is_active !== undefined ? is_active : 1,
      supplier_id || null, expiry_date || null, batch_number || null,
      reorder_point || 0, reorder_quantity || 0
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
      'unit', 'image_url', 'supplier', 'supplier_contact', 'branch_id', 'is_active',
      'supplier_id', 'expiry_date', 'batch_number', 'reorder_point', 'reorder_quantity'
    ];

    const dateFields = new Set(['expiry_date']);

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        fields.push(`${field} = ?`);
        // Coerce empty strings to null for DATE columns
        const val = req.body[field];
        values.push(dateFields.has(field) && val === '' ? null : val);
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
