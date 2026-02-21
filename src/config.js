// Configuration - Copy to .env for production
export const config = {
  port: process.env.PORT || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  env: process.env.NODE_ENV || 'development',
  
  // Database
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'RootPassword123!',
    database: process.env.DB_NAME || 'trasealla_beauty_crm',
  },
  
  // JWT
  jwt: {
    secret: process.env.JWT_SECRET || 'trasealla_crm_secret_key_2024',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  
  // CORS
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  
  // Email (supports both EMAIL_* and SMTP_* env vars)
  smtp: {
    host: process.env.EMAIL_HOST || process.env.SMTP_HOST || 'smtp.office365.com',
    port: parseInt(process.env.EMAIL_PORT || process.env.SMTP_PORT || '587'),
    user: process.env.EMAIL_USER || process.env.SMTP_USER || '',
    pass: process.env.EMAIL_PASS || process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER || '',
    fromName: process.env.EMAIL_NAME || 'Trasealla Solutions',
    secure: (process.env.EMAIL_SECURE || 'false') === 'true',
    tls: (process.env.EMAIL_TLS || 'true') === 'true',
  },
  
  // OpenAI (for AI Chatbot)
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },
  
  // SMS (Twilio)
  sms: {
    provider: process.env.SMS_PROVIDER || 'twilio', // 'twilio' or 'local'
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      fromNumber: process.env.TWILIO_FROM_NUMBER || '',
    },
    // Local provider (for UAE, Saudi, etc.)
    local: {
      apiUrl: process.env.SMS_API_URL || '',
      apiKey: process.env.SMS_API_KEY || '',
      fromNumber: process.env.SMS_FROM_NUMBER || '',
    }
  }
};

