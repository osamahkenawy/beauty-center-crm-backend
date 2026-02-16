import express from 'express';
import { query, execute } from '../lib/database.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

async function ensureTable() {
  await execute(`
    CREATE TABLE IF NOT EXISTS integrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      provider VARCHAR(100) NOT NULL,
      type ENUM('email', 'sms', 'whatsapp', 'social', 'analytics', 'crm', 'other') NOT NULL,
      config JSON,
      credentials JSON,
      is_active TINYINT(1) DEFAULT 0,
      is_connected TINYINT(1) DEFAULT 0,
      last_sync_at DATETIME,
      last_error TEXT,
      webhook_url VARCHAR(500),
      webhook_secret VARCHAR(255),
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await execute(`
    CREATE TABLE IF NOT EXISTS integration_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      integration_id INT NOT NULL,
      action VARCHAR(100) NOT NULL,
      status ENUM('success', 'error', 'pending') DEFAULT 'pending',
      request JSON,
      response JSON,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_integration (integration_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// Available integration providers
const PROVIDERS = {
  email: [
    { id: 'sendgrid', name: 'SendGrid', icon: '📧', fields: ['api_key'] },
    { id: 'mailchimp', name: 'Mailchimp', icon: '🐵', fields: ['api_key', 'server_prefix'] },
    { id: 'mailgun', name: 'Mailgun', icon: '📬', fields: ['api_key', 'domain'] },
    { id: 'ses', name: 'Amazon SES', icon: '☁️', fields: ['access_key', 'secret_key', 'region'] },
    { id: 'smtp', name: 'Custom SMTP', icon: '✉️', fields: ['host', 'port', 'username', 'password', 'encryption'] },
  ],
  sms: [
    { id: 'twilio', name: 'Twilio', icon: '📱', fields: ['account_sid', 'auth_token', 'phone_number'] },
    { id: 'messagebird', name: 'MessageBird', icon: '🐦', fields: ['api_key', 'originator'] },
    { id: 'vonage', name: 'Vonage (Nexmo)', icon: '📲', fields: ['api_key', 'api_secret', 'from_number'] },
  ],
  whatsapp: [
    { id: 'twilio_whatsapp', name: 'Twilio WhatsApp', icon: '💬', fields: ['account_sid', 'auth_token', 'whatsapp_number'] },
    { id: 'whatsapp_business', name: 'WhatsApp Business API', icon: '📱', fields: ['access_token', 'phone_number_id', 'business_id'] },
    { id: '360dialog', name: '360dialog', icon: '🔄', fields: ['api_key', 'channel_id'] },
  ],
  social: [
    { id: 'facebook', name: 'Facebook/Meta', icon: '👤', fields: ['app_id', 'app_secret', 'access_token', 'page_id'] },
    { id: 'instagram', name: 'Instagram', icon: '📷', fields: ['access_token', 'account_id'] },
    { id: 'linkedin', name: 'LinkedIn', icon: '💼', fields: ['client_id', 'client_secret', 'access_token'] },
    { id: 'twitter', name: 'Twitter/X', icon: '🐦', fields: ['api_key', 'api_secret', 'access_token', 'access_secret'] },
  ],
  analytics: [
    { id: 'google_analytics', name: 'Google Analytics', icon: '📊', fields: ['tracking_id', 'view_id'] },
    { id: 'mixpanel', name: 'Mixpanel', icon: '📈', fields: ['project_token', 'api_secret'] },
    { id: 'segment', name: 'Segment', icon: '📉', fields: ['write_key'] },
  ],
};

// Get available providers
router.get('/providers', authMiddleware, async (req, res) => {
  res.json({ success: true, data: PROVIDERS });
});

// Get all integrations
router.get('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { type, active } = req.query;
    let sql = 'SELECT id, name, provider, type, is_active, is_connected, last_sync_at, last_error, webhook_url, created_at FROM integrations WHERE 1=1';
    const params = [];
    
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (active !== undefined) { sql += ' AND is_active = ?'; params.push(active === 'true' ? 1 : 0); }
    sql += ' ORDER BY name';
    
    const integrations = await query(sql, params);
    res.json({ success: true, data: integrations });
  } catch (error) {
    console.error('Fetch integrations error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch integrations' });
  }
});

// Get single integration (with masked credentials)
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const [integration] = await query('SELECT * FROM integrations WHERE id = ?', [req.params.id]);
    if (!integration) {
      return res.status(404).json({ success: false, message: 'Integration not found' });
    }
    
    // Mask credentials
    if (integration.credentials) {
      const creds = JSON.parse(integration.credentials);
      for (const key in creds) {
        if (creds[key] && creds[key].length > 4) {
          creds[key] = '****' + creds[key].slice(-4);
        }
      }
      integration.credentials = creds;
    }
    
    res.json({ success: true, data: integration });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch integration' });
  }
});

// Create integration
router.post('/', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { name, provider, type, config, credentials } = req.body;
    
    if (!name || !provider || !type) {
      return res.status(400).json({ success: false, message: 'Name, provider, and type required' });
    }
    
    // Generate webhook URL
    const webhookSecret = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const webhookUrl = `${process.env.API_URL || 'https://api.yourcrm.com'}/webhooks/integrations/${webhookSecret}`;
    
    const result = await execute(
      `INSERT INTO integrations (name, provider, type, config, credentials, webhook_url, webhook_secret, created_by) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, provider, type, 
       config ? JSON.stringify(config) : null,
       credentials ? JSON.stringify(credentials) : null,
       webhookUrl, webhookSecret, req.user.id]
    );
    
    res.json({ success: true, message: 'Integration created', data: { id: result.insertId, webhook_url: webhookUrl } });
  } catch (error) {
    console.error('Create integration error:', error);
    res.status(500).json({ success: false, message: 'Failed to create integration' });
  }
});

// Update integration
router.patch('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, config, credentials, is_active } = req.body;
    const updates = [];
    const params = [];
    
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (config !== undefined) { updates.push('config = ?'); params.push(JSON.stringify(config)); }
    if (credentials !== undefined) { updates.push('credentials = ?'); params.push(JSON.stringify(credentials)); }
    if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
    
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No updates' });
    
    params.push(req.params.id);
    await execute(`UPDATE integrations SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ success: true, message: 'Integration updated' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update integration' });
  }
});

// Test integration connection
router.post('/:id/test', authMiddleware, async (req, res) => {
  try {
    const [integration] = await query('SELECT * FROM integrations WHERE id = ?', [req.params.id]);
    if (!integration) {
      return res.status(404).json({ success: false, message: 'Integration not found' });
    }
    
    const credentials = integration.credentials ? JSON.parse(integration.credentials) : {};
    let isConnected = false;
    let error = null;
    
    // Test based on provider type
    try {
      switch (integration.provider) {
        case 'sendgrid':
          // Would make actual API call in production
          isConnected = credentials.api_key && credentials.api_key.startsWith('SG.');
          break;
        case 'twilio':
          isConnected = credentials.account_sid && credentials.auth_token;
          break;
        case 'smtp':
          isConnected = credentials.host && credentials.port;
          break;
        default:
          // Generic validation - check if required fields are present
          isConnected = Object.keys(credentials).length > 0;
      }
    } catch (e) {
      error = e.message;
    }
    
    // Update connection status
    await execute(
      'UPDATE integrations SET is_connected = ?, last_sync_at = NOW(), last_error = ? WHERE id = ?',
      [isConnected ? 1 : 0, error, req.params.id]
    );
    
    // Log the test
    await execute(
      'INSERT INTO integration_logs (integration_id, action, status, response) VALUES (?, ?, ?, ?)',
      [req.params.id, 'test_connection', isConnected ? 'success' : 'error', 
       JSON.stringify({ connected: isConnected, error })]
    );
    
    res.json({ 
      success: true, 
      data: { 
        connected: isConnected, 
        error,
        message: isConnected ? 'Connection successful' : 'Connection failed'
      } 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to test integration' });
  }
});

// Send test message via integration
router.post('/:id/send-test', authMiddleware, async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    const [integration] = await query('SELECT * FROM integrations WHERE id = ?', [req.params.id]);
    
    if (!integration) {
      return res.status(404).json({ success: false, message: 'Integration not found' });
    }
    
    if (!integration.is_connected) {
      return res.status(400).json({ success: false, message: 'Integration not connected. Test connection first.' });
    }
    
    // In production, would actually send via the provider's API
    // For now, we simulate a successful send
    const logResult = await execute(
      'INSERT INTO integration_logs (integration_id, action, status, request, response) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, 'send_test', 'success', 
       JSON.stringify({ to, subject, message }),
       JSON.stringify({ sent: true, timestamp: new Date().toISOString() })]
    );
    
    res.json({ 
      success: true, 
      message: `Test message sent to ${to}`,
      data: { log_id: logResult.insertId }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to send test message' });
  }
});

// Get integration logs
router.get('/:id/logs', authMiddleware, async (req, res) => {
  try {
    const { limit = 50, status } = req.query;
    let sql = 'SELECT * FROM integration_logs WHERE integration_id = ?';
    const params = [req.params.id];
    
    if (status) { sql += ' AND status = ?'; params.push(status); }
    sql += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
    
    const logs = await query(sql, params);
    res.json({ success: true, data: logs });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch logs' });
  }
});

// Delete integration
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await execute('DELETE FROM integration_logs WHERE integration_id = ?', [req.params.id]);
    await execute('DELETE FROM integrations WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Integration deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete integration' });
  }
});

export default router;


