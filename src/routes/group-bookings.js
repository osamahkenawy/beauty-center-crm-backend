import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

async function ensureTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS group_bookings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      branch_id INT,
      name VARCHAR(255) NOT NULL,
      organizer_contact_id INT,
      event_date DATE NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME,
      total_participants INT DEFAULT 0,
      max_participants INT DEFAULT 20,
      status ENUM('pending','confirmed','in_progress','completed','cancelled') DEFAULT 'pending',
      notes TEXT,
      total_amount DECIMAL(10,2) DEFAULT 0,
      created_by INT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_date (event_date)
    )
  `);
  await execute(`
    CREATE TABLE IF NOT EXISTS group_booking_participants (
      id INT AUTO_INCREMENT PRIMARY KEY,
      group_booking_id INT NOT NULL,
      contact_id INT,
      guest_name VARCHAR(255),
      guest_phone VARCHAR(50),
      service_id INT,
      staff_id INT,
      appointment_id INT,
      status ENUM('confirmed','cancelled','no_show','completed') DEFAULT 'confirmed',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_group (group_booking_id),
      INDEX idx_contact (contact_id)
    )
  `);
}

// ── Stats (must be before /:id) ──
router.get('/stats', async (req, res) => {
  try {
    await ensureTable();
    const [total] = await query('SELECT COUNT(*) as count FROM group_bookings WHERE tenant_id = ?', [req.tenantId]);
    const [pending] = await query('SELECT COUNT(*) as count FROM group_bookings WHERE tenant_id = ? AND status = ?', [req.tenantId, 'pending']);
    const [confirmed] = await query('SELECT COUNT(*) as count FROM group_bookings WHERE tenant_id = ? AND status = ?', [req.tenantId, 'confirmed']);
    const [completed] = await query('SELECT COUNT(*) as count FROM group_bookings WHERE tenant_id = ? AND status = ?', [req.tenantId, 'completed']);
    const [totalParticipants] = await query(`
      SELECT COUNT(*) as count FROM group_booking_participants gp
      JOIN group_bookings g ON gp.group_booking_id = g.id
      WHERE g.tenant_id = ? AND gp.status != 'cancelled'
    `, [req.tenantId]);

    res.json({
      success: true,
      data: {
        total: total?.count || 0,
        pending: pending?.count || 0,
        confirmed: confirmed?.count || 0,
        completed: completed?.count || 0,
        total_participants: totalParticipants?.count || 0
      }
    });
  } catch (error) {
    console.error('Group booking stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ── List ──
router.get('/', async (req, res) => {
  try {
    await ensureTable();
    const { status, from_date, to_date, page = 1, limit = 20 } = req.query;
    let where = 'WHERE g.tenant_id = ?';
    const params = [req.tenantId];

    if (status) { where += ' AND g.status = ?'; params.push(status); }
    if (from_date) { where += ' AND g.event_date >= ?'; params.push(from_date); }
    if (to_date) { where += ' AND g.event_date <= ?'; params.push(to_date); }

    const [cnt] = await query(`SELECT COUNT(*) as count FROM group_bookings g ${where}`, params);
    const total = cnt?.count || 0;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const rows = await query(`
      SELECT g.*, 
             b.name as branch_name,
             c.first_name as organizer_first_name, c.last_name as organizer_last_name,
             (SELECT COUNT(*) FROM group_booking_participants WHERE group_booking_id = g.id AND status != 'cancelled') as participant_count
      FROM group_bookings g
      LEFT JOIN branches b ON g.branch_id = b.id
      LEFT JOIN contacts c ON g.organizer_contact_id = c.id
      ${where}
      ORDER BY g.event_date DESC, g.start_time DESC
      LIMIT ${parseInt(limit)} OFFSET ${offset}
    `, params);

    res.json({
      success: true,
      data: rows,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (error) {
    console.error('Group bookings list error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch group bookings' });
  }
});

// ── Get single with participants ──
router.get('/:id', async (req, res) => {
  try {
    await ensureTable();
    const [booking] = await query(`
      SELECT g.*, b.name as branch_name,
             c.first_name as organizer_first_name, c.last_name as organizer_last_name
      FROM group_bookings g
      LEFT JOIN branches b ON g.branch_id = b.id
      LEFT JOIN contacts c ON g.organizer_contact_id = c.id
      WHERE g.id = ? AND g.tenant_id = ?
    `, [req.params.id, req.tenantId]);

    if (!booking) return res.status(404).json({ success: false, message: 'Group booking not found' });

    const participants = await query(`
      SELECT p.*, 
             c.first_name as contact_first_name, c.last_name as contact_last_name, c.phone as contact_phone,
             pr.name as service_name, pr.unit_price as service_price,
             s.full_name as staff_name
      FROM group_booking_participants p
      LEFT JOIN contacts c ON p.contact_id = c.id
      LEFT JOIN products pr ON p.service_id = pr.id
      LEFT JOIN staff s ON p.staff_id = s.id
      WHERE p.group_booking_id = ?
      ORDER BY p.created_at ASC
    `, [booking.id]);

    booking.participants = participants;
    res.json({ success: true, data: booking });
  } catch (error) {
    console.error('Group booking get error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch group booking' });
  }
});

// ── Create ──
router.post('/', async (req, res) => {
  try {
    await ensureTable();
    const { name, branch_id, organizer_contact_id, event_date, start_time, end_time, max_participants, notes, participants = [] } = req.body;

    if (!name || !event_date || !start_time) {
      return res.status(400).json({ success: false, message: 'Name, date and start time required' });
    }

    const result = await execute(`
      INSERT INTO group_bookings (tenant_id, branch_id, name, organizer_contact_id, event_date, start_time, end_time, max_participants, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.tenantId, branch_id || null, name, organizer_contact_id || null,
      event_date, start_time, end_time || null, max_participants || 20,
      notes || null, req.user.id
    ]);

    const groupId = result.insertId;

    // Add participants
    for (const p of participants) {
      await execute(`
        INSERT INTO group_booking_participants (group_booking_id, contact_id, guest_name, guest_phone, service_id, staff_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [groupId, p.contact_id || null, p.guest_name || null, p.guest_phone || null, p.service_id || null, p.staff_id || null, p.notes || null]);
    }

    // Update participant count
    await execute('UPDATE group_bookings SET total_participants = ? WHERE id = ?', [participants.length, groupId]);

    res.status(201).json({ success: true, message: 'Group booking created', data: { id: groupId } });
  } catch (error) {
    console.error('Group booking create error:', error);
    res.status(500).json({ success: false, message: 'Failed to create group booking' });
  }
});

// ── Update ──
router.patch('/:id', async (req, res) => {
  try {
    await ensureTable();
    const updates = [];
    const params = [];
    const allowed = ['name', 'branch_id', 'organizer_contact_id', 'event_date', 'start_time', 'end_time', 'max_participants', 'status', 'notes', 'total_amount'];

    for (const f of allowed) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        params.push(req.body[f] || null);
      }
    }
    if (updates.length === 0) return res.json({ success: true, message: 'No changes' });

    params.push(req.params.id, req.tenantId);
    await execute(`UPDATE group_bookings SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`, params);
    res.json({ success: true, message: 'Group booking updated' });
  } catch (error) {
    console.error('Group booking update error:', error);
    res.status(500).json({ success: false, message: 'Failed to update group booking' });
  }
});

// ── Delete ──
router.delete('/:id', async (req, res) => {
  try {
    await ensureTable();
    await execute('DELETE FROM group_booking_participants WHERE group_booking_id = ?', [req.params.id]);
    await execute('DELETE FROM group_bookings WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    res.json({ success: true, message: 'Group booking deleted' });
  } catch (error) {
    console.error('Group booking delete error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete group booking' });
  }
});

// ── Add participant ──
router.post('/:id/participants', async (req, res) => {
  try {
    await ensureTable();
    const { contact_id, guest_name, guest_phone, service_id, staff_id, notes } = req.body;

    // Check max
    const [booking] = await query('SELECT max_participants FROM group_bookings WHERE id = ? AND tenant_id = ?', [req.params.id, req.tenantId]);
    if (!booking) return res.status(404).json({ success: false, message: 'Group booking not found' });

    const [cnt] = await query('SELECT COUNT(*) as count FROM group_booking_participants WHERE group_booking_id = ? AND status != ?', [req.params.id, 'cancelled']);
    if (cnt.count >= booking.max_participants) {
      return res.status(400).json({ success: false, message: 'Maximum participants reached' });
    }

    const result = await execute(`
      INSERT INTO group_booking_participants (group_booking_id, contact_id, guest_name, guest_phone, service_id, staff_id, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [req.params.id, contact_id || null, guest_name || null, guest_phone || null, service_id || null, staff_id || null, notes || null]);

    // Update count
    await execute('UPDATE group_bookings SET total_participants = total_participants + 1 WHERE id = ?', [req.params.id]);

    res.status(201).json({ success: true, message: 'Participant added', data: { id: result.insertId } });
  } catch (error) {
    console.error('Add participant error:', error);
    res.status(500).json({ success: false, message: 'Failed to add participant' });
  }
});

// ── Remove participant ──
router.delete('/:id/participants/:pid', async (req, res) => {
  try {
    await ensureTable();
    await execute('UPDATE group_booking_participants SET status = ? WHERE id = ? AND group_booking_id = ?', ['cancelled', req.params.pid, req.params.id]);
    await execute('UPDATE group_bookings SET total_participants = GREATEST(total_participants - 1, 0) WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Participant removed' });
  } catch (error) {
    console.error('Remove participant error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove participant' });
  }
});

// ══════════════════════════════════════════════════════════
// ── Confirm Group Booking → Auto-create appointments ──
// ══════════════════════════════════════════════════════════
router.post('/:id/confirm', async (req, res) => {
  try {
    await ensureTable();
    const tenantId = req.tenantId;
    const groupId = req.params.id;

    // 1. Get the group booking
    const [booking] = await query('SELECT * FROM group_bookings WHERE id = ? AND tenant_id = ?', [groupId, tenantId]);
    if (!booking) return res.status(404).json({ success: false, message: 'Group booking not found' });

    if (booking.status === 'confirmed' || booking.status === 'in_progress' || booking.status === 'completed') {
      return res.status(400).json({ success: false, message: `Booking is already ${booking.status}` });
    }
    if (booking.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'Cannot confirm a cancelled booking' });
    }

    // 2. Get active participants
    const participants = await query(
      "SELECT * FROM group_booking_participants WHERE group_booking_id = ? AND status != 'cancelled'",
      [groupId]
    );

    if (participants.length === 0) {
      return res.status(400).json({ success: false, message: 'No active participants to create appointments for' });
    }

    // 3. Create individual appointments for each participant
    const createdAppointments = [];
    for (const p of participants) {
      if (!p.service_id) continue; // skip participants without a service

      // Build start/end datetime from group booking date + time
      // event_date may come as Date object or string from MySQL
      const eventDateStr = booking.event_date instanceof Date 
        ? booking.event_date.toISOString().split('T')[0]
        : String(booking.event_date).split('T')[0].slice(0, 10);
      const startDT = `${eventDateStr} ${booking.start_time}`;
      const endDT = booking.end_time
        ? `${eventDateStr} ${booking.end_time}`
        : `${eventDateStr} ${booking.start_time}`; // fallback same time

      const contactId = p.contact_id || null;

      // If participant is a guest without a contact_id, create a quick contact
      let customerId = contactId;
      if (!customerId && p.guest_name) {
        const nameParts = (p.guest_name || 'Guest').split(' ');
        const guestResult = await execute(
          'INSERT INTO contacts (tenant_id, first_name, last_name, phone, status) VALUES (?,?,?,?,?)',
          [tenantId, nameParts[0], nameParts.slice(1).join(' ') || '', p.guest_phone || '', 'active']
        );
        customerId = guestResult.insertId;
        // Update the participant with the new contact_id
        await execute('UPDATE group_booking_participants SET contact_id = ? WHERE id = ?', [customerId, p.id]);
      }

      if (!customerId) continue; // can't create appointment without a customer

      try {
        const aptResult = await execute(
          `INSERT INTO appointments (tenant_id, customer_id, service_id, staff_id, start_time, end_time, notes, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
          [
            tenantId, customerId, p.service_id, p.staff_id || null,
            startDT, endDT,
            `Group Booking: ${booking.name} (Participant #${p.id})`,
            req.user?.id || null
          ]
        );

        // Link the appointment back to the participant
        await execute('UPDATE group_booking_participants SET appointment_id = ? WHERE id = ?', [aptResult.insertId, p.id]);

        createdAppointments.push({
          participant_id: p.id,
          appointment_id: aptResult.insertId,
          customer_id: customerId,
          service_id: p.service_id,
          staff_id: p.staff_id
        });
      } catch (aptError) {
        console.warn(`Failed to create appointment for participant ${p.id}:`, aptError.message);
      }
    }

    // 4. Update group booking status to confirmed
    await execute('UPDATE group_bookings SET status = ? WHERE id = ? AND tenant_id = ?', ['confirmed', groupId, tenantId]);

    res.json({
      success: true,
      message: `Group booking confirmed! ${createdAppointments.length} appointment(s) created.`,
      data: {
        group_booking_id: parseInt(groupId),
        status: 'confirmed',
        appointments_created: createdAppointments.length,
        appointments: createdAppointments
      }
    });
  } catch (error) {
    console.error('Confirm group booking error:', error);
    res.status(500).json({ success: false, message: 'Failed to confirm group booking: ' + error.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ── Checkout Group Booking → Auto-create combined invoice ──
// ══════════════════════════════════════════════════════════════
router.post('/:id/checkout', async (req, res) => {
  try {
    await ensureTable();
    const tenantId = req.tenantId;
    const groupId = req.params.id;
    const {
      payment_method = 'cash',
      discount_amount = 0,
      discount_type = 'fixed',
      tax_rate = 5,
      pay_now = true,
      notes
    } = req.body;

    // 1. Get the group booking
    const [booking] = await query('SELECT * FROM group_bookings WHERE id = ? AND tenant_id = ?', [groupId, tenantId]);
    if (!booking) return res.status(404).json({ success: false, message: 'Group booking not found' });

    if (booking.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'Cannot checkout a cancelled booking' });
    }

    // 2. Check if invoice already exists for this group booking
    const [existingInvoice] = await query(
      "SELECT id, invoice_number, total, status FROM invoices WHERE tenant_id = ? AND notes LIKE ?",
      [tenantId, `%[GROUP-${groupId}]%`]
    );

    if (existingInvoice) {
      return res.json({
        success: true,
        message: 'Invoice already exists for this group booking',
        data: {
          group_booking_id: parseInt(groupId),
          invoice_id: existingInvoice.id,
          invoice_number: existingInvoice.invoice_number,
          total: existingInvoice.total,
          status: existingInvoice.status
        }
      });
    }

    // 3. Get all active participants with service details
    const participants = await query(`
      SELECT p.*, 
             pr.name as service_name, pr.unit_price as service_price, pr.currency,
             c.first_name, c.last_name,
             s.full_name as staff_name
      FROM group_booking_participants p
      LEFT JOIN products pr ON p.service_id = pr.id
      LEFT JOIN contacts c ON p.contact_id = c.id
      LEFT JOIN staff s ON p.staff_id = s.id
      WHERE p.group_booking_id = ? AND p.status != 'cancelled'
    `, [groupId]);

    if (participants.length === 0) {
      return res.status(400).json({ success: false, message: 'No active participants to invoice' });
    }

    // 4. Calculate totals
    let subtotal = 0;
    const lineItems = [];

    for (const p of participants) {
      const price = parseFloat(p.service_price || 0);
      subtotal += price;
      lineItems.push({
        participant_id: p.id,
        service_id: p.service_id,
        name: `${p.service_name || 'Service'} — ${p.first_name || p.guest_name || 'Guest'} ${p.last_name || ''}`.trim(),
        unit_price: price,
        staff_name: p.staff_name
      });
    }

    const disc = discount_type === 'percentage'
      ? subtotal * (parseFloat(discount_amount) / 100)
      : parseFloat(discount_amount || 0);
    const afterDiscount = subtotal - disc;
    const taxAmount = afterDiscount * (parseFloat(tax_rate) / 100);
    const total = afterDiscount + taxAmount;
    const amountPaid = pay_now ? total : 0;

    // 5. Generate invoice number
    const [lastInv] = await query(
      "SELECT invoice_number FROM invoices WHERE tenant_id = ? ORDER BY id DESC LIMIT 1",
      [tenantId]
    );
    const lastNum = lastInv?.invoice_number ? parseInt(lastInv.invoice_number.replace('INV-', '')) || 0 : 0;
    const invoiceNumber = `INV-${String(lastNum + 1).padStart(4, '0')}`;

    // Use organizer as the customer on the invoice
    const customerId = booking.organizer_contact_id || participants[0]?.contact_id || null;
    const currency = participants[0]?.currency || 'AED';

    // 6. Create the invoice
    const invResult = await execute(`
      INSERT INTO invoices (tenant_id, branch_id, customer_id, 
        invoice_number, subtotal, discount_amount, discount_type, tax_rate, tax_amount,
        total, amount_paid, currency, status, payment_method, paid_at, notes, created_by)
      VALUES (?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?,?,?)
    `, [
      tenantId, booking.branch_id || null, customerId,
      invoiceNumber, subtotal, disc, discount_type, tax_rate, taxAmount,
      total, amountPaid, currency,
      pay_now ? 'paid' : 'sent',
      payment_method,
      pay_now ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null,
      `Group Booking: ${booking.name} [GROUP-${groupId}]${notes ? ' — ' + notes : ''}`,
      req.user?.id || null
    ]);

    const invoiceId = invResult.insertId;

    // 7. Add line items (one per participant service)
    for (const item of lineItems) {
      await execute(`
        INSERT INTO invoice_items (invoice_id, item_type, item_id, name, quantity, unit_price, total)
        VALUES (?, 'service', ?, ?, 1, ?, ?)
      `, [invoiceId, item.service_id || null, item.name, item.unit_price, item.unit_price]);
    }

    // 8. Mark group booking as completed
    await execute('UPDATE group_bookings SET status = ?, total_amount = ? WHERE id = ? AND tenant_id = ?', ['completed', total, groupId, tenantId]);

    // 9. Complete all individual appointments
    await execute(`
      UPDATE appointments SET status = 'completed', customer_showed = 1, payment_status = ?
      WHERE id IN (
        SELECT appointment_id FROM group_booking_participants 
        WHERE group_booking_id = ? AND appointment_id IS NOT NULL AND status != 'cancelled'
      ) AND tenant_id = ?
    `, [pay_now ? 'paid' : 'pending', groupId, tenantId]);

    // 10. Mark participants as completed
    await execute(
      "UPDATE group_booking_participants SET status = 'completed' WHERE group_booking_id = ? AND status != 'cancelled'",
      [groupId]
    );

    res.json({
      success: true,
      message: pay_now ? 'Group booking checked out & paid!' : 'Group booking completed — invoice created',
      data: {
        group_booking_id: parseInt(groupId),
        invoice_id: invoiceId,
        invoice_number: invoiceNumber,
        total,
        items_count: lineItems.length,
        status: pay_now ? 'paid' : 'sent',
        payment_method
      }
    });
  } catch (error) {
    console.error('Checkout group booking error:', error);
    res.status(500).json({ success: false, message: 'Failed to checkout: ' + error.message });
  }
});

export default router;
