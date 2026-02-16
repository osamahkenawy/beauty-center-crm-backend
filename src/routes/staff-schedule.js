import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

router.use(authMiddleware);

// ============================================
// STAFF SCHEDULES
// ============================================

/**
 * Get all staff schedules
 */
router.get('/schedules', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const schedules = await query(
      `SELECT ss.*, s.full_name as staff_name
       FROM staff_schedule ss
       LEFT JOIN staff s ON ss.staff_id = s.id
       WHERE ss.tenant_id = ?
       ORDER BY ss.staff_id, ss.day_of_week`,
      [tenantId]
    );
    res.json({ success: true, data: schedules });
  } catch (error) {
    console.error('Get schedules error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch schedules' });
  }
});

/**
 * Create staff schedule
 */
router.post('/schedules', async (req, res) => {
  try {
    const { staff_id, day_of_week, start_time, end_time, break_start, break_end, is_working } = req.body;
    const tenantId = req.tenantId;

    if (!staff_id || day_of_week === undefined || !start_time || !end_time) {
      return res.status(400).json({ success: false, message: 'Staff, day, start time, and end time are required' });
    }

    // Check for duplicate
    const existing = await query(
      'SELECT id FROM staff_schedule WHERE tenant_id = ? AND staff_id = ? AND day_of_week = ?',
      [tenantId, staff_id, day_of_week]
    );
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'Schedule already exists for this staff member on this day' });
    }

    const result = await execute(
      `INSERT INTO staff_schedule (tenant_id, staff_id, day_of_week, start_time, end_time, break_start, break_end, is_working)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, staff_id, day_of_week, start_time, end_time, break_start || null, break_end || null, is_working !== false ? 1 : 0]
    );

    res.json({ success: true, data: { id: result.insertId }, message: 'Schedule created' });
  } catch (error) {
    console.error('Create schedule error:', error);
    res.status(500).json({ success: false, message: 'Failed to create schedule' });
  }
});

/**
 * Update staff schedule
 */
router.patch('/schedules/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { start_time, end_time, break_start, break_end, is_working } = req.body;
    const tenantId = req.tenantId;

    const fields = [];
    const values = [];
    if (start_time) { fields.push('start_time = ?'); values.push(start_time); }
    if (end_time) { fields.push('end_time = ?'); values.push(end_time); }
    if (break_start !== undefined) { fields.push('break_start = ?'); values.push(break_start || null); }
    if (break_end !== undefined) { fields.push('break_end = ?'); values.push(break_end || null); }
    if (is_working !== undefined) { fields.push('is_working = ?'); values.push(is_working ? 1 : 0); }

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields to update' });
    }

    values.push(id, tenantId);
    await execute(`UPDATE staff_schedule SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`, values);

    res.json({ success: true, message: 'Schedule updated' });
  } catch (error) {
    console.error('Update schedule error:', error);
    res.status(500).json({ success: false, message: 'Failed to update schedule' });
  }
});

/**
 * Delete staff schedule
 */
router.delete('/schedules/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;
    await execute('DELETE FROM staff_schedule WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    res.json({ success: true, message: 'Schedule deleted' });
  } catch (error) {
    console.error('Delete schedule error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete schedule' });
  }
});

// ============================================
// DAYS OFF
// ============================================

/**
 * Get all staff days off
 */
router.get('/days-off', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const daysOff = await query(
      `SELECT sdo.*, s.full_name as staff_name
       FROM staff_days_off sdo
       LEFT JOIN staff s ON sdo.staff_id = s.id
       WHERE sdo.tenant_id = ?
       ORDER BY sdo.date DESC`,
      [tenantId]
    );
    res.json({ success: true, data: daysOff });
  } catch (error) {
    console.error('Get days off error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch days off' });
  }
});

/**
 * Create day off
 */
router.post('/days-off', async (req, res) => {
  try {
    const { staff_id, date, reason } = req.body;
    const tenantId = req.tenantId;

    if (!staff_id || !date) {
      return res.status(400).json({ success: false, message: 'Staff and date are required' });
    }

    const result = await execute(
      'INSERT INTO staff_days_off (tenant_id, staff_id, date, reason) VALUES (?, ?, ?, ?)',
      [tenantId, staff_id, date, reason || null]
    );

    res.json({ success: true, data: { id: result.insertId }, message: 'Day off created' });
  } catch (error) {
    console.error('Create day off error:', error);
    res.status(500).json({ success: false, message: 'Failed to create day off' });
  }
});

/**
 * Delete day off
 */
router.delete('/days-off/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;
    await execute('DELETE FROM staff_days_off WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    res.json({ success: true, message: 'Day off deleted' });
  } catch (error) {
    console.error('Delete day off error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete day off' });
  }
});

// ============================================
// SPECIALIZATIONS
// ============================================

/**
 * Get all staff specializations
 */
router.get('/specializations', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const specs = await query(
      `SELECT ssp.*, s.full_name as staff_name, p.name as service_name
       FROM staff_specializations ssp
       LEFT JOIN staff s ON ssp.staff_id = s.id
       LEFT JOIN products p ON ssp.service_id = p.id
       WHERE ssp.tenant_id = ?
       ORDER BY ssp.staff_id`,
      [tenantId]
    );
    res.json({ success: true, data: specs });
  } catch (error) {
    console.error('Get specializations error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch specializations' });
  }
});

/**
 * Create specialization
 */
router.post('/specializations', async (req, res) => {
  try {
    const { staff_id, service_id, skill_level } = req.body;
    const tenantId = req.tenantId;

    if (!staff_id || !service_id) {
      return res.status(400).json({ success: false, message: 'Staff and service are required' });
    }

    // Check for duplicate
    const existing = await query(
      'SELECT id FROM staff_specializations WHERE tenant_id = ? AND staff_id = ? AND service_id = ?',
      [tenantId, staff_id, service_id]
    );
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'Staff member already has this specialization' });
    }

    const result = await execute(
      'INSERT INTO staff_specializations (tenant_id, staff_id, service_id, skill_level) VALUES (?, ?, ?, ?)',
      [tenantId, staff_id, service_id, skill_level || 'intermediate']
    );

    res.json({ success: true, data: { id: result.insertId }, message: 'Specialization added' });
  } catch (error) {
    console.error('Create specialization error:', error);
    res.status(500).json({ success: false, message: 'Failed to add specialization' });
  }
});

/**
 * Delete specialization
 */
router.delete('/specializations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;
    await execute('DELETE FROM staff_specializations WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    res.json({ success: true, message: 'Specialization removed' });
  } catch (error) {
    console.error('Delete specialization error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove specialization' });
  }
});

/**
 * Dashboard stats
 */
router.get('/stats', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    
    const [staffCount] = await query('SELECT COUNT(*) as count FROM staff WHERE tenant_id = ?', [tenantId]);
    const [scheduleCount] = await query('SELECT COUNT(*) as count FROM staff_schedule WHERE tenant_id = ?', [tenantId]);
    const [daysOffCount] = await query('SELECT COUNT(*) as count FROM staff_days_off WHERE tenant_id = ? AND date >= CURDATE()', [tenantId]);
    const [specCount] = await query('SELECT COUNT(DISTINCT service_id) as count FROM staff_specializations WHERE tenant_id = ?', [tenantId]);

    res.json({
      success: true,
      data: {
        totalStaff: staffCount.count,
        totalSchedules: scheduleCount.count,
        upcomingDaysOff: daysOffCount.count,
        totalSpecializations: specCount.count,
      }
    });
  } catch (error) {
    console.error('Staff schedule stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

export default router;
