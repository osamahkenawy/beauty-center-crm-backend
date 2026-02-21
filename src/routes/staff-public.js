import express from 'express';
import bcrypt from 'bcryptjs';
import { query, execute } from '../lib/database.js';

const router = express.Router();

// ─── Ensure all necessary columns exist ─────────────────
async function ensureSchema() {
  const cols = [
    { name: 'invite_token', sql: "ALTER TABLE staff ADD COLUMN invite_token VARCHAR(255) DEFAULT NULL" },
    { name: 'invite_token_expires', sql: "ALTER TABLE staff ADD COLUMN invite_token_expires DATETIME DEFAULT NULL" },
    { name: 'password_set', sql: "ALTER TABLE staff ADD COLUMN password_set TINYINT(1) DEFAULT 0" },
  ];
  for (const col of cols) {
    try { 
      await execute(col.sql); 
    } catch (e) { 
      /* column already exists */ 
    }
  }
}

// ═══════════════════════════════════════════════════════
// ─── Validate invite token (public) ───────────────────
// ═══════════════════════════════════════════════════════
router.get('/validate', async (req, res) => {
  try {
    await ensureSchema();
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ success: false, message: 'Token is required' });
    }

    const [staff] = await query(
      'SELECT id, full_name, email, invite_token_expires, password_set FROM staff WHERE invite_token = ?',
      [token]
    );

    if (!staff) {
      return res.status(400).json({ success: false, message: 'Invalid invite link' });
    }

    if (staff.password_set) {
      return res.status(400).json({ success: false, message: 'Password has already been set for this account' });
    }

    // Check expiration (handle timezone issues by comparing as strings)
    if (staff.invite_token_expires) {
      const expiresDate = new Date(staff.invite_token_expires);
      const now = new Date();
      // Add 1 minute buffer to account for clock differences
      if (expiresDate.getTime() < (now.getTime() - 60000)) {
        return res.status(400).json({ success: false, message: 'Invite link has expired. Please ask your admin to resend.' });
      }
    }

    res.json({ 
      success: true, 
      name: staff.full_name,
      email: staff.email
    });
  } catch (error) {
    console.error('Validate invite token error:', error);
    res.status(500).json({ success: false, message: 'Failed to validate invite link' });
  }
});

// ═══════════════════════════════════════════════════════
// ─── Set password via invite token (public) ────────────
// ═══════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  try {
    await ensureSchema();
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ success: false, message: 'Token and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    const [staff] = await query(
      'SELECT id, full_name, invite_token_expires FROM staff WHERE invite_token = ?',
      [token]
    );

    if (!staff) {
      return res.status(400).json({ success: false, message: 'Invalid or expired invite link' });
    }

    // Check expiration (handle timezone issues by comparing as strings)
    if (staff.invite_token_expires) {
      const expiresDate = new Date(staff.invite_token_expires);
      const now = new Date();
      // Add 1 minute buffer to account for clock differences
      if (expiresDate.getTime() < (now.getTime() - 60000)) {
        return res.status(400).json({ success: false, message: 'Invite link has expired. Please ask your admin to resend.' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await execute(
      'UPDATE staff SET password = ?, password_set = 1, invite_token = NULL, invite_token_expires = NULL WHERE id = ?',
      [hashedPassword, staff.id]
    );

    res.json({ success: true, message: 'Password set successfully! You can now log in.' });
  } catch (error) {
    console.error('Set password error:', error);
    res.status(500).json({ success: false, message: 'Failed to set password' });
  }
});

export default router;
