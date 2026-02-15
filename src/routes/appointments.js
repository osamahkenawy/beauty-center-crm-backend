import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

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
 * Create appointment
 */
router.post('/', async (req, res) => {
  try {
    const { customer_id, service_id, staff_id, start_time, end_time, notes } = req.body;
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

    // Check for conflicts
    const conflicts = await query(
      `SELECT id FROM appointments 
       WHERE tenant_id = ? AND staff_id = ? 
       AND status NOT IN ('cancelled', 'no_show')
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

    // Create appointment
    const result = await execute(
      `INSERT INTO appointments (tenant_id, customer_id, service_id, staff_id, start_time, end_time, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, customer_id, service_id, staff_id, mysqlStartTime, mysqlEndTime, notes, req.user.id]
    );

    // Create reminder (24 hours before) - optional, don't fail if table doesn't exist
    try {
      const reminderTime = new Date(start_time);
      reminderTime.setDate(reminderTime.getDate() - 1);
      
      await execute(
        `INSERT INTO appointment_reminders (appointment_id, send_at, method)
         VALUES (?, ?, 'email')`,
        [result.insertId, toMySQLDateTime(reminderTime.toISOString())]
      );
    } catch (reminderError) {
      console.warn('Could not create appointment reminder:', reminderError.message);
      // Don't fail the appointment creation if reminder fails
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

    res.status(201).json({
      success: true,
      data: appointment,
      message: 'Appointment created successfully'
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

    // Base WHERE clause
    let whereClause = `WHERE a.tenant_id = ?`;
    const params = [tenantId];

    if (staff_id) {
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
      if (from_date) {
        whereClause += ` AND DATE(a.start_time) >= ?`;
        params.push(from_date);
      }

      if (to_date) {
        whereClause += ` AND DATE(a.start_time) <= ?`;
        params.push(to_date);
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

    params.push(id, tenantId);

    await execute(
      `UPDATE appointments SET ${updates.join(', ')} WHERE id = ? AND tenant_id = ?`,
      params
    );

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
 * Delete appointment
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;

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

    // Get all appointments for that day
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const booked = await query(
      `SELECT start_time, end_time FROM appointments
       WHERE tenant_id = ? AND staff_id = ? 
       AND start_time >= ? AND start_time <= ?
       AND status NOT IN ('cancelled', 'no_show')
       ORDER BY start_time`,
      [tenantId, staff_id, dayStart, dayEnd]
    );

    // Generate 30-min slots from 8 AM to 6 PM
    const slots = [];
    for (let hour = 8; hour < 18; hour++) {
      for (let min = 0; min < 60; min += 30) {
        const slotTime = new Date(date);
        slotTime.setHours(hour, min, 0, 0);
        
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
    }

    res.json({ success: true, data: { date, slots } });
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
