/**
 * ════════════════════════════════════════════════════════════════
 * Shared Notification Helper — pushes in-app notifications
 * from any module. Import and call from route handlers.
 * ════════════════════════════════════════════════════════════════
 */
import { execute } from './database.js';

// Ensure table exists (idempotent)
let _tableReady = false;
async function ensureTable() {
  if (_tableReady) return;
  try {
    await execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        user_id INT DEFAULT NULL,
        type VARCHAR(50) DEFAULT 'general',
        category VARCHAR(30) DEFAULT 'info',
        title VARCHAR(255) NOT NULL,
        message TEXT,
        data JSON,
        link VARCHAR(500) DEFAULT NULL,
        icon VARCHAR(50) DEFAULT NULL,
        is_read TINYINT(1) DEFAULT 0,
        is_archived TINYINT(1) DEFAULT 0,
        expires_at DATETIME DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_tenant (tenant_id),
        INDEX idx_user (user_id),
        INDEX idx_read (is_read),
        INDEX idx_type (type),
        INDEX idx_created (created_at)
      )
    `);
    // Migrate type column from ENUM to VARCHAR if needed
    try {
      const [col] = await execute(`SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'type'`);
      if (col && col.COLUMN_TYPE && col.COLUMN_TYPE.startsWith('enum')) {
        await execute(`ALTER TABLE notifications MODIFY COLUMN type VARCHAR(50) DEFAULT 'general'`);
      }
    } catch (_) { /* ignore */ }
    try {
      const [col2] = await execute(`SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'category'`);
      if (col2 && col2.COLUMN_TYPE && col2.COLUMN_TYPE.startsWith('enum')) {
        await execute(`ALTER TABLE notifications MODIFY COLUMN category VARCHAR(30) DEFAULT 'info'`);
      }
    } catch (_) { /* ignore */ }
    _tableReady = true;
  } catch (e) {
    console.error('notify ensureTable error:', e.message);
  }
}

/**
 * Push a notification to the in-app notification center.
 *
 * @param {Object} opts
 * @param {number} opts.tenantId  – required
 * @param {number|null} opts.userId  – null = broadcast to all staff
 * @param {string} opts.type     – appointment | invoice | payment | reminder | system | promotion | review | inventory | loyalty | gift_card | client | staff | pos | general
 * @param {string} opts.category – info | success | warning | error | reminder
 * @param {string} opts.title    – Notification title (required)
 * @param {string} opts.message  – Body text
 * @param {object} opts.data     – Arbitrary JSON payload
 * @param {string} opts.link     – Frontend route link
 * @param {string} opts.icon     – Icon name hint for frontend
 * @param {string} opts.expiresAt – ISO datetime or null
 */
export async function notify({
  tenantId,
  userId = null,
  type = 'general',
  category = 'info',
  title,
  message = '',
  data = null,
  link = null,
  icon = null,
  expiresAt = null,
}) {
  if (!tenantId || !title) return null;
  try {
    await ensureTable();
    const result = await execute(
      `INSERT INTO notifications (tenant_id, user_id, type, category, title, message, data, link, icon, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        userId,
        type,
        category,
        title,
        message,
        data ? JSON.stringify(data) : null,
        link,
        icon,
        expiresAt,
      ]
    );
    return result.insertId;
  } catch (error) {
    console.error('notify() error:', error.message);
    return null;
  }
}

// ── Convenience wrappers ──────────────────────────────────────

export const notifyAppointment = (tenantId, title, message, data = {}, link = '/appointments') =>
  notify({ tenantId, type: 'appointment', category: 'info', title, message, data, link, icon: 'calendar' });

export const notifyAppointmentCancelled = (tenantId, title, message, data = {}) =>
  notify({ tenantId, type: 'appointment', category: 'warning', title, message, data, link: '/appointments', icon: 'calendar' });

export const notifyInvoice = (tenantId, title, message, data = {}) =>
  notify({ tenantId, type: 'invoice', category: 'info', title, message, data, link: '/beauty-payments', icon: 'credit-card' });

export const notifyPayment = (tenantId, title, message, data = {}) =>
  notify({ tenantId, type: 'payment', category: 'success', title, message, data, link: '/beauty-payments', icon: 'credit-card' });

export const notifyClient = (tenantId, title, message, data = {}) =>
  notify({ tenantId, type: 'client', category: 'info', title, message, data, link: '/beauty-clients', icon: 'user' });

export const notifyStaff = (tenantId, title, message, data = {}) =>
  notify({ tenantId, type: 'staff', category: 'info', title, message, data, link: '/team', icon: 'user' });

export const notifyGiftCard = (tenantId, title, message, data = {}) =>
  notify({ tenantId, type: 'gift_card', category: 'info', title, message, data, link: '/gift-cards', icon: 'gift' });

export const notifyLoyalty = (tenantId, title, message, data = {}) =>
  notify({ tenantId, type: 'loyalty', category: 'info', title, message, data, link: '/loyalty', icon: 'heart' });

export const notifyInventory = (tenantId, title, message, data = {}) =>
  notify({ tenantId, type: 'inventory', category: 'warning', title, message, data, link: '/inventory', icon: 'package' });

export const notifyPOS = (tenantId, title, message, data = {}) =>
  notify({ tenantId, type: 'pos', category: 'success', title, message, data, link: '/pos', icon: 'credit-card' });

export const notifySystem = (tenantId, title, message, data = {}) =>
  notify({ tenantId, type: 'system', category: 'info', title, message, data, link: null, icon: 'info' });

export default notify;
