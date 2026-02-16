import express from 'express';
import { query } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();
router.use(authMiddleware);

// ── Revenue Report ──
router.get('/revenue', async (req, res) => {
  try {
    const t = req.tenantId;
    const { period = 'monthly', from_date, to_date } = req.query;

    let dateFilter = '';
    const params = [t];
    if (from_date) { dateFilter += ' AND DATE(i.created_at) >= ?'; params.push(from_date); }
    if (to_date) { dateFilter += ' AND DATE(i.created_at) <= ?'; params.push(to_date); }

    let groupBy, selectDate;
    if (period === 'daily') { selectDate = "DATE(i.created_at)"; groupBy = "DATE(i.created_at)"; }
    else if (period === 'weekly') { selectDate = "DATE(DATE_SUB(i.created_at, INTERVAL WEEKDAY(i.created_at) DAY))"; groupBy = selectDate; }
    else { selectDate = "DATE_FORMAT(i.created_at, '%Y-%m')"; groupBy = selectDate; }

    const timeline = await query(`
      SELECT ${selectDate} as period_label,
        COUNT(*) as invoices,
        SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END) as revenue,
        SUM(CASE WHEN status = 'paid' THEN tax_amount ELSE 0 END) as tax_collected,
        SUM(CASE WHEN status = 'paid' THEN discount_amount ELSE 0 END) as discounts_given
      FROM invoices i
      WHERE i.tenant_id = ? ${dateFilter}
      GROUP BY ${groupBy}
      ORDER BY period_label
    `, params);

    // Totals
    const [totals] = await query(`
      SELECT
        SUM(CASE WHEN status = 'paid' THEN total ELSE 0 END) as total_revenue,
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_invoices,
        SUM(CASE WHEN status IN ('draft','sent','overdue') THEN total ELSE 0 END) as outstanding,
        AVG(CASE WHEN status = 'paid' THEN total END) as avg_invoice
      FROM invoices i WHERE i.tenant_id = ? ${dateFilter}
    `, params);

    // Revenue by payment method
    const byMethod = await query(`
      SELECT COALESCE(payment_method, 'Unknown') as method, SUM(total) as amount, COUNT(*) as count
      FROM invoices WHERE tenant_id = ? AND status = 'paid' ${dateFilter.replace(/i\./g, '')}
      GROUP BY payment_method ORDER BY amount DESC
    `, params);

    res.json({ success: true, data: { timeline, totals, byMethod } });
  } catch (error) {
    console.error('Revenue report error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Staff Performance ──
router.get('/staff-performance', async (req, res) => {
  try {
    const t = req.tenantId;
    const { from_date, to_date } = req.query;
    let df = ''; const params = [t];
    if (from_date) { df += ' AND DATE(a.start_time) >= ?'; params.push(from_date); }
    if (to_date) { df += ' AND DATE(a.start_time) <= ?'; params.push(to_date); }

    const staff = await query(`
      SELECT s.id, s.full_name, s.role, s.avatar_url,
        COUNT(a.id) as total_appointments,
        SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN a.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN a.status = 'no_show' THEN 1 ELSE 0 END) as no_shows,
        ROUND(SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(a.id),0), 1) as completion_rate,
        COALESCE(SUM(CASE WHEN a.status = 'completed' THEN p.unit_price ELSE 0 END), 0) as revenue
      FROM staff s
      LEFT JOIN appointments a ON s.id = a.staff_id AND a.tenant_id = ? ${df}
      LEFT JOIN products p ON a.service_id = p.id
      WHERE s.tenant_id = ? AND s.is_active = 1
      GROUP BY s.id, s.full_name, s.role, s.avatar_url
      ORDER BY revenue DESC
    `, [...params, t]);

    res.json({ success: true, data: staff });
  } catch (error) {
    console.error('Staff performance error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Services Report ──
router.get('/services', async (req, res) => {
  try {
    const t = req.tenantId;
    const { from_date, to_date } = req.query;
    let df = ''; const params = [t];
    if (from_date) { df += ' AND DATE(a.start_time) >= ?'; params.push(from_date); }
    if (to_date) { df += ' AND DATE(a.start_time) <= ?'; params.push(to_date); }

    const services = await query(`
      SELECT p.id, p.name, p.unit_price, p.duration,
        sc.name as category_name, sc.color as category_color,
        COUNT(a.id) as total_bookings,
        SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as completed_bookings,
        COALESCE(SUM(CASE WHEN a.status = 'completed' THEN p.unit_price ELSE 0 END), 0) as revenue
      FROM products p
      LEFT JOIN appointments a ON p.id = a.service_id AND a.tenant_id = ? ${df}
      LEFT JOIN service_categories sc ON p.category_id = sc.id
      WHERE p.tenant_id = ? AND p.is_active = 1
      GROUP BY p.id, p.name, p.unit_price, p.duration, sc.name, sc.color
      ORDER BY total_bookings DESC
    `, [...params, t]);

    res.json({ success: true, data: services });
  } catch (error) {
    console.error('Services report error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Client Report ──
router.get('/clients', async (req, res) => {
  try {
    const t = req.tenantId;
    const { from_date, to_date } = req.query;
    let df = ''; const params = [t];
    if (from_date) { df += ' AND DATE(a.start_time) >= ?'; params.push(from_date); }
    if (to_date) { df += ' AND DATE(a.start_time) <= ?'; params.push(to_date); }

    // New vs returning
    const [totalClients] = await query(`SELECT COUNT(*) as total_clients FROM contacts WHERE tenant_id = ?`, [t]);
    const [newLast30] = await query(`SELECT COUNT(*) as count FROM contacts WHERE tenant_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`, [t]);
    const [activeClients] = await query(`SELECT COUNT(DISTINCT customer_id) as count FROM appointments WHERE tenant_id = ? AND status = 'completed'`, [t]);
    const clientStats = {
      total_clients: totalClients?.total_clients || 0,
      new_last_30: newLast30?.count || 0,
      active_clients: activeClients?.count || 0,
    };

    // Top clients
    const topClients = await query(`
      SELECT c.id, c.first_name, c.last_name, c.email, c.phone,
        COUNT(a.id) as visits,
        COALESCE(SUM(p.unit_price), 0) as total_spent,
        MAX(a.start_time) as last_visit
      FROM contacts c
      LEFT JOIN appointments a ON c.id = a.customer_id AND a.status = 'completed' AND a.tenant_id = ? ${df}
      LEFT JOIN products p ON a.service_id = p.id
      WHERE c.tenant_id = ?
      GROUP BY c.id, c.first_name, c.last_name, c.email, c.phone
      ORDER BY total_spent DESC
      LIMIT 20
    `, [...params, t]);

    res.json({ success: true, data: { stats: clientStats, topClients } });
  } catch (error) {
    console.error('Clients report error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Appointments Report ──
router.get('/appointments', async (req, res) => {
  try {
    const t = req.tenantId;
    const { from_date, to_date } = req.query;
    let df = ''; const params = [t];
    if (from_date) { df += ' AND DATE(a.start_time) >= ?'; params.push(from_date); }
    if (to_date) { df += ' AND DATE(a.start_time) <= ?'; params.push(to_date); }

    const [stats] = await query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) as no_shows,
        SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) as scheduled,
        SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed,
        ROUND(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*),0), 1) as completion_rate,
        ROUND(SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*),0), 1) as no_show_rate,
        ROUND(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*),0), 1) as cancellation_rate
      FROM appointments a WHERE a.tenant_id = ? ${df}
    `, params);

    // By day of week
    const byDayOfWeek = await query(`
      SELECT DAYOFWEEK(start_time) as dow, COUNT(*) as count
      FROM appointments a WHERE a.tenant_id = ? ${df}
      GROUP BY DAYOFWEEK(start_time) ORDER BY dow
    `, params);

    // By hour
    const byHour = await query(`
      SELECT HOUR(start_time) as hour, COUNT(*) as count
      FROM appointments a WHERE a.tenant_id = ? ${df}
      GROUP BY HOUR(start_time) ORDER BY hour
    `, params);

    res.json({ success: true, data: { stats, byDayOfWeek, byHour } });
  } catch (error) {
    console.error('Appointments report error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ── Legacy overview (keep old endpoint working) ──
router.get('/', async (req, res) => {
  try {
    const { type = 'overview', period = '30' } = req.query;
    const days = parseInt(period);
    let data = {};

    if (type === 'overview' || type === 'all') {
      const [leadsTotal] = await query('SELECT COUNT(*) as count FROM leads');
      const [leadsNew] = await query(`SELECT COUNT(*) as count FROM leads WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)`);
      const [leadsConverted] = await query(`SELECT COUNT(*) as count FROM leads WHERE status = 'converted' AND created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)`);
      const [dealsTotal] = await query('SELECT COUNT(*) as count FROM deals');
      const [dealsWon] = await query(`SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as value FROM deals WHERE status = 'won' AND created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)`);
      const [pipelineValue] = await query(`SELECT COALESCE(SUM(amount), 0) as value FROM deals WHERE status = 'open'`);
      const [activitiesCompleted] = await query(`SELECT COUNT(*) as count FROM activities WHERE status = 'completed' AND created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)`);
      const [activitiesOverdue] = await query(`SELECT COUNT(*) as count FROM activities WHERE due_date < CURDATE() AND status NOT IN ('completed', 'cancelled')`);

      data.overview = {
        leads: { total: leadsTotal?.count || 0, new: leadsNew?.count || 0, converted: leadsConverted?.count || 0 },
        deals: { total: dealsTotal?.count || 0, won: dealsWon?.count || 0, wonValue: parseFloat(dealsWon?.value) || 0, pipelineValue: parseFloat(pipelineValue?.value) || 0 },
        activities: { completed: activitiesCompleted?.count || 0, overdue: activitiesOverdue?.count || 0 }
      };
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error('Reports error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate report' });
  }
});

export default router;
