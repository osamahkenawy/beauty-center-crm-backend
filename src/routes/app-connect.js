import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// ── Ensure table exists ──────────────────────────────────────────────────────
async function ensureTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS app_connect (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id        INT NOT NULL UNIQUE,
      listing_status   ENUM('draft','live','paused') DEFAULT 'draft',
      listing_tier     ENUM('basic','pro','featured') DEFAULT 'basic',
      slug             VARCHAR(100),
      display_name     VARCHAR(255),
      tagline          VARCHAR(255),
      description      TEXT,
      cover_image      VARCHAR(500),
      gallery          JSON,
      amenities        JSON,
      spoken_languages JSON,
      highlight_tags   JSON,
      latitude         DECIMAL(10,8),
      longitude        DECIMAL(11,8),
      map_address      TEXT,
      instagram        VARCHAR(255),
      facebook         VARCHAR(255),
      tiktok           VARCHAR(255),
      website          VARCHAR(255),
      booking_mode     ENUM('auto','manual') DEFAULT 'auto',
      min_notice_hours INT DEFAULT 2,
      max_future_days  INT DEFAULT 30,
      deposit_pct      TINYINT DEFAULT 0,
      cancellation_policy TEXT,
      show_prices      TINYINT(1) DEFAULT 1,
      show_staff       TINYINT(1) DEFAULT 1,
      app_views        INT DEFAULT 0,
      app_bookings     INT DEFAULT 0,
      avg_rating       DECIMAL(3,2) DEFAULT 0.00,
      created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_status (listing_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  
  // Add facebook column if it doesn't exist (for existing tables)
  try {
    await execute(`ALTER TABLE app_connect ADD COLUMN facebook VARCHAR(255) AFTER instagram`);
  } catch (e) {
    // Column already exists, ignore
    if (!e.message.includes('Duplicate column name')) {
      console.warn('Could not add facebook column:', e.message);
    }
  }
}

// ── GET /app-connect — fetch current settings ─────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const [row] = await query(
      'SELECT * FROM app_connect WHERE tenant_id = ?',
      [req.user.tenant_id]
    );

    // Fetch completeness signals from other tables
    const [tenant]   = await query('SELECT name, logo_url, phone, email, address FROM tenants WHERE id = ?', [req.user.tenant_id]);
    const [branch]   = await query('SELECT id, latitude, longitude, cover_image FROM branches WHERE tenant_id = ? AND is_active = 1 LIMIT 1', [req.user.tenant_id]);
    const [svcCount] = await query('SELECT COUNT(*) AS cnt FROM products WHERE tenant_id = ? AND is_active = 1', [req.user.tenant_id]);
    const [staffCnt] = await query('SELECT COUNT(*) AS cnt FROM staff WHERE tenant_id = ? AND is_active = 1 AND role NOT IN ("admin","super_admin")', [req.user.tenant_id]);
    const [hourRow]  = await query('SELECT working_hours FROM branches WHERE tenant_id = ? AND is_active = 1 LIMIT 1', [req.user.tenant_id]);

    const completeness = {
      has_logo:           !!tenant?.logo_url,
      has_cover:          !!(row?.cover_image || branch?.cover_image),
      has_description:    !!(row?.description && row.description.length > 20),
      has_location:       !!(row?.latitude || branch?.latitude),
      has_services:       (svcCount?.cnt || 0) >= 3,
      has_staff:          (staffCnt?.cnt || 0) >= 1,
      has_working_hours:  !!(hourRow?.working_hours),
      has_phone:          !!tenant?.phone,
    };

    const score = Math.round(
      (Object.values(completeness).filter(Boolean).length / Object.keys(completeness).length) * 100
    );

    // Parse JSON fields safely
    const parseJson = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };

    const settings = row ? {
      ...row,
      gallery:          parseJson(row.gallery)          || [],
      amenities:        parseJson(row.amenities)        || [],
      spoken_languages: parseJson(row.spoken_languages) || [],
      highlight_tags:   parseJson(row.highlight_tags)   || [],
    } : {
      listing_status: 'draft', listing_tier: 'basic',
      slug: tenant?.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || '',
      display_name: tenant?.name || '', booking_mode: 'auto',
      min_notice_hours: 2, max_future_days: 30, deposit_pct: 0,
      show_prices: true, show_staff: true,
      gallery: [], amenities: [], spoken_languages: [], highlight_tags: [],
    };

    res.json({ success: true, data: settings, completeness, score });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /app-connect — save settings ─────────────────────────────────────────
router.put('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const tid = req.user.tenant_id;
    const {
      listing_status, listing_tier, slug, display_name, tagline, description,
      cover_image, gallery, amenities, spoken_languages, highlight_tags,
      latitude, longitude, map_address, instagram, facebook, tiktok, website,
      booking_mode, min_notice_hours, max_future_days, deposit_pct,
      cancellation_policy, show_prices, show_staff,
    } = req.body;

    // Validate live transition — must have score >= 60
    if (listing_status === 'live') {
      const [row]      = await query('SELECT description, cover_image FROM app_connect WHERE tenant_id = ?', [tid]);
      const [tenant]   = await query('SELECT logo_url, phone FROM tenants WHERE id = ?', [tid]);
      const [svcCount] = await query('SELECT COUNT(*) AS cnt FROM products WHERE tenant_id = ? AND is_active = 1', [tid]);
      if (!tenant?.logo_url && !tenant?.phone && !(svcCount?.cnt >= 1)) {
        return res.status(400).json({ success: false, message: 'Complete your profile before going live.' });
      }
    }

    const [existing] = await query('SELECT id FROM app_connect WHERE tenant_id = ?', [tid]);

    // All optional fields must be null (not undefined) for MySQL
    const fields = {
      listing_status:   listing_status   ?? 'draft',
      listing_tier:     listing_tier     ?? 'basic',
      slug:             slug             ?? null,
      display_name:     display_name     ?? null,
      tagline:          tagline          ?? null,
      description:      description      ?? null,
      cover_image:      cover_image      ?? null,
      latitude:         latitude         ?? null,
      longitude:        longitude        ?? null,
      map_address:      map_address      ?? null,
      instagram:        instagram        ?? null,
      facebook:         facebook         ?? null,
      tiktok:           tiktok           ?? null,
      website:          website          ?? null,
      booking_mode:     booking_mode     ?? 'auto',
      min_notice_hours: min_notice_hours ?? 2,
      max_future_days:  max_future_days  ?? 30,
      deposit_pct:      deposit_pct      ?? 0,
      cancellation_policy: cancellation_policy ?? null,
      show_prices: show_prices ? 1 : 0,
      show_staff:  show_staff  ? 1 : 0,
      gallery:          JSON.stringify(Array.isArray(gallery)          ? gallery          : []),
      amenities:        JSON.stringify(Array.isArray(amenities)        ? amenities        : []),
      spoken_languages: JSON.stringify(Array.isArray(spoken_languages) ? spoken_languages : []),
      highlight_tags:   JSON.stringify(Array.isArray(highlight_tags)   ? highlight_tags   : []),
    };

    if (existing) {
      const sets  = Object.keys(fields).map(k => `${k} = ?`).join(', ');
      await execute(`UPDATE app_connect SET ${sets} WHERE tenant_id = ?`, [...Object.values(fields), tid]);
    } else {
      const cols  = Object.keys(fields).join(', ');
      const vals  = Object.keys(fields).map(() => '?').join(', ');
      await execute(`INSERT INTO app_connect (tenant_id, ${cols}) VALUES (?, ${vals})`, [tid, ...Object.values(fields)]);
    }

    res.json({ success: true, message: 'Settings saved.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PATCH /app-connect/status — quick toggle live/paused ─────────────────────
router.patch('/status', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { status } = req.body;
    if (!['draft','live','paused'].includes(status))
      return res.status(400).json({ success: false, message: 'Invalid status' });

    const [existing] = await query('SELECT id FROM app_connect WHERE tenant_id = ?', [req.user.tenant_id]);
    if (existing) {
      await execute('UPDATE app_connect SET listing_status = ? WHERE tenant_id = ?', [status, req.user.tenant_id]);
    } else {
      await execute('INSERT INTO app_connect (tenant_id, listing_status) VALUES (?, ?)', [req.user.tenant_id, status]);
    }
    res.json({ success: true, status });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

export default router;
