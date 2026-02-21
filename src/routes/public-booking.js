import express from 'express';
import QRCode from 'qrcode';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { sendNotificationEmail } from '../lib/email.js';
import crypto from 'crypto';

const router = express.Router();

// ─── Helpers ────────────────────────────────────────────────────────
const toMySQLDateTime = (isoStr) => {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

async function ensureBookingTables() {
  // booking_tokens – let customer cancel/reschedule via unique link
  await execute(`
    CREATE TABLE IF NOT EXISTS booking_tokens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      appointment_id INT NOT NULL,
      token VARCHAR(64) NOT NULL UNIQUE,
      action VARCHAR(20) DEFAULT 'manage',
      expires_at DATETIME,
      used_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_token (token),
      INDEX idx_appointment (appointment_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // online_booking_settings per tenant
  await execute(`
    CREATE TABLE IF NOT EXISTS online_booking_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL UNIQUE,
      is_enabled TINYINT(1) DEFAULT 1,
      allow_cancellation TINYINT(1) DEFAULT 1,
      allow_reschedule TINYINT(1) DEFAULT 1,
      cancellation_hours INT DEFAULT 24,
      require_deposit TINYINT(1) DEFAULT 0,
      deposit_amount DECIMAL(10,2) DEFAULT 0,
      deposit_type VARCHAR(20) DEFAULT 'fixed',
      max_advance_days INT DEFAULT 30,
      min_advance_hours INT DEFAULT 1,
      slot_interval INT DEFAULT 30,
      buffer_minutes INT DEFAULT 0,
      confirmation_message TEXT,
      custom_css TEXT,
      primary_color VARCHAR(20) DEFAULT '#f2421b',
      show_prices TINYINT(1) DEFAULT 1,
      show_duration TINYINT(1) DEFAULT 1,
      allow_staff_selection TINYINT(1) DEFAULT 1,
      auto_confirm TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Ensure store tables
  await execute(`
    CREATE TABLE IF NOT EXISTS store_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      customer_id INT,
      order_number VARCHAR(50) NOT NULL,
      customer_name VARCHAR(255),
      customer_email VARCHAR(255),
      customer_phone VARCHAR(50),
      items JSON,
      subtotal DECIMAL(10,2) DEFAULT 0,
      discount_amount DECIMAL(10,2) DEFAULT 0,
      tax_amount DECIMAL(10,2) DEFAULT 0,
      shipping_amount DECIMAL(10,2) DEFAULT 0,
      total DECIMAL(10,2) DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'AED',
      status VARCHAR(30) DEFAULT 'pending',
      payment_method VARCHAR(50),
      payment_status VARCHAR(30) DEFAULT 'unpaid',
      shipping_address JSON,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_order_number (order_number),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// ─── Resolve tenant from slug ──────────────────────────────────────
async function getTenantBySlug(slug) {
  const [tenant] = await query(
    `SELECT t.*, s.plan, s.features FROM tenants t
     LEFT JOIN subscriptions s ON t.id = s.tenant_id
     WHERE (t.slug = ? OR t.subdomain = ?) AND t.status IN ('active','trial')`,
    [slug, slug]
  );
  return tenant || null;
}

// ═════════════════════════════════════════════════════════════════════
// PUBLIC BOOKING ENDPOINTS  (no auth required)
// ═════════════════════════════════════════════════════════════════════

/**
 * GET /:slug  –  Business profile for booking page
 */
router.get('/:slug', async (req, res) => {
  try {
    await ensureBookingTables();
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ success: false, message: 'Business not found' });

    // Get booking settings
    const [settings] = await query(
      'SELECT * FROM online_booking_settings WHERE tenant_id = ?',
      [tenant.id]
    );

    if (settings && !settings.is_enabled) {
      return res.status(403).json({ success: false, message: 'Online booking is not available for this business' });
    }

    // Get branch count
    const [branchCount] = await query(
      'SELECT COUNT(*) as count FROM branches WHERE tenant_id = ? AND is_active = 1',
      [tenant.id]
    );

    // Get service count
    const [serviceCount] = await query(
      'SELECT COUNT(*) as count FROM products WHERE tenant_id = ? AND is_active = 1',
      [tenant.id]
    );

    // Parse settings
    let tenantSettings = {};
    try {
      tenantSettings = typeof tenant.settings === 'string' ? JSON.parse(tenant.settings) : (tenant.settings || {});
    } catch { tenantSettings = {}; }

    res.json({
      success: true,
      data: {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        logo_url: tenant.logo_url || tenantSettings.logo_url || null,
        email: tenant.email,
        phone: tenant.phone,
        industry: tenant.industry,
        country: tenantSettings.country || null,
        currency: tenantSettings.currency || 'AED',
        timezone: tenantSettings.timezone || 'Asia/Dubai',
        social_links: tenantSettings.social_links || null,
        branches: branchCount?.count || 0,
        services: serviceCount?.count || 0,
        booking_settings: settings ? {
          allow_cancellation: !!settings.allow_cancellation,
          allow_reschedule: !!settings.allow_reschedule,
          cancellation_hours: settings.cancellation_hours,
          max_advance_days: settings.max_advance_days,
          min_advance_hours: settings.min_advance_hours,
          slot_interval: settings.slot_interval || 30,
          buffer_minutes: settings.buffer_minutes || 0,
          show_prices: !!settings.show_prices,
          show_duration: !!settings.show_duration,
          allow_staff_selection: !!settings.allow_staff_selection,
          auto_confirm: !!settings.auto_confirm,
          primary_color: settings.primary_color || '#f2421b',
          confirmation_message: settings.confirmation_message || null,
        } : {
          allow_cancellation: true,
          allow_reschedule: true,
          cancellation_hours: 24,
          max_advance_days: 30,
          min_advance_hours: 1,
          slot_interval: 30,
          buffer_minutes: 0,
          show_prices: true,
          show_duration: true,
          allow_staff_selection: true,
          auto_confirm: false,
          primary_color: '#f2421b',
          confirmation_message: null,
        }
      }
    });
  } catch (error) {
    console.error('Public booking profile error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /:slug/branches  –  List active branches
 */
router.get('/:slug/branches', async (req, res) => {
  try {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ success: false, message: 'Business not found' });

    const branches = await query(
      `SELECT id, name, name_ar, address, city, country, phone, email,
              latitude, longitude, working_hours, cover_image, is_headquarters
       FROM branches WHERE tenant_id = ? AND is_active = 1 ORDER BY is_headquarters DESC, name`,
      [tenant.id]
    );

    // Parse working_hours JSON
    branches.forEach(b => {
      try { b.working_hours = typeof b.working_hours === 'string' ? JSON.parse(b.working_hours) : b.working_hours; }
      catch { b.working_hours = null; }
    });

    res.json({ success: true, data: branches });
  } catch (error) {
    console.error('Public branches error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /:slug/categories  –  Service categories
 */
router.get('/:slug/categories', async (req, res) => {
  try {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ success: false, message: 'Business not found' });

    const { branch_id } = req.query;

    // Simple approach: get categories that have active services
    let sql = `SELECT sc.id, sc.name, sc.name_ar, sc.icon, sc.color, sc.sort_order
               FROM service_categories sc
               WHERE sc.tenant_id = ? AND sc.is_active = 1
               AND EXISTS (
                 SELECT 1 FROM products p
                 WHERE p.category_id = sc.id AND p.is_active = 1 AND p.tenant_id = ?`;
    const params = [tenant.id, tenant.id];

    if (branch_id) {
      sql += ` AND (p.branch_id = ? OR p.branch_id IS NULL)`;
      params.push(branch_id);
    }

    sql += `) ORDER BY sc.sort_order, sc.name`;

    const categories = await query(sql, params);
    res.json({ success: true, data: categories });
  } catch (error) {
    console.error('Public categories error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /:slug/services  –  Available services (optionally by branch/category)
 */
router.get('/:slug/services', async (req, res) => {
  try {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ success: false, message: 'Business not found' });

    const { branch_id, category_id } = req.query;

    let sql = `SELECT p.id, p.name, p.description, p.category_id,
                      sc.name as category_name, sc.color as category_color,
                      p.unit_price as price, p.currency,
                      p.processing_time, p.finishing_time
               FROM products p
               LEFT JOIN service_categories sc ON p.category_id = sc.id
               WHERE p.tenant_id = ? AND p.is_active = 1`;
    const params = [tenant.id];

    if (branch_id) {
      sql += ` AND (p.branch_id = ? OR p.branch_id IS NULL)`;
      params.push(branch_id);
    }
    if (category_id) {
      sql += ` AND p.category_id = ?`;
      params.push(category_id);
    }

    sql += ` ORDER BY p.name`;

    const services = await query(sql, params);
    res.json({ success: true, data: services });
  } catch (error) {
    console.error('Public services error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /:slug/staff  –  Staff who can perform a given service
 */
router.get('/:slug/staff', async (req, res) => {
  try {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ success: false, message: 'Business not found' });

    const { service_id, branch_id } = req.query;
    if (!service_id) return res.status(400).json({ success: false, message: 'service_id required' });

    // Check if staff selection is allowed
    const [settings] = await query('SELECT allow_staff_selection FROM online_booking_settings WHERE tenant_id = ?', [tenant.id]);

    // Get staff with specializations for this service
    let sql = `SELECT DISTINCT s.id, s.full_name, s.avatar_url, s.role,
                      ssp.skill_level
               FROM staff s
               INNER JOIN staff_specializations ssp ON s.id = ssp.staff_id AND ssp.service_id = ?
               WHERE s.tenant_id = ? AND s.is_active = 1`;
    const params = [service_id, tenant.id];

    if (branch_id) {
      sql += ` AND (s.branch_id = ? OR s.branch_id IS NULL)`;
      params.push(branch_id);
    }

    sql += ` ORDER BY ssp.skill_level DESC, s.full_name`;

    const staff = await query(sql, params);

    // If no specialized staff found, return all active staff
    if (staff.length === 0) {
      let fallbackSql = `SELECT s.id, s.full_name, s.avatar_url, s.role, 'general' as skill_level
                         FROM staff s WHERE s.tenant_id = ? AND s.is_active = 1`;
      const fallbackParams = [tenant.id];
      if (branch_id) {
        fallbackSql += ` AND (s.branch_id = ? OR s.branch_id IS NULL)`;
        fallbackParams.push(branch_id);
      }
      fallbackSql += ` AND s.role IN ('staff','manager','admin') ORDER BY s.full_name`;
      const allStaff = await query(fallbackSql, fallbackParams);
      return res.json({ success: true, data: allStaff, allow_selection: settings ? !!settings.allow_staff_selection : true });
    }

    res.json({ success: true, data: staff, allow_selection: settings ? !!settings.allow_staff_selection : true });
  } catch (error) {
    console.error('Public staff error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /:slug/slots  –  Available time slots for a staff member on a date
 */
router.get('/:slug/slots', async (req, res) => {
  try {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ success: false, message: 'Business not found' });

    const { staff_id, date, service_id, branch_id } = req.query;
    if (!staff_id || !date || !service_id) {
      return res.status(400).json({ success: false, message: 'staff_id, date, and service_id are required' });
    }

    // Get booking settings for interval
    const [settings] = await query('SELECT * FROM online_booking_settings WHERE tenant_id = ?', [tenant.id]);
    const slotInterval = settings?.slot_interval || 30;
    const bufferMinutes = settings?.buffer_minutes || 0;
    const minAdvanceHours = settings?.min_advance_hours || 1;
    const maxAdvanceDays = settings?.max_advance_days || 30;

    // Validate date range
    const requestDate = new Date(date);
    const now = new Date();
    const minDate = new Date(now.getTime() + minAdvanceHours * 60 * 60 * 1000);
    const maxDate = new Date(now.getTime() + maxAdvanceDays * 24 * 60 * 60 * 1000);

    if (requestDate > maxDate) {
      return res.json({ success: true, data: [], message: 'Date is too far in the future' });
    }

    // Get day of week (0=Sun, 1=Mon, ... 6=Sat)
    const dayOfWeek = requestDate.getDay();

    // Get staff schedule for this day
    const [schedule] = await query(
      `SELECT * FROM staff_schedule WHERE tenant_id = ? AND staff_id = ? AND day_of_week = ? AND is_working = 1`,
      [tenant.id, staff_id, dayOfWeek]
    );

    if (!schedule) {
      return res.json({ success: true, data: [], message: 'Staff not working on this day' });
    }

    // Check if staff has a day off
    const [dayOff] = await query(
      `SELECT id FROM staff_days_off WHERE tenant_id = ? AND staff_id = ? AND date = ?`,
      [tenant.id, staff_id, date]
    );
    if (dayOff) {
      return res.json({ success: true, data: [], message: 'Staff is on day off' });
    }

    // Get branch working hours as fallback
    if (!schedule.start_time || !schedule.end_time) {
      let branchHours = null;
      if (branch_id) {
        const [branch] = await query('SELECT working_hours FROM branches WHERE id = ? AND tenant_id = ?', [branch_id, tenant.id]);
        try {
          branchHours = typeof branch?.working_hours === 'string' ? JSON.parse(branch.working_hours) : branch?.working_hours;
        } catch { branchHours = null; }
      }
      if (!branchHours) {
        return res.json({ success: true, data: [], message: 'No schedule found' });
      }
    }

    // Get service duration
    const [service] = await query(
      'SELECT processing_time, finishing_time FROM products WHERE id = ? AND tenant_id = ?',
      [service_id, tenant.id]
    );
    const serviceDuration = (parseInt(service?.processing_time) || 30) + (parseInt(service?.finishing_time) || 0);
    const totalSlotDuration = serviceDuration + bufferMinutes;

    // Get existing appointments for this staff on this date
    const existingAppts = await query(
      `SELECT start_time, end_time FROM appointments
       WHERE tenant_id = ? AND staff_id = ? AND DATE(start_time) = ?
       AND status NOT IN ('cancelled', 'no_show')`,
      [tenant.id, staff_id, date]
    );

    // Generate time slots
    const slots = [];
    const startParts = schedule.start_time.split(':');
    const endParts = schedule.end_time.split(':');
    const breakStartParts = schedule.break_start ? schedule.break_start.split(':') : null;
    const breakEndParts = schedule.break_end ? schedule.break_end.split(':') : null;

    let startMinutes = parseInt(startParts[0]) * 60 + parseInt(startParts[1]);
    const endMinutes = parseInt(endParts[0]) * 60 + parseInt(endParts[1]);
    const breakStart = breakStartParts ? parseInt(breakStartParts[0]) * 60 + parseInt(breakStartParts[1]) : null;
    const breakEnd = breakEndParts ? parseInt(breakEndParts[0]) * 60 + parseInt(breakEndParts[1]) : null;

    while (startMinutes + totalSlotDuration <= endMinutes) {
      const slotStart = startMinutes;
      const slotEnd = startMinutes + serviceDuration;

      // Skip if in break time
      if (breakStart !== null && breakEnd !== null) {
        if (slotStart < breakEnd && slotEnd > breakStart) {
          startMinutes += slotInterval;
          continue;
        }
      }

      // Check if slot is in the past
      const slotDateTime = new Date(`${date}T${String(Math.floor(slotStart / 60)).padStart(2, '0')}:${String(slotStart % 60).padStart(2, '0')}:00`);
      if (slotDateTime < minDate) {
        startMinutes += slotInterval;
        continue;
      }

      // Check conflicts with existing appointments
      const slotStartStr = `${date} ${String(Math.floor(slotStart / 60)).padStart(2, '0')}:${String(slotStart % 60).padStart(2, '0')}:00`;
      const slotEndStr = `${date} ${String(Math.floor(slotEnd / 60)).padStart(2, '0')}:${String(slotEnd % 60).padStart(2, '0')}:00`;

      const hasConflict = existingAppts.some(appt => {
        const apptStart = new Date(appt.start_time).getTime();
        const apptEnd = new Date(appt.end_time).getTime();
        const sStart = new Date(slotStartStr).getTime();
        const sEnd = new Date(slotEndStr).getTime();
        return (sStart < apptEnd && sEnd > apptStart);
      });

      if (!hasConflict) {
        slots.push({
          time: `${String(Math.floor(slotStart / 60)).padStart(2, '0')}:${String(slotStart % 60).padStart(2, '0')}`,
          end_time: `${String(Math.floor(slotEnd / 60)).padStart(2, '0')}:${String(slotEnd % 60).padStart(2, '0')}`,
          available: true,
        });
      }

      startMinutes += slotInterval;
    }

    res.json({ success: true, data: slots, duration: serviceDuration });
  } catch (error) {
    console.error('Public slots error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * POST /:slug/book  –  Create a new booking
 */
router.post('/:slug/book', async (req, res) => {
  try {
    await ensureBookingTables();
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ success: false, message: 'Business not found' });

    const { service_id, staff_id, branch_id, start_time, end_time, customer_name, customer_email, customer_phone, notes } = req.body;

    if (!service_id || !staff_id || !start_time || !end_time || !customer_name || (!customer_email && !customer_phone)) {
      return res.status(400).json({ success: false, message: 'service_id, staff_id, start_time, end_time, customer_name, and email or phone are required' });
    }

    const mysqlStart = toMySQLDateTime(start_time);
    const mysqlEnd = toMySQLDateTime(end_time);

    // Check for conflicts
    const conflicts = await query(
      `SELECT id FROM appointments
       WHERE tenant_id = ? AND staff_id = ?
       AND status NOT IN ('cancelled', 'no_show')
       AND ((start_time < ? AND end_time > ?) OR (start_time >= ? AND start_time < ?))`,
      [tenant.id, staff_id, mysqlEnd, mysqlStart, mysqlStart, mysqlEnd]
    );

    if (conflicts.length > 0) {
      return res.status(409).json({ success: false, message: 'This time slot is no longer available. Please select another.' });
    }

    // Find or create customer contact
    let customerId = null;
    if (customer_email) {
      const [existing] = await query(
        'SELECT id FROM contacts WHERE tenant_id = ? AND email = ?',
        [tenant.id, customer_email]
      );
      if (existing) {
        customerId = existing.id;
      }
    }
    if (!customerId && customer_phone) {
      const [existing] = await query(
        'SELECT id FROM contacts WHERE tenant_id = ? AND phone = ?',
        [tenant.id, customer_phone]
      );
      if (existing) {
        customerId = existing.id;
      }
    }
    if (!customerId) {
      // Create new contact
      const nameParts = customer_name.trim().split(' ');
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ') || '';
      const contactResult = await execute(
        `INSERT INTO contacts (tenant_id, first_name, last_name, email, phone)
         VALUES (?, ?, ?, ?, ?)`,
        [tenant.id, firstName, lastName, customer_email || null, customer_phone || null]
      );
      customerId = contactResult.insertId;
    }

    // Get service price
    const [svc] = await query('SELECT unit_price, name FROM products WHERE id = ?', [service_id]);
    const servicePrice = parseFloat(svc?.unit_price || 0);

    // Check booking settings for auto_confirm
    const [settings] = await query('SELECT auto_confirm FROM online_booking_settings WHERE tenant_id = ?', [tenant.id]);
    const status = settings?.auto_confirm ? 'confirmed' : 'scheduled';

    // Ensure source column exists before insert
    try {
      await execute(`ALTER TABLE appointments ADD COLUMN source VARCHAR(50) DEFAULT 'walk_in'`);
    } catch (e) { /* already exists */ }

    // Ensure promo columns exist (they may be referenced by the table)
    const promoColumns = [
      ['promotion_id', 'INT DEFAULT NULL'],
      ['discount_code_id', 'INT DEFAULT NULL'],
      ['promo_code', 'VARCHAR(50) DEFAULT NULL'],
      ['discount_amount', 'DECIMAL(10,2) DEFAULT 0'],
      ['discount_type', "VARCHAR(20) DEFAULT 'fixed'"],
      ['original_price', 'DECIMAL(10,2) DEFAULT 0'],
      ['final_price', 'DECIMAL(10,2) DEFAULT 0']
    ];
    for (const [col, def] of promoColumns) {
      try { await execute(`ALTER TABLE appointments ADD COLUMN ${col} ${def}`); } catch (e) { /* exists */ }
    }

    // Create appointment
    const result = await execute(
      `INSERT INTO appointments (tenant_id, customer_id, service_id, staff_id, start_time, end_time,
        notes, status, original_price, final_price, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online')`,
      [tenant.id, customerId, service_id, staff_id, mysqlStart, mysqlEnd,
       notes || null, status, servicePrice, servicePrice]
    );

    // Generate booking token for management link
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date();
    expires.setDate(expires.getDate() + 30); // 30 days to manage

    await execute(
      `INSERT INTO booking_tokens (appointment_id, token, expires_at) VALUES (?, ?, ?)`,
      [result.insertId, token, toMySQLDateTime(expires.toISOString())]
    );

    // Get full appointment details
    const [appointment] = await query(
      `SELECT a.*, p.name as service_name, s.full_name as staff_name,
              b.name as branch_name, b.address as branch_address, b.phone as branch_phone
       FROM appointments a
       LEFT JOIN products p ON a.service_id = p.id
       LEFT JOIN staff s ON a.staff_id = s.id
       LEFT JOIN branches b ON b.tenant_id = a.tenant_id AND b.is_headquarters = 1
       WHERE a.id = ?`,
      [result.insertId]
    );

    res.status(201).json({
      success: true,
      message: status === 'confirmed' ? 'Booking confirmed!' : 'Booking submitted! Awaiting confirmation.',
      data: {
        id: appointment.id,
        service: appointment.service_name,
        staff: appointment.staff_name,
        date: appointment.start_time,
        end_time: appointment.end_time,
        status: appointment.status,
        branch: appointment.branch_name,
        price: servicePrice,
        manage_token: token,
        manage_url: `/book/${req.params.slug}/manage/${token}`,
      }
    });

    // Send confirmation email with QR code (async — does not block response)
    if (customer_email) {
      const appointmentDate = new Date(appointment.start_time);
      const dateStr = appointmentDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const timeStr = appointmentDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      const manageLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/book/${req.params.slug}/manage/${token}`;

      QRCode.toBuffer(`APPOINTMENT:${appointment.id}`, {
        type: 'png', width: 200, margin: 2,
        color: { dark: '#1a1a2e', light: '#ffffff' },
      }).then(qrBuffer => sendNotificationEmail({
        to: customer_email,
        subject: status === 'confirmed'
          ? `Booking Confirmed — ${appointment.service_name} on ${dateStr}`
          : `Booking Received — ${appointment.service_name} on ${dateStr}`,
        title: status === 'confirmed' ? `Your Booking is Confirmed! ✅` : `Booking Received ⏳`,
        body: `
          <p>Dear ${customer_name},</p>
          ${status === 'confirmed'
            ? `<p>Your appointment has been confirmed! Show the QR code below when you arrive — our staff will scan it to check you in instantly.</p>`
            : `<p>Your booking request has been received and is awaiting confirmation. We'll notify you once it's confirmed.</p>`
          }
          <div style="background:#f8f9fa;padding:24px;border-radius:8px;margin:20px 0;text-align:center;">
            <p style="margin:0 0 4px;font-size:18px;font-weight:600;color:#333;">${appointment.service_name}</p>
            <p style="margin:0 0 16px;font-size:15px;color:#555;">${dateStr} &nbsp;·&nbsp; ${timeStr}</p>
            ${status === 'confirmed' ? `
            <img src="cid:appt_qr" alt="Check-in QR Code"
              style="display:block;margin:0 auto 12px;width:160px;height:160px;border:4px solid #fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.12);" />
            <p style="font-size:12px;color:#aaa;margin:0;">Show this at the counter to check in</p>` : ''}
          </div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
            <tr><td style="padding:6px 0;color:#888;font-size:13px;width:90px;">Service</td><td style="padding:6px 0;font-weight:500;">${appointment.service_name}</td></tr>
            <tr><td style="padding:6px 0;color:#888;font-size:13px;">Date</td><td style="padding:6px 0;font-weight:500;">${dateStr}</td></tr>
            <tr><td style="padding:6px 0;color:#888;font-size:13px;">Time</td><td style="padding:6px 0;font-weight:500;">${timeStr}</td></tr>
            <tr><td style="padding:6px 0;color:#888;font-size:13px;">Staff</td><td style="padding:6px 0;font-weight:500;">${appointment.staff_name || 'Our team'}</td></tr>
            ${appointment.branch_name ? `<tr><td style="padding:6px 0;color:#888;font-size:13px;">Branch</td><td style="padding:6px 0;font-weight:500;">${appointment.branch_name}</td></tr>` : ''}
          </table>
          <p style="color:#555;">Need to reschedule or cancel? <a href="${manageLink}" style="color:#f2421b;">Manage your booking here</a>.</p>
        `,
        tenantId: tenant.id,
        attachments: status === 'confirmed' ? [{
          filename: 'appointment-qr.png',
          content: qrBuffer,
          cid: 'appt_qr',
          contentType: 'image/png',
        }] : undefined,
      })).catch(err => console.error('Public booking email error:', err.message));
    }
  } catch (error) {
    console.error('Public booking error:', error);
    res.status(500).json({ success: false, message: 'Server error', debug: error.message });
  }
});

/**
 * GET /:slug/manage/:token  –  Get booking details via token
 */
router.get('/:slug/manage/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const [bt] = await query(
      `SELECT bt.*, a.*, p.name as service_name, p.unit_price as service_price,
              s.full_name as staff_name, s.avatar_url as staff_avatar,
              c.first_name, c.last_name, c.email, c.phone
       FROM booking_tokens bt
       INNER JOIN appointments a ON bt.appointment_id = a.id
       LEFT JOIN products p ON a.service_id = p.id
       LEFT JOIN staff s ON a.staff_id = s.id
       LEFT JOIN contacts c ON a.customer_id = c.id
       WHERE bt.token = ? AND (bt.expires_at IS NULL OR bt.expires_at > NOW())`,
      [token]
    );

    if (!bt) return res.status(404).json({ success: false, message: 'Booking not found or link expired' });

    // Get tenant info
    const tenant = await getTenantBySlug(req.params.slug);
    const [settings] = await query('SELECT * FROM online_booking_settings WHERE tenant_id = ?', [bt.tenant_id]);

    res.json({
      success: true,
      data: {
        id: bt.appointment_id,
        service: bt.service_name,
        price: bt.service_price,
        staff: bt.staff_name,
        staff_avatar: bt.staff_avatar,
        start_time: bt.start_time,
        end_time: bt.end_time,
        status: bt.status,
        notes: bt.notes,
        customer: {
          name: `${bt.first_name || ''} ${bt.last_name || ''}`.trim(),
          email: bt.email,
          phone: bt.phone,
        },
        can_cancel: settings ? !!settings.allow_cancellation : true,
        can_reschedule: settings ? !!settings.allow_reschedule : true,
        cancellation_hours: settings?.cancellation_hours || 24,
        business: tenant ? { name: tenant.name, logo_url: tenant.logo_url } : null,
      }
    });
  } catch (error) {
    console.error('Manage booking error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * POST /:slug/manage/:token/cancel  –  Cancel a booking via token
 */
router.post('/:slug/manage/:token/cancel', async (req, res) => {
  try {
    const { token } = req.params;
    const { reason } = req.body;

    const [bt] = await query(
      `SELECT bt.*, a.start_time, a.status, a.tenant_id as appt_tenant_id FROM booking_tokens bt
       INNER JOIN appointments a ON bt.appointment_id = a.id
       WHERE bt.token = ? AND (bt.expires_at IS NULL OR bt.expires_at > NOW())`,
      [token]
    );

    if (!bt) return res.status(404).json({ success: false, message: 'Booking not found or link expired' });
    if (bt.status === 'cancelled') return res.status(400).json({ success: false, message: 'Booking is already cancelled' });
    if (bt.status === 'completed') return res.status(400).json({ success: false, message: 'Cannot cancel a completed booking' });

    // Check cancellation policy
    const [settings] = await query('SELECT * FROM online_booking_settings WHERE tenant_id = ?', [bt.appt_tenant_id]);
    if (settings && !settings.allow_cancellation) {
      return res.status(403).json({ success: false, message: 'Cancellation is not allowed. Please contact the business.' });
    }

    const hoursUntilAppt = (new Date(bt.start_time) - new Date()) / (1000 * 60 * 60);
    const minHours = settings?.cancellation_hours || 24;
    if (hoursUntilAppt < minHours) {
      return res.status(400).json({
        success: false,
        message: `Cancellation must be at least ${minHours} hours before the appointment.`
      });
    }

    const cancelNote = `[Online Cancel] ${reason || 'Cancelled by customer'}`;
    await execute(
      `UPDATE appointments SET status = 'cancelled', notes = ? WHERE id = ?`,
      [cancelNote, bt.appointment_id]
    );

    res.json({ success: true, message: 'Booking cancelled successfully' });
  } catch (error) {
    console.error('Cancel booking error:', error);
    res.status(500).json({ success: false, message: 'Server error', debug: error.message });
  }
});

// ═════════════════════════════════════════════════════════════════════
// ONLINE STORE ENDPOINTS
// ═════════════════════════════════════════════════════════════════════

/**
 * GET /:slug/store  –  Store info + featured products
 */
router.get('/:slug/store', async (req, res) => {
  try {
    await ensureBookingTables();
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ success: false, message: 'Store not found' });

    let tenantSettings = {};
    try { tenantSettings = typeof tenant.settings === 'string' ? JSON.parse(tenant.settings) : (tenant.settings || {}); } catch { tenantSettings = {}; }

    // Get products from inventory (retail items)
    const products = await query(
      `SELECT id, name, name_ar, description, category, brand, retail_price as price, currency,
              image_url, stock_quantity
       FROM inventory WHERE tenant_id = ? AND is_active = 1 AND stock_quantity > 0
       ORDER BY name LIMIT 50`,
      [tenant.id]
    );

    // Get categories
    const categories = await query(
      `SELECT DISTINCT category FROM inventory WHERE tenant_id = ? AND is_active = 1 AND category IS NOT NULL ORDER BY category`,
      [tenant.id]
    );

    res.json({
      success: true,
      data: {
        business: {
          name: tenant.name,
          logo_url: tenant.logo_url || tenantSettings.logo_url || null,
          currency: tenantSettings.currency || 'AED',
        },
        products,
        categories: categories.map(c => c.category),
      }
    });
  } catch (error) {
    console.error('Store error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /:slug/store/products  –  List all products with filters
 */
router.get('/:slug/store/products', async (req, res) => {
  try {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ success: false, message: 'Store not found' });

    const { category, brand, search, sort, page = 1, limit = 20 } = req.query;

    let sql = `SELECT id, name, name_ar, description, category, brand, retail_price as price, currency,
                      image_url, stock_quantity
               FROM inventory WHERE tenant_id = ? AND is_active = 1 AND stock_quantity > 0`;
    const params = [tenant.id];

    if (category) { sql += ` AND category = ?`; params.push(category); }
    if (brand) { sql += ` AND brand = ?`; params.push(brand); }
    if (search) { sql += ` AND (name LIKE ? OR description LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }

    // Count
    const countSql = sql.replace(/SELECT .* FROM/, 'SELECT COUNT(*) as total FROM');
    const [countResult] = await query(countSql, params);

    // Sort
    if (sort === 'price_asc') sql += ` ORDER BY retail_price ASC`;
    else if (sort === 'price_desc') sql += ` ORDER BY retail_price DESC`;
    else if (sort === 'name') sql += ` ORDER BY name ASC`;
    else sql += ` ORDER BY name ASC`;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;
    sql += ` LIMIT ${limitNum} OFFSET ${offset}`;

    const products = await query(sql, params);

    res.json({
      success: true,
      data: products,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: countResult?.total || 0,
        totalPages: Math.ceil((countResult?.total || 0) / limitNum),
      }
    });
  } catch (error) {
    console.error('Store products error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * POST /:slug/store/checkout  –  Place an order
 */
router.post('/:slug/store/checkout', async (req, res) => {
  try {
    await ensureBookingTables();
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ success: false, message: 'Store not found' });

    const { items, customer_name, customer_email, customer_phone, shipping_address, notes } = req.body;

    if (!items || !items.length || !customer_name || (!customer_email && !customer_phone)) {
      return res.status(400).json({ success: false, message: 'Items, customer name, and email/phone are required' });
    }

    let tenantSettings = {};
    try { tenantSettings = typeof tenant.settings === 'string' ? JSON.parse(tenant.settings) : (tenant.settings || {}); } catch { tenantSettings = {}; }

    // Validate items and calculate totals
    let subtotal = 0;
    const validatedItems = [];
    for (const item of items) {
      const [product] = await query(
        'SELECT id, name, retail_price, stock_quantity FROM inventory WHERE id = ? AND tenant_id = ? AND is_active = 1',
        [item.product_id, tenant.id]
      );
      if (!product) return res.status(400).json({ success: false, message: `Product ${item.product_id} not found` });
      if (product.stock_quantity < item.quantity) {
        return res.status(400).json({ success: false, message: `Not enough stock for ${product.name}` });
      }
      const lineTotal = parseFloat(product.retail_price) * item.quantity;
      subtotal += lineTotal;
      validatedItems.push({
        product_id: product.id,
        name: product.name,
        price: parseFloat(product.retail_price),
        quantity: item.quantity,
        total: lineTotal,
      });
    }

    // Generate order number
    const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

    // Find or create customer
    let customerId = null;
    if (customer_email) {
      const [existing] = await query('SELECT id FROM contacts WHERE tenant_id = ? AND email = ?', [tenant.id, customer_email]);
      if (existing) customerId = existing.id;
    }
    if (!customerId && customer_phone) {
      const [existing] = await query('SELECT id FROM contacts WHERE tenant_id = ? AND phone = ?', [tenant.id, customer_phone]);
      if (existing) customerId = existing.id;
    }
    if (!customerId) {
      const nameParts = customer_name.trim().split(' ');
      const cr = await execute(
        `INSERT INTO contacts (tenant_id, first_name, last_name, email, phone) VALUES (?, ?, ?, ?, ?)`,
        [tenant.id, nameParts[0], nameParts.slice(1).join(' ') || '', customer_email || null, customer_phone || null]
      );
      customerId = cr.insertId;
    }

    const total = subtotal; // Can add tax/shipping later

    const orderResult = await execute(
      `INSERT INTO store_orders (tenant_id, customer_id, order_number, customer_name, customer_email, customer_phone,
        items, subtotal, total, currency, status, shipping_address, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [tenant.id, customerId, orderNumber, customer_name, customer_email || null, customer_phone || null,
       JSON.stringify(validatedItems), subtotal, total, tenantSettings.currency || 'AED',
       shipping_address ? JSON.stringify(shipping_address) : null, notes || null]
    );

    // Reduce stock
    for (const item of validatedItems) {
      await execute(
        `UPDATE inventory SET stock_quantity = stock_quantity - ? WHERE id = ? AND tenant_id = ?`,
        [item.quantity, item.product_id, tenant.id]
      );
    }

    res.status(201).json({
      success: true,
      message: 'Order placed successfully!',
      data: {
        order_id: orderResult.insertId,
        order_number: orderNumber,
        total,
        currency: tenantSettings.currency || 'AED',
        items: validatedItems,
        status: 'pending',
      }
    });
  } catch (error) {
    console.error('Store checkout error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /:slug/store/order/:orderNumber  –  Track order
 */
router.get('/:slug/store/order/:orderNumber', async (req, res) => {
  try {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ success: false, message: 'Store not found' });

    const [order] = await query(
      `SELECT * FROM store_orders WHERE tenant_id = ? AND order_number = ?`,
      [tenant.id, req.params.orderNumber]
    );

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Parse JSON fields
    try { order.items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items; } catch { order.items = []; }
    try { order.shipping_address = typeof order.shipping_address === 'string' ? JSON.parse(order.shipping_address) : order.shipping_address; } catch { order.shipping_address = null; }

    res.json({ success: true, data: order });
  } catch (error) {
    console.error('Track order error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═════════════════════════════════════════════════════════════════════
// BOOKING SETTINGS (authenticated, for admin)
// ═════════════════════════════════════════════════════════════════════

/**
 * GET /settings  –  Get booking settings (requires auth)
 */
router.get('/settings/current', authMiddleware, async (req, res) => {
  try {
    if (!req.tenantId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    await ensureBookingTables();
    const [settings] = await query('SELECT * FROM online_booking_settings WHERE tenant_id = ?', [req.tenantId]);

    if (!settings) {
      // Create default settings
      await execute('INSERT INTO online_booking_settings (tenant_id) VALUES (?)', [req.tenantId]);
      const [newSettings] = await query('SELECT * FROM online_booking_settings WHERE tenant_id = ?', [req.tenantId]);
      return res.json({ success: true, data: newSettings });
    }

    res.json({ success: true, data: settings });
  } catch (error) {
    console.error('Get booking settings error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * PATCH /settings/current  –  Update booking settings (requires auth)
 */
router.patch('/settings/current', authMiddleware, async (req, res) => {
  try {
    if (!req.tenantId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    await ensureBookingTables();
    const fields = ['is_enabled', 'allow_cancellation', 'allow_reschedule', 'cancellation_hours',
      'require_deposit', 'deposit_amount', 'deposit_type', 'max_advance_days', 'min_advance_hours',
      'slot_interval', 'buffer_minutes', 'confirmation_message', 'custom_css', 'primary_color',
      'show_prices', 'show_duration', 'allow_staff_selection', 'auto_confirm'];

    const updates = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(req.body[f]);
      }
    }

    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No fields to update' });

    // Upsert
    const [existing] = await query('SELECT id FROM online_booking_settings WHERE tenant_id = ?', [req.tenantId]);
    if (existing) {
      params.push(req.tenantId);
      await execute(`UPDATE online_booking_settings SET ${updates.join(', ')} WHERE tenant_id = ?`, params);
    } else {
      await execute('INSERT INTO online_booking_settings (tenant_id) VALUES (?)', [req.tenantId]);
      params.push(req.tenantId);
      await execute(`UPDATE online_booking_settings SET ${updates.join(', ')} WHERE tenant_id = ?`, params);
    }

    const [settings] = await query('SELECT * FROM online_booking_settings WHERE tenant_id = ?', [req.tenantId]);
    res.json({ success: true, data: settings, message: 'Settings updated' });
  } catch (error) {
    console.error('Update booking settings error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═════════════════════════════════════════════════════════════════════
// STORE ORDERS MANAGEMENT (authenticated, for admin)
// ═════════════════════════════════════════════════════════════════════

/**
 * GET /store-orders  –  List orders for admin
 */
router.get('/store-orders/list', authMiddleware, async (req, res) => {
  try {
    if (!req.tenantId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { status, page = 1, limit = 20 } = req.query;

    let sql = 'SELECT * FROM store_orders WHERE tenant_id = ?';
    const params = [req.tenantId];

    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const offset = (pageNum - 1) * limitNum;
    sql += ` LIMIT ${limitNum} OFFSET ${offset}`;

    const orders = await query(sql, params);

    // Parse JSON
    orders.forEach(o => {
      try { o.items = typeof o.items === 'string' ? JSON.parse(o.items) : o.items; } catch { o.items = []; }
    });

    res.json({ success: true, data: orders });
  } catch (error) {
    console.error('List orders error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * PATCH /store-orders/:id  –  Update order status
 */
router.patch('/store-orders/:id', authMiddleware, async (req, res) => {
  try {
    if (!req.tenantId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    const { status, payment_status, notes } = req.body;
    const fields = [];
    const params = [];

    if (status) { fields.push('status = ?'); params.push(status); }
    if (payment_status) { fields.push('payment_status = ?'); params.push(payment_status); }
    if (notes !== undefined) { fields.push('notes = ?'); params.push(notes); }

    if (fields.length === 0) return res.status(400).json({ success: false, message: 'No fields' });

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE store_orders SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`, params);

    res.json({ success: true, message: 'Order updated' });
  } catch (error) {
    console.error('Update order error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * GET /store-orders/stats  –  Store order stats
 */
router.get('/store-orders/stats', authMiddleware, async (req, res) => {
  try {
    if (!req.tenantId) return res.status(401).json({ success: false, message: 'Unauthorized' });

    await ensureBookingTables();
    const [total] = await query('SELECT COUNT(*) as c FROM store_orders WHERE tenant_id = ?', [req.tenantId]);
    const [pending] = await query("SELECT COUNT(*) as c FROM store_orders WHERE tenant_id = ? AND status = 'pending'", [req.tenantId]);
    const [completed] = await query("SELECT COUNT(*) as c FROM store_orders WHERE tenant_id = ? AND status = 'delivered'", [req.tenantId]);
    const [revenue] = await query("SELECT COALESCE(SUM(total),0) as r FROM store_orders WHERE tenant_id = ? AND payment_status = 'paid'", [req.tenantId]);

    res.json({
      success: true,
      data: {
        total_orders: total?.c || 0,
        pending_orders: pending?.c || 0,
        completed_orders: completed?.c || 0,
        total_revenue: parseFloat(revenue?.r || 0),
      }
    });
  } catch (error) {
    console.error('Store stats error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
