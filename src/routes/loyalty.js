import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

router.use(authMiddleware);

/**
 * Get all loyalty members with current points
 */
router.get('/', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const members = await query(
      `SELECT lp.*, 
              CONCAT(c.first_name, ' ', c.last_name) as customer_name,
              c.email as customer_email, c.phone as customer_phone
       FROM loyalty_points lp
       LEFT JOIN contacts c ON lp.customer_id = c.id
       WHERE lp.tenant_id = ?
       ORDER BY lp.current_points DESC`,
      [tenantId]
    );
    res.json({ success: true, data: members });
  } catch (error) {
    console.error('Get loyalty members error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch loyalty members' });
  }
});

/**
 * Enroll a customer in the loyalty program
 */
router.post('/', async (req, res) => {
  try {
    const { customer_id, tier } = req.body;
    const tenantId = req.tenantId;

    if (!customer_id) {
      return res.status(400).json({ success: false, message: 'Customer is required' });
    }

    // Check if already enrolled
    const existing = await query(
      'SELECT id FROM loyalty_points WHERE tenant_id = ? AND customer_id = ?',
      [tenantId, customer_id]
    );
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'Customer is already enrolled in the loyalty program' });
    }

    const result = await execute(
      `INSERT INTO loyalty_points (tenant_id, customer_id, current_points, total_earned, tier)
       VALUES (?, ?, 0, 0, ?)`,
      [tenantId, customer_id, tier || 'bronze']
    );

    res.json({ success: true, data: { id: result.insertId }, message: 'Customer enrolled successfully' });
  } catch (error) {
    console.error('Enroll loyalty error:', error);
    res.status(500).json({ success: false, message: 'Failed to enroll customer' });
  }
});

/**
 * Update loyalty member (tier, etc.)
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { tier } = req.body;
    const tenantId = req.tenantId;

    await execute(
      'UPDATE loyalty_points SET tier = ? WHERE id = ? AND tenant_id = ?',
      [tier, id, tenantId]
    );

    res.json({ success: true, message: 'Loyalty member updated' });
  } catch (error) {
    console.error('Update loyalty error:', error);
    res.status(500).json({ success: false, message: 'Failed to update loyalty member' });
  }
});

/**
 * Get transactions for a loyalty member
 */
router.get('/:id/transactions', async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;

    const transactions = await query(
      `SELECT lt.* FROM loyalty_transactions lt
       JOIN loyalty_points lp ON lt.loyalty_id = lp.id
       WHERE lt.loyalty_id = ? AND lp.tenant_id = ?
       ORDER BY lt.created_at DESC
       LIMIT 50`,
      [id, tenantId]
    );

    res.json({ success: true, data: transactions });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
  }
});

/**
 * Add a loyalty transaction (earn / redeem / adjust)
 */
router.post('/:id/transaction', async (req, res) => {
  try {
    const { id } = req.params;
    const { points, type, description } = req.body;
    const tenantId = req.tenantId;

    if (!points || !type) {
      return res.status(400).json({ success: false, message: 'Points and type are required' });
    }

    const parsedPoints = parseInt(points, 10);
    if (isNaN(parsedPoints) || parsedPoints <= 0) {
      return res.status(400).json({ success: false, message: 'Points must be a positive number' });
    }

    // Verify member exists
    const [member] = await query(
      'SELECT * FROM loyalty_points WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    if (!member) {
      return res.status(404).json({ success: false, message: 'Loyalty member not found' });
    }

    // For redemptions, check sufficient points
    if (type === 'redeemed' && member.current_points < parsedPoints) {
      return res.status(400).json({ success: false, message: 'Insufficient points for redemption' });
    }

    // Insert transaction
    await execute(
      `INSERT INTO loyalty_transactions (loyalty_id, type, points, description)
       VALUES (?, ?, ?, ?)`,
      [id, type, parsedPoints, description || null]
    );

    // Update points
    if (type === 'earned') {
      await execute(
        'UPDATE loyalty_points SET current_points = current_points + ?, total_earned = total_earned + ? WHERE id = ?',
        [parsedPoints, parsedPoints, id]
      );
    } else if (type === 'redeemed') {
      await execute(
        'UPDATE loyalty_points SET current_points = current_points - ? WHERE id = ?',
        [parsedPoints, id]
      );
    } else if (type === 'adjusted') {
      await execute(
        'UPDATE loyalty_points SET current_points = ? WHERE id = ?',
        [parsedPoints, id]
      );
    }

    // Auto-upgrade tier based on total earned
    const [updated] = await query('SELECT total_earned FROM loyalty_points WHERE id = ?', [id]);
    let newTier = 'bronze';
    if (updated.total_earned >= 10000) newTier = 'platinum';
    else if (updated.total_earned >= 5000) newTier = 'gold';
    else if (updated.total_earned >= 2000) newTier = 'silver';
    
    if (newTier !== member.tier) {
      await execute('UPDATE loyalty_points SET tier = ? WHERE id = ?', [newTier, id]);
    }

    res.json({ success: true, message: `Points ${type} successfully` });
  } catch (error) {
    console.error('Loyalty transaction error:', error);
    res.status(500).json({ success: false, message: 'Failed to process transaction' });
  }
});

export default router;
