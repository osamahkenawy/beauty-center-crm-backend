import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { redeemGiftCard } from './gift-cards.js';
import { notifyAppointment, notifyAppointmentCancelled } from '../lib/notify.js';
import { sendNotificationEmail } from '../lib/email.js';

const router = express.Router();

router.use(authMiddleware);

/**
 * Helper to convert ISO datetime to MySQL format
 */
const toMySQLDateTime = (isoString) => {
  const date = new Date(isoString);
  return date.toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * Ensure promo columns exist on appointments table
 */
async function ensurePromoColumns() {
  const columns = [
    ['promotion_id', 'INT DEFAULT NULL'],
    ['discount_code_id', 'INT DEFAULT NULL'],
    ['promo_code', 'VARCHAR(50) DEFAULT NULL'],
    ['discount_amount', 'DECIMAL(10,2) DEFAULT 0'],
    ['discount_type', "VARCHAR(20) DEFAULT 'fixed'"],
    ['original_price', 'DECIMAL(10,2) DEFAULT 0'],
    ['final_price', 'DECIMAL(10,2) DEFAULT 0']
  ];
  for (const [col, def] of columns) {
    try {
      await execute(`ALTER TABLE appointments ADD COLUMN ${col} ${def}`);
    } catch (e) {
      // Column already exists – that's fine
    }
  }
}

/**
 * Create appointment (with optional promo code)
 */
router.post('/', async (req, res) => {
  try {
    await ensurePromoColumns();
    const {
      customer_id, service_id, staff_id, start_time, end_time, notes,
      promo_code, promotion_id, discount_code_id, discount_amount = 0, discount_type = 'fixed'
    } = req.body;
    const tenantId = req.tenantId;

    if (!customer_id || !service_id || !staff_id || !start_time || !end_time) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields' 
      });
    }

    // Convert to MySQL datetime format
    const mysqlStartTime = toMySQLDateTime(start_time);
    const mysqlEndTime = toMySQLDateTime(end_time);

    // Check for conflicts (exclude cancelled, no_show, and completed appointments)
    // Completed appointments have their end_time updated to actual completion time, so they won't block future bookings
    const conflicts = await query(
      `SELECT id FROM appointments 
       WHERE tenant_id = ? AND staff_id = ? 
       AND status NOT IN ('cancelled', 'no_show', 'completed')
       AND (
         (start_time < ? AND end_time > ?) OR
         (start_time >= ? AND start_time < ?)
       )`,
      [tenantId, staff_id, mysqlEndTime, mysqlStartTime, mysqlStartTime, mysqlEndTime]
    );

    if (conflicts.length > 0) {
      return res.status(409).json({ 
        success: false, 
        message: 'Staff member has conflicting appointment at this time' 
      });
    }

    // Get service price for promo calculations
    const [svc] = await query('SELECT unit_price FROM products WHERE id = ?', [service_id]);
    const originalPrice = parseFloat(svc?.unit_price || 0);

    // Validate & calculate promo discount if promo_code provided
    let validatedPromoId = promotion_id || null;
    let validatedCodeId = discount_code_id || null;
    let appliedDiscount = parseFloat(discount_amount) || 0;
    let appliedType = discount_type;

    if (promo_code && !validatedPromoId) {
      // Server-side validation of the promo code
      const [dc] = await query(`
        SELECT dc.id as code_id, dc.promotion_id, p.type, p.discount_value, p.is_active,
               p.start_date, p.end_date, p.min_spend, p.applies_to, p.service_ids, p.category_ids,
               dc.max_uses, dc.used_count
        FROM discount_codes dc
        LEFT JOIN promotions p ON dc.promotion_id = p.id
        WHERE dc.code = ? AND dc.tenant_id = ? AND dc.is_active = 1
      `, [promo_code, tenantId]);

      if (dc && dc.is_active) {
        const now = new Date();
        const startOk = !dc.start_date || new Date(dc.start_date) <= now;
        const endOk = !dc.end_date || new Date(dc.end_date) >= now;
        const usageOk = !dc.max_uses || dc.used_count < dc.max_uses;

        if (startOk && endOk && usageOk) {
          validatedPromoId = dc.promotion_id;
          validatedCodeId = dc.code_id;
          appliedType = dc.type === 'percentage' ? 'percentage' : 'fixed';
          appliedDiscount = dc.type === 'percentage'
            ? originalPrice * (dc.discount_value / 100)
            : parseFloat(dc.discount_value || 0);
        }
      }
    }

    const finalPrice = Math.max(0, originalPrice - appliedDiscount);

    // Create appointment
    const result = await execute(
      `INSERT INTO appointments (tenant_id, customer_id, service_id, staff_id, start_time, end_time, notes,
        promotion_id, discount_code_id, promo_code, discount_amount, discount_type, original_price, final_price, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, customer_id, service_id, staff_id, mysqlStartTime, mysqlEndTime, notes || null,
        validatedPromoId, validatedCodeId, promo_code || null, appliedDiscount, appliedType, originalPrice, finalPrice, req.user.id]
    );

    // Record promo usage
    if (validatedCodeId || validatedPromoId) {
      try {
        await execute(`
          INSERT INTO discount_usage (discount_code_id, promotion_id, customer_id, appointment_id, discount_amount)
          VALUES (?, ?, ?, ?, ?)
        `, [validatedCodeId, validatedPromoId, customer_id, result.insertId, appliedDiscount]);

        if (validatedCodeId) {
          await execute('UPDATE discount_codes SET used_count = used_count + 1 WHERE id = ?', [validatedCodeId]);
        }
        if (validatedPromoId) {
          await execute('UPDATE promotions SET used_count = used_count + 1 WHERE id = ?', [validatedPromoId]);
        }
      } catch (promoErr) {
        console.warn('Could not record promo usage:', promoErr.message);
      }
    }

    // Schedule reminders using the reminder service
    try {
      const { scheduleAppointmentReminders } = await import('../lib/reminders.js');
      await scheduleAppointmentReminders(tenantId, result.insertId, start_time, customer_id);
    } catch (reminderError) {
      console.warn('Could not schedule appointment reminders:', reminderError.message);
    }

    // Get created appointment with details
    const [appointment] = await query(
      `SELECT a.*, 
              c.first_name as customer_first_name, c.last_name as customer_last_name,
              s.full_name as staff_name,
              p.name as service_name, p.unit_price as service_price
       FROM appointments a
       LEFT JOIN contacts c ON a.customer_id = c.id
       LEFT JOIN staff s ON a.staff_id = s.id
       LEFT JOIN products p ON a.service_id = p.id
       WHERE a.id = ?`,
      [result.insertId]
    );

    // Push notification
    notifyAppointment(
      tenantId,
      `New Booking — ${appointment?.customer_first_name || 'Client'} ${appointment?.customer_last_name || ''}`.trim(),
      `${appointment?.service_name || 'Service'} with ${appointment?.staff_name || 'Staff'} on ${new Date(start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      { appointment_id: result.insertId, customer_id, service_id, staff_id }
    ).catch(() => {});

    // Send confirmation email to customer
    if (customer_id) {
      try {
        const [customer] = await query('SELECT email, first_name, last_name FROM contacts WHERE id = ?', [customer_id]);
        if (customer && customer.email) {
          const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Valued Client';
          const appointmentDate = new Date(start_time);
          const dateStr = appointmentDate.toLocaleDateString('en-US', { 
            weekday: 'long', 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
          });
          const timeStr = appointmentDate.toLocaleTimeString('en-US', { 
            hour: 'numeric', 
            minute: '2-digit',
            hour12: true 
          });
          
          const emailResult = await sendNotificationEmail({
            to: customer.email,
            subject: `Appointment Confirmed — ${appointment?.service_name || 'Service'} on ${dateStr}`,
            title: `Appointment Confirmed ✅`,
            body: `
              <p>Dear ${customerName},</p>
              <p>Your appointment has been confirmed!</p>
              <ul>
                <li><strong>Service:</strong> ${appointment?.service_name || 'Service'}</li>
                <li><strong>Date:</strong> ${dateStr}</li>
                <li><strong>Time:</strong> ${timeStr}</li>
                <li><strong>Staff:</strong> ${appointment?.staff_name || 'Our team'}</li>
              </ul>
              <p>We look forward to seeing you!</p>
              <p>If you need to reschedule or cancel, please contact us as soon as possible.</p>
            `,
            tenantId,
          });
          
          if (emailResult.success) {
            console.log(`✅ Appointment confirmation email sent to ${customer.email}`);
          } else {
            console.error(`❌ Failed to send appointment confirmation email to ${customer.email}:`, emailResult.error);
          }
        } else {
          console.log(`⚠️  Appointment created but customer ${customer_id} has no email address`);
        }
      } catch (emailErr) {
        console.error('Error sending appointment confirmation email:', emailErr);
      }
    } else {
      console.log('⚠️  Appointment created but no customer_id provided');
    }

    res.status(201).json({
      success: true,
      data: appointment,
      message: appliedDiscount > 0
        ? `Appointment booked! Promo applied — saved ${appliedDiscount.toFixed(2)}`
        : 'Appointment created successfully'
    });
  } catch (error) {
    console.error('Error creating appointment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * Get appointments with filters and pagination
 */
router.get('/', async (req, res) => {
  try {
    const { staff_id, customer_id, status, from_date, to_date, date, page = 1, limit = 10, all } = req.query;
    const tenantId = req.tenantId;

    // Check role-based access: can user view all appointments or only their own?
    const user = req.user;
    const rolePerms = user?.rolePermissions || {};
    const apptPerms = rolePerms.appointments || {};
    
    // Check if user has view permission at all
    if (!apptPerms.view && user?.role !== 'admin' && user?.is_owner !== 1 && user?.role !== 'manager') {
      return res.status(403).json({ success: false, message: 'You do not have permission to view appointments' });
    }
    
    // Check if user can view all appointments
    // If view_scope is 'all' or view_all is true, they can see all
    // If view_scope is 'own' or not set, they can only see their own
    const viewScope = apptPerms.view_scope || 'own'; // Default to 'own' if not set
    const canViewAll = viewScope === 'all' || apptPerms.view_all === true;
    
    // If user is admin/owner/manager, they can always view all
    const isAdmin = user?.role === 'admin' || user?.is_owner === 1 || user?.role === 'manager';
    
    // Debug logging (remove in production)
    if (process.env.NODE_ENV === 'development') {
      console.log('[Appointments Filter]', {
        userId: user.id,
        role: user.role,
        isAdmin,
        viewScope,
        canViewAll,
        apptPerms,
        hasView: apptPerms.view
      });
    }
    
    // Base WHERE clause
    let whereClause = `WHERE a.tenant_id = ?`;
    const params = [tenantId];

    // Apply role-based filtering: if user can only view own, filter by their staff_id
    // Unless they explicitly requested a specific staff_id filter
    if (!isAdmin && !canViewAll && !staff_id) {
      // User can only view their own appointments (where they are the assigned staff)
      whereClause += ` AND a.staff_id = ?`;
      params.push(user.id);
      if (process.env.NODE_ENV === 'development') {
        console.log('[Appointments Filter] Filtering by staff_id:', user.id);
      }
    } else if (staff_id) {
      // Explicit staff_id filter from query params (admin/manager can filter by any staff)
      whereClause += ` AND a.staff_id = ?`;
      params.push(staff_id);
    }

    if (customer_id) {
      whereClause += ` AND a.customer_id = ?`;
      params.push(customer_id);
    }

    if (status) {
      whereClause += ` AND a.status = ?`;
      params.push(status);
    }

    if (date) {
      whereClause += ` AND DATE(a.start_time) = ?`;
      params.push(date);
    } else {
      // If only from_date is provided (without to_date), match exact date
      // If both from_date and to_date are provided, use date range
      if (from_date && !to_date) {
        // Only from_date: match exact date
        const fromDateStr = from_date.split('T')[0]; // Remove time if present
        whereClause += ` AND DATE(a.start_time) = ?`;
        params.push(fromDateStr);
      } else if (from_date && to_date) {
        // Both dates: use date range
        const fromDateStr = from_date.split('T')[0]; // Remove time if present
        const toDateStr = to_date.split('T')[0]; // Remove time if present
        whereClause += ` AND DATE(a.start_time) >= ? AND DATE(a.start_time) <= ?`;
        params.push(fromDateStr, toDateStr);
      } else if (to_date && !from_date) {
        // Only to_date: from beginning until to_date
        const toDateStr = to_date.split('T')[0]; // Remove time if present
        whereClause += ` AND DATE(a.start_time) <= ?`;
        params.push(toDateStr);
      }
    }

    // Get total count first (use a copy of params for count query)
    const countSql = `SELECT COUNT(*) as total FROM appointments a ${whereClause}`;
    const [countResult] = await query(countSql, [...params]);
    const total = countResult?.total || 0;

    // Apply pagination unless 'all' is requested
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 10;

    // Build main query
    let sql = `
      SELECT a.*, 
             c.first_name as customer_first_name, c.last_name as customer_last_name,
             c.phone as customer_phone, c.email as customer_email,
             s.full_name as staff_name,
             p.name as service_name, p.unit_price as service_price
      FROM appointments a
      LEFT JOIN contacts c ON a.customer_id = c.id
      LEFT JOIN staff s ON a.staff_id = s.id
      LEFT JOIN products p ON a.service_id = p.id
      ${whereClause}
      ORDER BY a.start_time DESC
    `;
    
    // Apply pagination - embed values directly since they're sanitized integers
    if (!all || all === 'false') {
      const offset = (pageNum - 1) * limitNum;
      sql += ` LIMIT ${limitNum} OFFSET ${offset}`;
    }

    const appointments = await query(sql, [...params]);
    
    const totalPages = Math.ceil(total / limitNum);
    
    res.json({ 
      success: true, 
      data: appointments,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages,
        hasNext: pageNum < totalPages,
        hasPrev: pageNum > 1
      }
    });
  } catch (error) {
    console.error('Error fetching appointments:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * Get appointment by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;

    const [appointment] = await query(
      `SELECT a.*, 
              c.first_name as customer_first_name, c.last_name as customer_last_name,
              c.phone as customer_phone, c.email as customer_email,
              s.full_name as staff_name, s.phone as staff_phone,
              p.name as service_name, p.unit_price as service_price, p.description as service_description
       FROM appointments a
       LEFT JOIN contacts c ON a.customer_id = c.id
       LEFT JOIN staff s ON a.staff_id = s.id
       LEFT JOIN products p ON a.service_id = p.id
       WHERE a.id = ? AND a.tenant_id = ?`,
      [id, tenantId]
    );

    if (!appointment) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }

    res.json({ success: true, data: appointment });
  } catch (error) {
    console.error('Error fetching appointment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * Update appointment
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;
    const { start_time, end_time, status, notes, staff_id, payment_status, customer_showed } = req.body;

    // Check if appointment exists
    const [existing] = await query(
      'SELECT * FROM appointments WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }

    // Build update query dynamically
    const updates = [];
    const params = [];

    if (start_time !== undefined) {
      updates.push('start_time = ?');
      params.push(toMySQLDateTime(start_time));
    }
    if (end_time !== undefined) {
      updates.push('end_time = ?');
      params.push(toMySQLDateTime(end_time));
    }
    if (status !== undefined) {
      updates.push('status = ?');
      params.push(status);
    }
    if (notes !== undefined) {
      updates.push('notes = ?');
      params.push(notes);
    }
    if (staff_id !== undefined) {
      updates.push('staff_id = ?');
      params.push(staff_id);
    }
    if (payment_status !== undefined) {
      updates.push('payment_status = ?');
      params.push(payment_status);
    }
    if (customer_showed !== undefined) {
      updates.push('customer_showed = ?');
      params.push(customer_showed);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    // If status is being changed to 'completed', update end_time to current time if completed early
    if (status === 'completed' && existing.status !== 'completed') {
      const now = new Date();
      const scheduledEndTime = new Date(existing.end_time);
      if (now < scheduledEndTime) {
        // Completed early - update end_time to current time to free up the slot
        // Only add if end_time is not already being updated
        if (end_time === undefined) {
          updates.push('end_time = ?');
          params.push(toMySQLDateTime(now.toISOString()));
        }
      }
    }

    params.push(id, tenantId);

    await execute(
      `UPDATE appointments SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`,
      params
    );

    // Handle reminders based on changes
    try {
      const { cancelAppointmentReminders, rescheduleAppointmentReminders } = await import('../lib/reminders.js');
      
      // If status changed to cancelled, cancel reminders
      if (status === 'cancelled') {
        await cancelAppointmentReminders(id);
      }
      
      // If start_time changed, reschedule reminders
      if (start_time !== undefined && start_time !== existing.start_time) {
        await rescheduleAppointmentReminders(tenantId, id, start_time);
      }
    } catch (reminderError) {
      console.warn('Could not update reminders:', reminderError.message);
    }

    // Get updated appointment
    const [appointment] = await query(
      `SELECT a.*, 
              c.first_name as customer_first_name, c.last_name as customer_last_name,
              s.full_name as staff_name,
              p.name as service_name
       FROM appointments a
       LEFT JOIN contacts c ON a.customer_id = c.id
       LEFT JOIN staff s ON a.staff_id = s.id
       LEFT JOIN products p ON a.service_id = p.id
       WHERE a.id = ?`,
      [id]
    );

    res.json({ success: true, data: appointment, message: 'Appointment updated successfully' });
  } catch (error) {
    console.error('Error updating appointment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * Checkout appointment — Complete + Auto-create invoice + optional payment
 * This is the main "done" flow: one click to finish the appointment.
 * 
 * Body (all optional):
 *   payment_method: 'cash' | 'card' | 'bank_transfer' | 'gift_card' | 'other'
 *   discount_amount: number
 *   discount_type: 'fixed' | 'percentage'
 *   tax_rate: number (default 5)
 *   tip: number
 *   notes: string
 *   pay_now: boolean (if true, marks invoice as paid immediately)
 */
router.post('/:id/checkout', async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;
    const {
      payment_method = 'cash',
      gift_card_code,
      discount_amount = 0,
      discount_type = 'fixed',
      tax_rate = 5,
      tip = 0,
      notes,
      pay_now = true
    } = req.body;

    // Require gift card code when paying by gift card
    if (payment_method === 'gift_card' && !gift_card_code) {
      return res.status(400).json({ success: false, message: 'Gift card code is required for gift card payments' });
    }

    // 1. Get the appointment with full details
    const [apt] = await query(
      `SELECT a.*, 
              p.name as service_name, p.unit_price, p.currency,
              c.first_name as customer_first_name, c.last_name as customer_last_name,
              s.full_name as staff_name
       FROM appointments a
       LEFT JOIN products p ON a.service_id = p.id
       LEFT JOIN contacts c ON a.customer_id = c.id
       LEFT JOIN staff s ON a.staff_id = s.id
       WHERE a.id = ? AND a.tenant_id = ?`,
      [id, tenantId]
    );

    if (!apt) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }

    if (apt.status === 'completed') {
      // Already completed — check if invoice exists
      const [existingInv] = await query(
        'SELECT id, invoice_number, status, total FROM invoices WHERE appointment_id = ? AND tenant_id = ?',
        [id, tenantId]
      );
      if (existingInv) {
        return res.json({
          success: true,
          message: 'Appointment already checked out',
          data: { appointment_id: parseInt(id), invoice_id: existingInv.id, invoice_number: existingInv.invoice_number, total: existingInv.total }
        });
      }
    }

    if (apt.status === 'cancelled' || apt.status === 'no_show') {
      return res.status(400).json({ success: false, message: `Cannot checkout a ${apt.status} appointment` });
    }

    // 2. Mark appointment as completed and update end_time if completed early
    const now = new Date();
    const scheduledEndTime = new Date(apt.end_time);
    const actualEndTime = now < scheduledEndTime ? now : scheduledEndTime; // Use current time if earlier than scheduled
    
    await execute(
      `UPDATE appointments 
       SET status = 'completed', 
           customer_showed = 1, 
           payment_status = ?,
           end_time = ?
       WHERE id = ? AND tenant_id = ?`,
      [pay_now ? 'paid' : 'pending', toMySQLDateTime(actualEndTime.toISOString()), id, tenantId]
    );

    // 3. Check if invoice already exists
    const [existingInvoice] = await query(
      'SELECT id, invoice_number FROM invoices WHERE appointment_id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    let invoiceId, invoiceNumber;

    if (existingInvoice) {
      invoiceId = existingInvoice.id;
      invoiceNumber = existingInvoice.invoice_number;
    } else {
      // 4. Generate invoice number
      const [lastInv] = await query(
        "SELECT invoice_number FROM invoices WHERE tenant_id = ? ORDER BY id DESC LIMIT 1",
        [tenantId]
      );
      const lastNum = lastInv?.invoice_number ? parseInt(lastInv.invoice_number.replace('INV-', '')) || 0 : 0;
      invoiceNumber = `INV-${String(lastNum + 1).padStart(4, '0')}`;

      // 5. Calculate totals (include promo discount from booking if any)
      const basePrice = parseFloat(apt.unit_price || 0);
      const promoDiscount = parseFloat(apt.discount_amount || 0); // Already saved at booking time
      const subtotal = basePrice + parseFloat(tip || 0);
      const checkoutDisc = discount_type === 'percentage' 
        ? subtotal * (parseFloat(discount_amount) / 100) 
        : parseFloat(discount_amount || 0);
      const disc = promoDiscount + checkoutDisc; // Total discount = promo + checkout manual
      const afterDiscount = subtotal - disc;
      const taxAmount = afterDiscount * (parseFloat(tax_rate) / 100);
      const total = afterDiscount + taxAmount;
      const amountPaid = pay_now ? total : 0;

      // 6. Create invoice
      const invResult = await execute(`
        INSERT INTO invoices (tenant_id, appointment_id, customer_id, staff_id,
          invoice_number, subtotal, discount_amount, discount_type, tax_rate, tax_amount,
          total, amount_paid, currency, status, payment_method, paid_at, notes, created_by)
        VALUES (?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?,?,?)
      `, [
        tenantId, id, apt.customer_id, apt.staff_id,
        invoiceNumber, subtotal, disc, discount_type, tax_rate, taxAmount,
        total, amountPaid, apt.currency || 'AED',
        pay_now ? 'paid' : 'sent',
        payment_method,
        pay_now ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
        notes || null,
        req.user?.id || null
      ]);

      invoiceId = invResult.insertId;

      // 7. Add line items
      await execute(`
        INSERT INTO invoice_items (invoice_id, item_type, item_id, name, quantity, unit_price, total)
        VALUES (?, 'service', ?, ?, 1, ?, ?)
      `, [invoiceId, apt.service_id, apt.service_name || 'Service', parseFloat(apt.unit_price || 0), parseFloat(apt.unit_price || 0)]);

      // Add tip as a separate line item if present
      if (parseFloat(tip) > 0) {
        await execute(`
          INSERT INTO invoice_items (invoice_id, item_type, name, quantity, unit_price, total)
          VALUES (?, 'custom', 'Tip', 1, ?, ?)
        `, [invoiceId, parseFloat(tip), parseFloat(tip)]);
      }
    }

    // 8. If paying with gift card, redeem now
    let giftCardResult = null;
    if (payment_method === 'gift_card' && pay_now && gift_card_code) {
      const [inv] = await query('SELECT total FROM invoices WHERE id = ?', [invoiceId]);
      const redeemAmount = parseFloat(inv?.total || 0);
      if (redeemAmount > 0) {
        giftCardResult = await redeemGiftCard(tenantId, gift_card_code, redeemAmount, {
          invoice_id: invoiceId,
          created_by: req.user?.id
        });
        if (!giftCardResult.success) {
          // Rollback: revert appointment & invoice to unpaid state
          await execute("UPDATE appointments SET payment_status = 'pending' WHERE id = ? AND tenant_id = ?", [id, tenantId]);
          await execute("UPDATE invoices SET status = 'sent', amount_paid = 0, paid_at = NULL WHERE id = ?", [invoiceId]);
          return res.status(400).json({ success: false, message: giftCardResult.message });
        }
      }
    }

    // 9. Return result
    const [invoice] = await query('SELECT * FROM invoices WHERE id = ?', [invoiceId]);

    // Push notification
    notifyAppointment(
      tenantId,
      pay_now ? `Checkout Complete — ${invoiceNumber}` : `Invoice Created — ${invoiceNumber}`,
      `Total: ${(invoice?.total || 0)} ${payment_method ? `via ${payment_method}` : ''}`.trim(),
      { appointment_id: parseInt(id), invoice_id: invoiceId }
    ).catch(() => {});

    res.json({
      success: true,
      message: pay_now ? 'Appointment checked out & paid' : 'Appointment completed — invoice created',
      data: {
        appointment_id: parseInt(id),
        invoice_id: invoiceId,
        invoice_number: invoiceNumber,
        total: invoice?.total || 0,
        status: invoice?.status || 'sent',
        payment_method,
        gift_card: giftCardResult
      }
    });
  } catch (error) {
    console.error('Checkout appointment error:', error);
    res.status(500).json({ success: false, message: 'Server error: ' + error.message });
  }
});

/**
 * Delete appointment
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;

    // Cancel reminders before deleting
    try {
      const { cancelAppointmentReminders } = await import('../lib/reminders.js');
      await cancelAppointmentReminders(id);
    } catch (reminderError) {
      console.warn('Could not cancel reminders:', reminderError.message);
    }

    const result = await execute(
      'DELETE FROM appointments WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Appointment not found' });
    }

    res.json({ success: true, message: 'Appointment deleted successfully' });
  } catch (error) {
    console.error('Error deleting appointment:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * Get staff availability for a specific date
 */
router.get('/staff/:staff_id/availability', async (req, res) => {
  try {
    const { staff_id } = req.params;
    const { date } = req.query;
    const tenantId = req.tenantId;

    if (!date) {
      return res.status(400).json({ success: false, message: 'Date required' });
    }

    // Get day of week (0 = Sunday, 6 = Saturday)
    const dateObj = new Date(date);
    const dayOfWeek = dateObj.getDay();

    // Check if staff has a day off on this date
    const [dayOff] = await query(
      `SELECT id FROM staff_days_off 
       WHERE tenant_id = ? AND staff_id = ? AND date = ?`,
      [tenantId, staff_id, date]
    );

    if (dayOff) {
      // Staff is off on this day
      return res.json({ 
        success: true, 
        data: { 
          date, 
          slots: [],
          workingHours: null,
          isDayOff: true
        } 
      });
    }

    // Get staff schedule for this day of week
    const [schedule] = await query(
      `SELECT start_time, end_time, break_start, break_end, is_working
       FROM staff_schedule
       WHERE tenant_id = ? AND staff_id = ? AND day_of_week = ? AND is_working = 1
       LIMIT 1`,
      [tenantId, staff_id, dayOfWeek]
    );

    // Default working hours if no schedule found (8 AM - 6 PM)
    let startHour = 8;
    let startMin = 0;
    let endHour = 18;
    let endMin = 0;
    let breakStart = null;
    let breakEnd = null;

    if (schedule) {
      // Parse start_time (HH:MM:SS format)
      const [startH, startM] = schedule.start_time.split(':').map(Number);
      startHour = startH;
      startMin = startM;

      // Parse end_time (HH:MM:SS format)
      const [endH, endM] = schedule.end_time.split(':').map(Number);
      endHour = endH;
      endMin = endM;

      // Parse break times if available
      if (schedule.break_start) {
        const [breakSH, breakSM] = schedule.break_start.split(':').map(Number);
        breakStart = { hour: breakSH, minute: breakSM };
      }
      if (schedule.break_end) {
        const [breakEH, breakEM] = schedule.break_end.split(':').map(Number);
        breakEnd = { hour: breakEH, minute: breakEM };
      }
    }

    // Get all appointments for that day
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const booked = await query(
      `SELECT start_time, end_time FROM appointments
       WHERE tenant_id = ? AND staff_id = ? 
       AND start_time >= ? AND start_time <= ?
       AND status NOT IN ('cancelled', 'no_show', 'completed')
       ORDER BY start_time`,
      [tenantId, staff_id, dayStart, dayEnd]
    );

    // Generate 30-min slots based on working hours
    const slots = [];
    const slotInterval = 30; // 30 minutes

    // Calculate total minutes for start and end
    const startTotalMinutes = startHour * 60 + startMin;
    const endTotalMinutes = endHour * 60 + endMin;

    for (let totalMinutes = startTotalMinutes; totalMinutes < endTotalMinutes; totalMinutes += slotInterval) {
      const hour = Math.floor(totalMinutes / 60);
      const minute = totalMinutes % 60;

      // Skip if in break time
      if (breakStart && breakEnd) {
        const breakStartMinutes = breakStart.hour * 60 + breakStart.minute;
        const breakEndMinutes = breakEnd.hour * 60 + breakEnd.minute;
        if (totalMinutes >= breakStartMinutes && totalMinutes < breakEndMinutes) {
          continue; // Skip break time
        }
      }

      const slotTime = new Date(date);
      slotTime.setHours(hour, minute, 0, 0);
      
      const isBooked = booked.some(b => {
        const startTime = new Date(b.start_time);
        const endTime = new Date(b.end_time);
        return slotTime >= startTime && slotTime < endTime;
      });

      slots.push({
        time: slotTime.toISOString(),
        available: !isBooked
      });
    }

    res.json({ 
      success: true, 
      data: { 
        date, 
        slots,
        workingHours: schedule ? {
          start: schedule.start_time,
          end: schedule.end_time,
          break_start: schedule.break_start,
          break_end: schedule.break_end
        } : null
      } 
    });
  } catch (error) {
    console.error('Error fetching availability:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * Get today's appointments dashboard
 */
router.get('/dashboard/today', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const today = new Date().toISOString().split('T')[0];

    const appointments = await query(
      `SELECT a.*, 
              c.first_name as customer_first_name, c.last_name as customer_last_name,
              s.full_name as staff_name,
              p.name as service_name
       FROM appointments a
       LEFT JOIN contacts c ON a.customer_id = c.id
       LEFT JOIN staff s ON a.staff_id = s.id
       LEFT JOIN products p ON a.service_id = p.id
       WHERE a.tenant_id = ? AND DATE(a.start_time) = ?
       ORDER BY a.start_time`,
      [tenantId, today]
    );

    const stats = {
      total: appointments.length,
      scheduled: appointments.filter(a => a.status === 'scheduled').length,
      confirmed: appointments.filter(a => a.status === 'confirmed').length,
      in_progress: appointments.filter(a => a.status === 'in_progress').length,
      completed: appointments.filter(a => a.status === 'completed').length,
      cancelled: appointments.filter(a => a.status === 'cancelled').length,
      no_show: appointments.filter(a => a.status === 'no_show').length,
    };

    res.json({ success: true, data: { appointments, stats } });
  } catch (error) {
    console.error('Error fetching today appointments:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
