import { config } from '../config.js';

// ─── Twilio Client (lazy-loaded) ──────────────────────────────────
let twilioClient = null;

function getTwilioClient() {
  if (twilioClient) return twilioClient;
  
  const { accountSid, authToken } = config.sms.twilio;
  
  if (!accountSid || !authToken) {
    console.warn('⚠️  Twilio not configured — no TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in .env');
    return null;
  }
  
  try {
    // Dynamic import to avoid requiring twilio if not configured
    const twilio = require('twilio');
    twilioClient = twilio(accountSid, authToken);
    return twilioClient;
  } catch (err) {
    console.warn('⚠️  Twilio package not installed. Run: npm install twilio');
    return null;
  }
}

/**
 * Send SMS via Twilio
 * @param {string} to - Phone number (E.164 format: +971501234567)
 * @param {string} message - SMS message body
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendViaTwilio(to, message) {
  const client = getTwilioClient();
  if (!client) {
    return { success: false, error: 'Twilio not configured' };
  }
  
  const { fromNumber } = config.sms.twilio;
  if (!fromNumber) {
    return { success: false, error: 'TWILIO_FROM_NUMBER not configured' };
  }
  
  try {
    const result = await client.messages.create({
      body: message,
      from: fromNumber,
      to: to,
    });
    
    console.log(`✅ SMS sent to ${to} (SID: ${result.sid})`);
    return { success: true, messageId: result.sid };
  } catch (err) {
    console.error(`❌ Failed to send SMS to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send SMS via local provider (HTTP API)
 * @param {string} to - Phone number
 * @param {string} message - SMS message body
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendViaLocal(to, message) {
  const { apiUrl, apiKey, fromNumber } = config.sms.local;
  
  if (!apiUrl || !apiKey) {
    return { success: false, error: 'Local SMS provider not configured' };
  }
  
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        to,
        message,
        from: fromNumber,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    console.log(`✅ SMS sent to ${to} via local provider`);
    return { success: true, messageId: data.id || data.messageId || 'local-' + Date.now() };
  } catch (err) {
    console.error(`❌ Failed to send SMS to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send SMS (main function - routes to appropriate provider)
 * 
 * @param {Object} opts
 * @param {string} opts.to - Phone number (E.164 format recommended: +971501234567)
 * @param {string} opts.message - SMS message body (max 1600 chars for Twilio)
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendSMS({ to, message }) {
  // Validate phone number format
  if (!to || !message) {
    return { success: false, error: 'Phone number and message are required' };
  }
  
  // Ensure phone number starts with +
  const normalizedTo = to.startsWith('+') ? to : `+${to}`;
  
  // Truncate message if too long (Twilio limit is 1600 chars)
  const truncatedMessage = message.length > 1600 ? message.substring(0, 1597) + '...' : message;
  
  const provider = config.sms.provider || 'twilio';
  
  if (provider === 'twilio') {
    return sendViaTwilio(normalizedTo, truncatedMessage);
  } else if (provider === 'local') {
    return sendViaLocal(normalizedTo, truncatedMessage);
  } else {
    console.warn(`⚠️  Unknown SMS provider: ${provider}. Using Twilio.`);
    return sendViaTwilio(normalizedTo, truncatedMessage);
  }
}

/**
 * Format phone number to E.164 format
 * @param {string} phone - Phone number in any format
 * @param {string} defaultCountryCode - Default country code (e.g., '971' for UAE)
 * @returns {string} - E.164 formatted number
 */
export function formatPhoneNumber(phone, defaultCountryCode = '971') {
  if (!phone) return '';
  
  // Remove all non-digit characters
  let digits = phone.replace(/\D/g, '');
  
  // If already starts with country code, add +
  if (digits.startsWith(defaultCountryCode)) {
    return `+${digits}`;
  }
  
  // If starts with 0, remove it and add country code
  if (digits.startsWith('0')) {
    digits = digits.substring(1);
  }
  
  // Add country code if not present
  if (!digits.startsWith(defaultCountryCode)) {
    digits = defaultCountryCode + digits;
  }
  
  return `+${digits}`;
}

export default { sendSMS, formatPhoneNumber };
