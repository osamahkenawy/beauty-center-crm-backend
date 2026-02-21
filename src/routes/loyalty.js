import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';
import { notifyLoyalty } from '../lib/notify.js';
import { sendNotificationEmail } from '../lib/email.js';

const router = express.Router();

router.use(authMiddleware);

// ── Default loyalty settings ──
const DEFAULT_LOYALTY_SETTINGS = {
  earn_rate: 1,           // Points earned per currency unit spent
  min_spend_to_earn: 0,   // Minimum invoice total to earn points
  points_rounding: 'floor', // floor | round | ceil
  auto_enroll: false,     // Auto-enroll customers on first purchase
  auto_earn_on_payment: true, // Auto-earn points when invoice is paid
  point_value: 0.01,      // Monetary value of 1 point (for redemption)
  max_redeem_percent: 50, // Max % of invoice that can be paid with points
  points_expiry_days: 0,  // 0 = never expire
  tiers: {
    bronze:   { min: 0,     multiplier: 1,   perks: 'Welcome to the program!' },
    silver:   { min: 2000,  multiplier: 1.25, perks: '10% off retail products' },
    gold:     { min: 5000,  multiplier: 1.5,  perks: '15% off + free birthday treatment' },
    platinum: { min: 10000, multiplier: 2,    perks: '20% off + VIP priority booking + free monthly treatment' },
  },
  birthday_bonus: 100,    // Bonus points on birthday
  referral_bonus: 200,    // Bonus points for referring a friend
  welcome_bonus: 50,      // Points given on enrollment
};

/**
 * Helper: get loyalty settings for a tenant
 */
async function getLoyaltySettings(tenantId) {
  const [tenant] = await query('SELECT settings FROM tenants WHERE id = ?', [tenantId]);
  if (!tenant) return { ...DEFAULT_LOYALTY_SETTINGS };
  
  let settings = {};
  try {
    settings = typeof tenant.settings === 'string' ? JSON.parse(tenant.settings) : (tenant.settings || {});
  } catch { settings = {}; }
  
  const loyalty = settings.loyalty || {};
  // Deep merge tiers
  const mergedTiers = { ...DEFAULT_LOYALTY_SETTINGS.tiers };
  if (loyalty.tiers) {
    for (const t of Object.keys(mergedTiers)) {
      if (loyalty.tiers[t]) {
        mergedTiers[t] = { ...mergedTiers[t], ...loyalty.tiers[t] };
      }
    }
  }
  return { ...DEFAULT_LOYALTY_SETTINGS, ...loyalty, tiers: mergedTiers };
}

// ═══════════════════════════════════════════════
// LOYALTY SETTINGS
// ═══════════════════════════════════════════════

/**
 * GET /settings — Get loyalty program settings
 */
router.get('/settings', async (req, res) => {
  try {
    const settings = await getLoyaltySettings(req.tenantId);
    res.json({ success: true, data: settings });
  } catch (error) {
    console.error('Get loyalty settings error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch settings' });
  }
});

/**
 * PUT /settings — Update loyalty program settings
 */
router.put('/settings', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const [tenant] = await query('SELECT settings FROM tenants WHERE id = ?', [tenantId]);
    
    let currentSettings = {};
    try {
      currentSettings = typeof tenant.settings === 'string' ? JSON.parse(tenant.settings) : (tenant.settings || {});
    } catch { currentSettings = {}; }
    
    // Merge new loyalty settings
    const currentLoyalty = currentSettings.loyalty || {};
    const newLoyalty = { ...currentLoyalty, ...req.body };
    
    // Handle nested tiers merge
    if (req.body.tiers) {
      const mergedTiers = { ...(currentLoyalty.tiers || DEFAULT_LOYALTY_SETTINGS.tiers) };
      for (const t of Object.keys(req.body.tiers)) {
        mergedTiers[t] = { ...(mergedTiers[t] || {}), ...req.body.tiers[t] };
      }
      newLoyalty.tiers = mergedTiers;
    }
    
    currentSettings.loyalty = newLoyalty;
    
    await execute('UPDATE tenants SET settings = ? WHERE id = ?', [JSON.stringify(currentSettings), tenantId]);
    
    const updatedSettings = await getLoyaltySettings(tenantId);
    res.json({ success: true, data: updatedSettings, message: 'Loyalty settings updated' });
  } catch (error) {
    console.error('Update loyalty settings error:', error);
    res.status(500).json({ success: false, message: 'Failed to update settings' });
  }
});

// ═══════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════

/**
 * GET /stats — Get loyalty program statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const members = await query('SELECT * FROM loyalty_points WHERE tenant_id = ?', [tenantId]);
    const totalMembers = members.length;
    const totalPoints = members.reduce((s, m) => s + (m.points || 0), 0);
    const totalEarned = members.reduce((s, m) => s + (m.total_earned || 0), 0);
    const totalRedeemed = members.reduce((s, m) => s + (m.total_redeemed || 0), 0);
    const goldPlus = members.filter(m => m.tier === 'gold' || m.tier === 'platinum').length;
    const tierBreakdown = {
      bronze: members.filter(m => m.tier === 'bronze').length,
      silver: members.filter(m => m.tier === 'silver').length,
      gold: members.filter(m => m.tier === 'gold').length,
      platinum: members.filter(m => m.tier === 'platinum').length,
    };
    
    // Recent activity: last 10 transactions across all members
    const recentActivity = await query(
      `SELECT lt.*, CONCAT(c.first_name, ' ', c.last_name) as customer_name
       FROM loyalty_transactions lt
       LEFT JOIN contacts c ON lt.customer_id = c.id AND c.tenant_id = lt.tenant_id
       WHERE lt.tenant_id = ?
       ORDER BY lt.created_at DESC
       LIMIT 10`,
      [tenantId]
    );
    
    // Points earned this month
    const [monthlyEarned] = await query(
      `SELECT COALESCE(SUM(points), 0) as earned
       FROM loyalty_transactions
       WHERE tenant_id = ? AND transaction_type = 'earn'
       AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
      [tenantId]
    );
    
    // Points redeemed this month
    const [monthlyRedeemed] = await query(
      `SELECT COALESCE(SUM(points), 0) as redeemed
       FROM loyalty_transactions
       WHERE tenant_id = ? AND transaction_type = 'redeem'
       AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
      [tenantId]
    );
    
    // New members this month
    const [newThisMonth] = await query(
      `SELECT COUNT(*) as count FROM loyalty_points
       WHERE tenant_id = ? AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')`,
      [tenantId]
    );
    
    res.json({
      success: true,
      data: {
        totalMembers, totalPoints, totalEarned, totalRedeemed, goldPlus, tierBreakdown,
        recentActivity,
        monthlyEarned: monthlyEarned.earned || 0,
        monthlyRedeemed: monthlyRedeemed.redeemed || 0,
        newThisMonth: newThisMonth.count || 0,
      }
    });
  } catch (error) {
    console.error('Get loyalty stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

// ═══════════════════════════════════════════════
// MEMBERS CRUD
// ═══════════════════════════════════════════════

/**
 * GET / — Get all loyalty members
 */
router.get('/', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const members = await query(
      `SELECT lp.id, lp.tenant_id, lp.customer_id,
              lp.points as current_points,
              lp.total_earned, lp.total_redeemed, lp.tier,
              lp.created_at, lp.updated_at,
              COALESCE(CONCAT(c.first_name, ' ', c.last_name), 'Deleted Client') as customer_name,
              c.email as customer_email, c.phone as customer_phone,
              (SELECT COUNT(*) FROM loyalty_transactions lt WHERE lt.customer_id = lp.customer_id AND lt.tenant_id = lp.tenant_id) as transaction_count,
              (SELECT lt2.created_at FROM loyalty_transactions lt2 WHERE lt2.customer_id = lp.customer_id AND lt2.tenant_id = lp.tenant_id ORDER BY lt2.created_at DESC LIMIT 1) as last_activity
       FROM loyalty_points lp
       LEFT JOIN contacts c ON lp.customer_id = c.id AND c.tenant_id = lp.tenant_id
       WHERE lp.tenant_id = ?
       ORDER BY lp.points DESC`,
      [tenantId]
    );
    res.json({ success: true, data: members });
  } catch (error) {
    console.error('Get loyalty members error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch loyalty members' });
  }
});

/**
 * POST / — Enroll a customer
 */
router.post('/', async (req, res) => {
  try {
    const { customer_id, tier, initial_points } = req.body;
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

    // Get loyalty settings for welcome bonus
    const loyaltySettings = await getLoyaltySettings(tenantId);
    const welcomeBonus = loyaltySettings.welcome_bonus || 0;
    const startPoints = (initial_points || 0) + welcomeBonus;

    const result = await execute(
      `INSERT INTO loyalty_points (tenant_id, customer_id, points, total_earned, total_redeemed, tier)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [tenantId, customer_id, startPoints, startPoints, tier || 'bronze']
    );

    // Log welcome bonus transaction if applicable
    if (welcomeBonus > 0) {
      await execute(
        `INSERT INTO loyalty_transactions (tenant_id, customer_id, points, transaction_type, description)
         VALUES (?, ?, ?, 'earn', 'Welcome bonus')`,
        [tenantId, customer_id, welcomeBonus]
      );
    }

    // Push notification
    notifyLoyalty(tenantId, 'New Loyalty Member Enrolled', `${welcomeBonus > 0 ? `+${welcomeBonus} welcome bonus points` : 'Tier: ' + (tier || 'bronze')}`, { member_id: result.insertId, customer_id }).catch(() => {});

    // Send welcome email
    try {
      const [customer] = await query('SELECT email, first_name, last_name FROM contacts WHERE id = ?', [customer_id]);
      if (customer && customer.email) {
        const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Valued Member';
        const tierName = (tier || 'bronze').charAt(0).toUpperCase() + (tier || 'bronze').slice(1);
        const tierInfo = loyaltySettings.tiers?.[tier || 'bronze'] || {};
        
        await sendNotificationEmail({
          to: customer.email,
          subject: `🎉 Welcome to Our Loyalty Program!`,
          title: `Welcome to Our Loyalty Program! 🎉`,
          body: `
            <p>Dear ${customerName},</p>
            <p>Congratulations! You've been enrolled in our loyalty program.</p>
            ${welcomeBonus > 0 ? `<p><strong>🎁 Welcome Bonus:</strong> You've received ${welcomeBonus} bonus points to get you started!</p>` : ''}
            <p><strong>Your Tier:</strong> ${tierName}${tierInfo.perks ? ` — ${tierInfo.perks}` : ''}</p>
            <p><strong>Current Points:</strong> ${startPoints}</p>
            <p>Start earning points with every purchase and unlock exclusive rewards!</p>
            <ul>
              <li>Earn points on every purchase</li>
              <li>Redeem points for discounts</li>
              <li>Unlock higher tiers for better rewards</li>
            </ul>
            <p>Thank you for being a valued member!</p>
          `,
          tenantId,
        }).catch(err => console.error('Failed to send loyalty welcome email:', err.message));
      }
    } catch (emailErr) {
      console.error('Error sending loyalty welcome email:', emailErr);
    }

    res.json({ 
      success: true, 
      data: { id: result.insertId }, 
      message: `Customer enrolled successfully${welcomeBonus > 0 ? ` with ${welcomeBonus} welcome bonus points!` : ''}` 
    });
  } catch (error) {
    console.error('Enroll loyalty error:', error);
    res.status(500).json({ success: false, message: 'Failed to enroll customer' });
  }
});

// ═══════════════════════════════════════════════
// POINTS CALCULATOR (must be before /:id routes)
// ═══════════════════════════════════════════════

/**
 * POST /calculate — Calculate points for a given spend amount
 */
router.post('/calculate', async (req, res) => {
  try {
    const { amount, customer_id } = req.body;
    const tenantId = req.tenantId;
    const settings = await getLoyaltySettings(tenantId);
    
    let tier = 'bronze';
    let multiplier = 1;
    
    if (customer_id) {
      const [member] = await query(
        'SELECT tier FROM loyalty_points WHERE tenant_id = ? AND customer_id = ?',
        [tenantId, customer_id]
      );
      if (member) {
        tier = member.tier;
        multiplier = settings.tiers?.[tier]?.multiplier || 1;
      }
    }
    
    const basePoints = Math.floor((amount || 0) * (settings.earn_rate || 1));
    const bonusPoints = Math.floor(basePoints * multiplier) - basePoints;
    const totalPoints = basePoints + bonusPoints;
    const redemptionValue = totalPoints * (settings.point_value || 0.01);
    
    res.json({
      success: true,
      data: {
        amount,
        earn_rate: settings.earn_rate,
        tier,
        multiplier,
        base_points: basePoints,
        bonus_points: bonusPoints,
        total_points: totalPoints,
        redemption_value: redemptionValue,
        point_value: settings.point_value,
      }
    });
  } catch (error) {
    console.error('Points calculation error:', error);
    res.status(500).json({ success: false, message: 'Failed to calculate points' });
  }
});

/**
 * PATCH /:id — Update member (tier, etc.)
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
 * DELETE /:id — Remove member from loyalty program
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;

    // Get member info first
    const [member] = await query(
      'SELECT * FROM loyalty_points WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    if (!member) {
      return res.status(404).json({ success: false, message: 'Loyalty member not found' });
    }

    // Delete transactions
    await execute(
      'DELETE FROM loyalty_transactions WHERE tenant_id = ? AND customer_id = ?',
      [tenantId, member.customer_id]
    );

    // Delete member
    await execute(
      'DELETE FROM loyalty_points WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );

    res.json({ success: true, message: 'Member removed from loyalty program' });
  } catch (error) {
    console.error('Delete loyalty member error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove member' });
  }
});

// ═══════════════════════════════════════════════
// TRANSACTIONS (static routes FIRST)
// ═══════════════════════════════════════════════

/**
 * GET /activity/recent — Get recent activity across all members
 * NOTE: Must be before /:id routes to avoid "activity" being treated as :id
 */
router.get('/activity/recent', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const limit = parseInt(req.query.limit) || 20;
    
    const activity = await query(
      `SELECT lt.*, 
              CONCAT(c.first_name, ' ', c.last_name) as customer_name,
              c.email as customer_email
       FROM loyalty_transactions lt
       LEFT JOIN contacts c ON lt.customer_id = c.id AND c.tenant_id = lt.tenant_id
       WHERE lt.tenant_id = ?
       ORDER BY lt.created_at DESC
       LIMIT ${limit}`,
      [tenantId]
    );
    
    res.json({ success: true, data: activity });
  } catch (error) {
    console.error('Get recent activity error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch activity' });
  }
});

/**
 * GET /:id/transactions — Get transaction history for a member
 */
router.get('/:id/transactions', async (req, res) => {
  try {
    const { id } = req.params;
    const tenantId = req.tenantId;

    const [member] = await query(
      'SELECT * FROM loyalty_points WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    if (!member) {
      return res.status(404).json({ success: false, message: 'Loyalty member not found' });
    }

    const transactions = await query(
      `SELECT * FROM loyalty_transactions 
       WHERE tenant_id = ? AND customer_id = ?
       ORDER BY created_at DESC
       LIMIT 50`,
      [tenantId, member.customer_id]
    );

    res.json({ success: true, data: transactions });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
  }
});

/**
 * POST /:id/transaction — Add a loyalty transaction
 */
router.post('/:id/transaction', async (req, res) => {
  try {
    const { id } = req.params;
    const { points, type, description, reference_type, reference_id } = req.body;
    const tenantId = req.tenantId;

    if (!points || !type) {
      return res.status(400).json({ success: false, message: 'Points and type are required' });
    }

    // Normalize type: accept both 'earn'/'earned', 'redeem'/'redeemed'
    const typeMap = { earned: 'earn', redeemed: 'redeem', adjusted: 'adjust', expired: 'expire' };
    const normalizedType = typeMap[type] || type;

    const validTypes = ['earn', 'redeem', 'expire', 'adjust'];
    if (!validTypes.includes(normalizedType)) {
      return res.status(400).json({ success: false, message: `Type must be one of: ${validTypes.join(', ')}` });
    }

    const parsedPoints = parseInt(points, 10);
    if (isNaN(parsedPoints) || parsedPoints <= 0) {
      return res.status(400).json({ success: false, message: 'Points must be a positive number' });
    }

    const [member] = await query(
      'SELECT * FROM loyalty_points WHERE id = ? AND tenant_id = ?',
      [id, tenantId]
    );
    if (!member) {
      return res.status(404).json({ success: false, message: 'Loyalty member not found' });
    }

    // For redemptions, check sufficient points
    if (normalizedType === 'redeem' && member.points < parsedPoints) {
      return res.status(400).json({ success: false, message: `Insufficient points. Available: ${member.points}, requested: ${parsedPoints}` });
    }

    // Get loyalty settings for tier multiplier
    const loyaltySettings = await getLoyaltySettings(tenantId);
    let effectivePoints = parsedPoints;
    
    // Apply tier multiplier for earning
    if (normalizedType === 'earn' && reference_type === 'invoice') {
      const multiplier = loyaltySettings.tiers?.[member.tier]?.multiplier || 1;
      effectivePoints = Math.floor(parsedPoints * multiplier);
    }

    // Insert transaction
    await execute(
      `INSERT INTO loyalty_transactions (tenant_id, customer_id, points, transaction_type, description, reference_type, reference_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, member.customer_id, effectivePoints, normalizedType, description || null, reference_type || null, reference_id || null]
    );

    // Update points
    if (normalizedType === 'earn') {
      await execute(
        'UPDATE loyalty_points SET points = points + ?, total_earned = total_earned + ? WHERE id = ?',
        [effectivePoints, effectivePoints, id]
      );
    } else if (normalizedType === 'redeem') {
      await execute(
        'UPDATE loyalty_points SET points = points - ?, total_redeemed = total_redeemed + ? WHERE id = ?',
        [effectivePoints, effectivePoints, id]
      );
    } else if (normalizedType === 'adjust') {
      await execute(
        'UPDATE loyalty_points SET points = ? WHERE id = ?',
        [effectivePoints, id]
      );
    } else if (normalizedType === 'expire') {
      await execute(
        'UPDATE loyalty_points SET points = points - ? WHERE id = ?',
        [effectivePoints, id]
      );
    }

    // Auto-upgrade tier based on total earned
    const [updated] = await query('SELECT total_earned FROM loyalty_points WHERE id = ?', [id]);
    const tiers = loyaltySettings.tiers || DEFAULT_LOYALTY_SETTINGS.tiers;
    let newTier = 'bronze';
    if (updated.total_earned >= tiers.platinum.min) newTier = 'platinum';
    else if (updated.total_earned >= tiers.gold.min) newTier = 'gold';
    else if (updated.total_earned >= tiers.silver.min) newTier = 'silver';
    
    const tierChanged = newTier !== member.tier;
    if (tierChanged) {
      await execute('UPDATE loyalty_points SET tier = ? WHERE id = ?', [newTier, id]);
    }

    // Get updated member
    const [updatedMember] = await query(
      'SELECT points as current_points, total_earned, total_redeemed, tier FROM loyalty_points WHERE id = ?',
      [id]
    );

    let message = '';
    if (normalizedType === 'earn') message = `${effectivePoints} points earned`;
    else if (normalizedType === 'redeem') message = `${effectivePoints} points redeemed`;
    else if (normalizedType === 'adjust') message = `Points adjusted to ${effectivePoints}`;
    else message = `${effectivePoints} points expired`;
    
    if (tierChanged) message += ` 🎉 Tier upgraded to ${newTier}!`;

    // Push notification for tier upgrade or significant point events
    if (tierChanged) {
      notifyLoyalty(req.tenantId, `Tier Upgrade — ${newTier.charAt(0).toUpperCase() + newTier.slice(1)}`, message, { member_id: id, new_tier: newTier }).catch(() => {});
    }

    res.json({ 
      success: true, 
      message,
      data: updatedMember
    });
  } catch (error) {
    console.error('Loyalty transaction error:', error);
    res.status(500).json({ success: false, message: 'Failed to process transaction' });
  }
});

// ═══════════════════════════════════════════════
// AUTO-EARN HOOK (called from invoices route)
// ═══════════════════════════════════════════════

/**
 * Process auto-earn when an invoice is paid.
 * This is exported and called from the invoices route.
 */
export async function processAutoEarn(tenantId, customerId, invoiceTotal, invoiceId) {
  try {
    const settings = await getLoyaltySettings(tenantId);
    
    if (!settings.auto_earn_on_payment) return null;
    if (invoiceTotal < (settings.min_spend_to_earn || 0)) return null;
    
    // Check if customer is enrolled
    const [member] = await query(
      'SELECT * FROM loyalty_points WHERE tenant_id = ? AND customer_id = ?',
      [tenantId, customerId]
    );
    
    // Auto-enroll if enabled and not yet enrolled
    let memberId;
    if (!member) {
      if (!settings.auto_enroll) return null;
      
      const result = await execute(
        `INSERT INTO loyalty_points (tenant_id, customer_id, points, total_earned, total_redeemed, tier)
         VALUES (?, ?, 0, 0, 0, 'bronze')`,
        [tenantId, customerId]
      );
      memberId = result.insertId;
      
      // Welcome bonus
      if (settings.welcome_bonus > 0) {
        await execute(
          `INSERT INTO loyalty_transactions (tenant_id, customer_id, points, transaction_type, description)
           VALUES (?, ?, ?, 'earn', 'Welcome bonus - auto-enrolled')`,
          [tenantId, customerId, settings.welcome_bonus]
        );
        await execute(
          'UPDATE loyalty_points SET points = points + ?, total_earned = total_earned + ? WHERE id = ?',
          [settings.welcome_bonus, settings.welcome_bonus, memberId]
        );
      }
    } else {
      memberId = member.id;
    }
    
    // Check for duplicate: don't double-earn for same invoice
    const existingTxn = await query(
      `SELECT id FROM loyalty_transactions WHERE tenant_id = ? AND customer_id = ? AND reference_type = 'invoice' AND reference_id = ?`,
      [tenantId, customerId, invoiceId]
    );
    if (existingTxn.length > 0) return null; // Already earned for this invoice
    
    // Calculate points
    const currentMember = member || (await query('SELECT * FROM loyalty_points WHERE id = ?', [memberId]))[0];
    const tier = currentMember?.tier || 'bronze';
    const multiplier = settings.tiers?.[tier]?.multiplier || 1;
    const earnRate = settings.earn_rate || 1;
    
    let basePoints;
    if (settings.points_rounding === 'ceil') {
      basePoints = Math.ceil(invoiceTotal * earnRate);
    } else if (settings.points_rounding === 'round') {
      basePoints = Math.round(invoiceTotal * earnRate);
    } else {
      basePoints = Math.floor(invoiceTotal * earnRate);
    }
    
    const totalPoints = Math.floor(basePoints * multiplier);
    
    if (totalPoints <= 0) return null;
    
    // Record transaction
    await execute(
      `INSERT INTO loyalty_transactions (tenant_id, customer_id, points, transaction_type, description, reference_type, reference_id)
       VALUES (?, ?, ?, 'earn', ?, 'invoice', ?)`,
      [tenantId, customerId, totalPoints, `Payment of ${invoiceTotal} (${multiplier > 1 ? tier + ' ' + multiplier + 'x' : 'standard'})`, invoiceId]
    );
    
    // Update points
    await execute(
      'UPDATE loyalty_points SET points = points + ?, total_earned = total_earned + ? WHERE id = ?',
      [totalPoints, totalPoints, memberId]
    );
    
    // Auto-upgrade tier
    const [updatedMember] = await query('SELECT total_earned, tier FROM loyalty_points WHERE id = ?', [memberId]);
    const tiers = settings.tiers || DEFAULT_LOYALTY_SETTINGS.tiers;
    let newTier = 'bronze';
    if (updatedMember.total_earned >= tiers.platinum.min) newTier = 'platinum';
    else if (updatedMember.total_earned >= tiers.gold.min) newTier = 'gold';
    else if (updatedMember.total_earned >= tiers.silver.min) newTier = 'silver';
    
    const tierUpgraded = newTier !== updatedMember.tier;
    if (tierUpgraded) {
      await execute('UPDATE loyalty_points SET tier = ? WHERE id = ?', [newTier, memberId]);
      
      // Send tier upgrade email
      try {
        const [customer] = await query('SELECT email, first_name, last_name FROM contacts WHERE id = ?', [customerId]);
        if (customer && customer.email) {
          const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Valued Member';
          const tierName = newTier.charAt(0).toUpperCase() + newTier.slice(1);
          const tierInfo = tiers[newTier] || {};
          
          await sendNotificationEmail({
            to: customer.email,
            subject: `🎉 Tier Upgrade! You're Now ${tierName}!`,
            title: `Congratulations! You've Upgraded to ${tierName} Tier! 🎉`,
            body: `
              <p>Dear ${customerName},</p>
              <p>Congratulations! You've been upgraded to <strong>${tierName} Tier</strong>!</p>
              <p><strong>Your New Benefits:</strong></p>
              <ul>
                <li>${tierInfo.perks || 'Exclusive perks and rewards'}</li>
                <li>${tierInfo.multiplier || 1}x points multiplier on all purchases</li>
                <li>Priority booking and special offers</li>
              </ul>
              <p>Keep earning points to unlock even more rewards!</p>
              <p>Thank you for your continued loyalty!</p>
            `,
            tenantId,
          }).catch(err => console.error('Failed to send tier upgrade email:', err.message));
        }
      } catch (emailErr) {
        console.error('Error sending tier upgrade email:', emailErr);
      }
    }
    
    // Send points earned email (if significant amount)
    if (totalPoints >= 100) {
      try {
        const [customer] = await query('SELECT email, first_name, last_name FROM contacts WHERE id = ?', [customerId]);
        if (customer && customer.email) {
          const customerName = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Valued Member';
          const [currentPoints] = await query('SELECT points FROM loyalty_points WHERE id = ?', [memberId]);
          
          await sendNotificationEmail({
            to: customer.email,
            subject: `🎁 You Earned ${totalPoints} Loyalty Points!`,
            title: `You've Earned ${totalPoints} Points! 🎁`,
            body: `
              <p>Dear ${customerName},</p>
              <p>Great news! You've earned <strong>${totalPoints} loyalty points</strong> from your recent purchase!</p>
              <p><strong>Your Current Balance:</strong> ${currentPoints?.points || 0} points</p>
              <p>You can redeem these points for discounts on your next visit. Keep earning to unlock higher tiers and exclusive rewards!</p>
              <p>Thank you for your loyalty!</p>
            `,
            tenantId,
          }).catch(err => console.error('Failed to send points earned email:', err.message));
        }
      } catch (emailErr) {
        console.error('Error sending points earned email:', emailErr);
      }
    }
    
    return { points_earned: totalPoints, new_tier: tierUpgraded ? newTier : null };
  } catch (error) {
    console.error('Auto-earn loyalty points error:', error);
    return null;
  }
}

/**
 * GET /check/:customerId — Check customer's loyalty balance + point value
 */
router.get('/check/:customerId', async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const customerId = req.params.customerId;

    const [member] = await query(
      'SELECT lp.*, CONCAT(c.first_name, " ", c.last_name) as customer_name FROM loyalty_points lp LEFT JOIN contacts c ON lp.customer_id = c.id AND c.tenant_id = lp.tenant_id WHERE lp.tenant_id = ? AND lp.customer_id = ?',
      [tenantId, customerId]
    );

    if (!member) {
      return res.json({ success: true, data: { enrolled: false, points: 0, monetary_value: 0, point_value: 0 } });
    }

    const settings = await getLoyaltySettings(tenantId);
    const pointValue = settings.point_value || 0.01;
    const maxRedeemPercent = settings.max_redeem_percent || 50;

    res.json({
      success: true,
      data: {
        enrolled: true,
        points: member.points || 0,
        tier: member.tier,
        point_value: pointValue,
        monetary_value: parseFloat(((member.points || 0) * pointValue).toFixed(2)),
        max_redeem_percent: maxRedeemPercent,
        customer_name: member.customer_name
      }
    });
  } catch (error) {
    console.error('Check loyalty balance error:', error);
    res.status(500).json({ success: false, message: 'Failed to check loyalty balance' });
  }
});

/**
 * Redeem loyalty points for an invoice payment.
 * Called from invoices route when payment_method = 'loyalty_points'.
 * @param {number} tenantId
 * @param {number} customerId
 * @param {number} monetaryAmount - The monetary value to pay
 * @param {number} invoiceId
 * @returns {{ success: boolean, message: string, points_redeemed?: number, monetary_value?: number }}
 */
export async function redeemLoyaltyForPayment(tenantId, customerId, monetaryAmount, invoiceId) {
  try {
    const settings = await getLoyaltySettings(tenantId);
    const pointValue = settings.point_value || 0.01; // e.g. 1 point = 0.01 AED

    // Get member
    const [member] = await query(
      'SELECT * FROM loyalty_points WHERE tenant_id = ? AND customer_id = ?',
      [tenantId, customerId]
    );
    if (!member) {
      return { success: false, message: 'Customer is not enrolled in the loyalty program' };
    }

    // Calculate points needed for this monetary amount
    const pointsNeeded = Math.ceil(monetaryAmount / pointValue);

    if (member.points < pointsNeeded) {
      const maxMonetary = (member.points * pointValue).toFixed(2);
      return { 
        success: false, 
        message: `Insufficient points. Available: ${member.points} pts (worth ${maxMonetary}). Needed: ${pointsNeeded} pts.` 
      };
    }

    // Check max_redeem_percent against invoice total
    // (handled at the frontend/caller level, but add safety here)

    // Deduct points
    await execute(
      'UPDATE loyalty_points SET points = points - ?, total_redeemed = total_redeemed + ? WHERE id = ?',
      [pointsNeeded, pointsNeeded, member.id]
    );

    // Record transaction
    await execute(
      `INSERT INTO loyalty_transactions (tenant_id, customer_id, points, transaction_type, description, reference_type, reference_id)
       VALUES (?, ?, ?, 'redeem', ?, 'invoice', ?)`,
      [tenantId, customerId, pointsNeeded, `Redeemed ${pointsNeeded} pts for payment of ${monetaryAmount}`, invoiceId]
    );

    return {
      success: true,
      message: `${pointsNeeded} points redeemed (worth ${monetaryAmount})`,
      points_redeemed: pointsNeeded,
      monetary_value: monetaryAmount
    };
  } catch (error) {
    console.error('Loyalty redemption error:', error);
    return { success: false, message: 'Failed to redeem loyalty points' };
  }
}

export default router;
