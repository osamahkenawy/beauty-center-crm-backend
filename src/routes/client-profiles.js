import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

// Ensure client_preferences table
async function ensureTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS client_preferences (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      customer_id INT NOT NULL,
      preferred_staff JSON,
      preferred_services JSON,
      allergies TEXT,
      skin_type VARCHAR(50),
      hair_type VARCHAR(50),
      notes TEXT,
      tags JSON,
      communication_preference ENUM('email','sms','whatsapp','none') DEFAULT 'email',
      birthday DATE,
      anniversary DATE,
      referral_source VARCHAR(100),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY idx_tenant_customer (tenant_id, customer_id)
    )
  `);
  await execute(`
    CREATE TABLE IF NOT EXISTS client_photos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      customer_id INT NOT NULL,
      photo_url VARCHAR(500) NOT NULL,
      photo_type ENUM('before','after','progress','other') DEFAULT 'other',
      appointment_id INT,
      service_id INT,
      description TEXT,
      taken_at DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_customer (customer_id, tenant_id)
    )
  `);
}

// ════════════════════════════════════════
// Full client profile (aggregated view)
// ════════════════════════════════════════
router.get('/:id', async (req, res) => {
  try {
    await ensureTable();
    const customerId = req.params.id;
    const tenantId = req.tenantId;

    // Basic info
    const [client] = await query(
      'SELECT * FROM contacts WHERE id = ? AND tenant_id = ?',
      [customerId, tenantId]
    );
    if (!client) return res.status(404).json({ success: false, message: 'Client not found' });

    // Preferences
    const [prefs] = await query(
      'SELECT * FROM client_preferences WHERE customer_id = ? AND tenant_id = ?',
      [customerId, tenantId]
    );

    // Appointment history
    const appointments = await query(`
      SELECT a.*, p.name as service_name, s.full_name as staff_name
      FROM appointments a
      LEFT JOIN products p ON a.service_id = p.id
      LEFT JOIN staff s ON a.staff_id = s.id
      WHERE a.customer_id = ? AND a.tenant_id = ?
      ORDER BY a.start_time DESC
      LIMIT 50
    `, [customerId, tenantId]);

    // Spending summary
    const [spending] = await query(`
      SELECT 
        COALESCE(SUM(i.total), 0) as total_spent,
        COUNT(DISTINCT i.id) as total_invoices,
        COALESCE(AVG(i.total), 0) as avg_spend,
        MAX(i.created_at) as last_payment_date
      FROM invoices i 
      WHERE i.customer_id = ? AND i.tenant_id = ? AND i.status = 'paid'
    `, [customerId, tenantId]);

    // Loyalty
    const [loyalty] = await query(
      'SELECT * FROM loyalty_points WHERE customer_id = ? AND tenant_id = ?',
      [customerId, tenantId]
    );

    // Active packages
    const packages = await query(`
      SELECT cp.*, pk.name as package_name, pk.price
      FROM customer_packages cp
      LEFT JOIN packages pk ON cp.package_id = pk.id
      WHERE cp.customer_id = ? AND cp.tenant_id = ? AND cp.status = 'active'
    `, [customerId, tenantId]);

    // Active memberships
    const memberships = await query(`
      SELECT cm.*, mp.name as plan_name, mp.price, mp.billing_period
      FROM customer_memberships cm
      LEFT JOIN membership_plans mp ON cm.plan_id = mp.id
      WHERE cm.customer_id = ? AND cm.tenant_id = ? AND cm.status IN ('active', 'paused')
    `, [customerId, tenantId]);

    // Reviews given
    const reviews = await query(`
      SELECT r.*, p.name as service_name, s.full_name as staff_name
      FROM reviews r
      LEFT JOIN products p ON r.service_id = p.id
      LEFT JOIN staff s ON r.staff_id = s.id
      WHERE r.customer_id = ? AND r.tenant_id = ?
      ORDER BY r.created_at DESC LIMIT 10
    `, [customerId, tenantId]);

    // Photos
    const photos = await query(`
      SELECT cp.*, p.name as service_name
      FROM client_photos cp
      LEFT JOIN products p ON cp.service_id = p.id
      WHERE cp.customer_id = ? AND cp.tenant_id = ?
      ORDER BY cp.created_at DESC LIMIT 20
    `, [customerId, tenantId]);

    // Form responses
    const formResponses = await query(`
      SELECT fr.*, cf.name as form_name, cf.form_type
      FROM form_responses fr
      LEFT JOIN consultation_forms cf ON fr.form_id = cf.id
      WHERE fr.customer_id = ? AND fr.tenant_id = ?
      ORDER BY fr.created_at DESC LIMIT 10
    `, [customerId, tenantId]);

    // Patch tests
    const patchTests = await query(`
      SELECT pt.*, p.name as service_name
      FROM patch_tests pt
      LEFT JOIN products p ON pt.service_id = p.id
      WHERE pt.customer_id = ? AND pt.tenant_id = ?
      ORDER BY pt.test_date DESC LIMIT 10
    `, [customerId, tenantId]);

    // Stats
    const appointmentStats = {
      total: appointments.length,
      completed: appointments.filter(a => a.status === 'completed').length,
      cancelled: appointments.filter(a => a.status === 'cancelled').length,
      no_show: appointments.filter(a => a.status === 'no_show').length,
      upcoming: appointments.filter(a => new Date(a.start_time) >= new Date() && a.status !== 'cancelled').length,
    };

    // Top services
    const serviceCount = {};
    appointments.filter(a => a.status === 'completed').forEach(a => {
      const name = a.service_name || 'Unknown';
      serviceCount[name] = (serviceCount[name] || 0) + 1;
    });
    const topServices = Object.entries(serviceCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    // Parse JSON fields in preferences
    if (prefs) {
      prefs.preferred_staff = typeof prefs.preferred_staff === 'string' ? JSON.parse(prefs.preferred_staff) : prefs.preferred_staff;
      prefs.preferred_services = typeof prefs.preferred_services === 'string' ? JSON.parse(prefs.preferred_services) : prefs.preferred_services;
      prefs.tags = typeof prefs.tags === 'string' ? JSON.parse(prefs.tags) : prefs.tags;
    }

    res.json({
      success: true,
      data: {
        ...client,
        preferences: prefs || null,
        appointments: appointments.slice(0, 20),
        appointment_stats: appointmentStats,
        spending: {
          total_spent: parseFloat(spending?.total_spent || 0),
          total_invoices: spending?.total_invoices || 0,
          avg_spend: parseFloat(spending?.avg_spend || 0),
          last_payment: spending?.last_payment_date || null
        },
        loyalty: loyalty || null,
        top_services: topServices,
        packages,
        memberships,
        reviews,
        photos,
        form_responses: formResponses,
        patch_tests: patchTests
      }
    });
  } catch (error) {
    console.error('Client profile error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch client profile' });
  }
});

// ════════════════════════════════════════
// Update preferences
// ════════════════════════════════════════
router.put('/:id/preferences', async (req, res) => {
  try {
    await ensureTable();
    const customerId = req.params.id;
    const {
      preferred_staff, preferred_services, allergies, skin_type, hair_type,
      notes, tags, communication_preference, birthday, anniversary, referral_source
    } = req.body;

    await execute(`
      INSERT INTO client_preferences (tenant_id, customer_id, preferred_staff, preferred_services, allergies, 
        skin_type, hair_type, notes, tags, communication_preference, birthday, anniversary, referral_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        preferred_staff = VALUES(preferred_staff),
        preferred_services = VALUES(preferred_services),
        allergies = VALUES(allergies),
        skin_type = VALUES(skin_type),
        hair_type = VALUES(hair_type),
        notes = VALUES(notes),
        tags = VALUES(tags),
        communication_preference = VALUES(communication_preference),
        birthday = VALUES(birthday),
        anniversary = VALUES(anniversary),
        referral_source = VALUES(referral_source)
    `, [
      req.tenantId, customerId,
      preferred_staff ? JSON.stringify(preferred_staff) : null,
      preferred_services ? JSON.stringify(preferred_services) : null,
      allergies || null, skin_type || null, hair_type || null,
      notes || null,
      tags ? JSON.stringify(tags) : null,
      communication_preference || 'email',
      birthday || null, anniversary || null, referral_source || null
    ]);

    res.json({ success: true, message: 'Preferences updated' });
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ success: false, message: 'Failed to update preferences' });
  }
});

// ════════════════════════════════════════
// Photos
// ════════════════════════════════════════
router.post('/:id/photos', async (req, res) => {
  try {
    await ensureTable();
    const { photo_url, photo_type, appointment_id, service_id, description, taken_at } = req.body;

    if (!photo_url) return res.status(400).json({ success: false, message: 'Photo URL required' });

    const result = await execute(`
      INSERT INTO client_photos (tenant_id, customer_id, photo_url, photo_type, appointment_id, service_id, description, taken_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [req.tenantId, req.params.id, photo_url, photo_type || 'other', appointment_id || null, service_id || null, description || null, taken_at || null]);

    res.status(201).json({ success: true, message: 'Photo added', data: { id: result.insertId } });
  } catch (error) {
    console.error('Add photo error:', error);
    res.status(500).json({ success: false, message: 'Failed to add photo' });
  }
});

router.delete('/:id/photos/:photoId', async (req, res) => {
  try {
    await ensureTable();
    await execute('DELETE FROM client_photos WHERE id = ? AND customer_id = ? AND tenant_id = ?',
      [req.params.photoId, req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Photo deleted' });
  } catch (error) {
    console.error('Delete photo error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete photo' });
  }
});

export default router;
