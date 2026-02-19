import mysql from 'mysql2/promise';
import { config } from '../config.js';

// Custom date type casting to avoid timezone issues
// DATE → plain string 'YYYY-MM-DD'
// DATETIME/TIMESTAMP → proper ISO-8601 UTC string 'YYYY-MM-DDTHH:mm:ssZ'
//   so the frontend's `new Date(val)` always interprets as UTC
const typeCast = function(field, next) {
  if (field.type === 'DATE') {
    const value = field.string();
    return value; // Return as string 'YYYY-MM-DD'
  }
  if (field.type === 'DATETIME' || field.type === 'TIMESTAMP') {
    const value = field.string();
    if (!value) return value;
    // MySQL stores as 'YYYY-MM-DD HH:mm:ss' — convert to ISO UTC
    return value.replace(' ', 'T') + 'Z';
  }
  return next();
};

// Create connection pool
const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  typeCast: typeCast, // Use custom type casting for dates
});

// Query helper
export async function query(sql, params = []) {
  const [results] = await pool.execute(sql, params);
  return results;
}

// Execute helper (for INSERT, UPDATE, DELETE)
export async function execute(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return result;
}

// Initialize database and tables
export async function initDatabase() {
  try {
    // Create database if not exists
    const tempPool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
    });
    
    await tempPool.execute(`CREATE DATABASE IF NOT EXISTS ${config.db.database}`);
    await tempPool.end();
    
    console.log(`Database '${config.db.database}' ready`);
    
    // Create tables
    await createTables();
    
    // Run migrations for multi-tenant
    await runMultiTenantMigrations();
    
    // Create default tenant and admin
    await createDefaultTenantAndAdmin();
    
    console.log('Database initialization completed');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error;
  }
}

async function createTables() {
  // ===========================================
  // MULTI-TENANT CORE TABLES
  // ===========================================
  
  // Tenants table (Companies/Organizations)
  await execute(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      subdomain VARCHAR(100) UNIQUE,
      domain VARCHAR(255),
      email VARCHAR(255),
      phone VARCHAR(50),
      logo_url VARCHAR(500),
      address TEXT,
      city VARCHAR(100),
      country VARCHAR(100) DEFAULT 'UAE',
      timezone VARCHAR(50) DEFAULT 'Asia/Dubai',
      currency VARCHAR(10) DEFAULT 'AED',
      language VARCHAR(10) DEFAULT 'en',
      industry VARCHAR(100),
      company_size VARCHAR(50),
      status ENUM('active', 'trial', 'suspended', 'cancelled') DEFAULT 'trial',
      trial_ends_at DATETIME,
      settings JSON,
      metadata JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_slug (slug),
      INDEX idx_subdomain (subdomain),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Subscriptions table
  await execute(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      plan ENUM('trial', 'starter', 'professional', 'enterprise', 'self_hosted') DEFAULT 'trial',
      status ENUM('active', 'past_due', 'cancelled', 'paused') DEFAULT 'active',
      max_users INT DEFAULT 5,
      current_users INT DEFAULT 1,
      price_monthly DECIMAL(10, 2) DEFAULT 0,
      price_yearly DECIMAL(10, 2) DEFAULT 0,
      billing_cycle ENUM('monthly', 'yearly') DEFAULT 'monthly',
      stripe_customer_id VARCHAR(255),
      stripe_subscription_id VARCHAR(255),
      features JSON,
      started_at DATETIME,
      current_period_start DATETIME,
      current_period_end DATETIME,
      cancelled_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_status (status),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // License keys table (for self-hosted deployments)
  await execute(`
    CREATE TABLE IF NOT EXISTS license_keys (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      license_key VARCHAR(255) UNIQUE NOT NULL,
      license_type ENUM('trial', 'starter', 'professional', 'enterprise', 'unlimited') DEFAULT 'trial',
      max_users INT DEFAULT 5,
      features JSON,
      issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      is_active TINYINT(1) DEFAULT 1,
      activated_at DATETIME,
      last_validated_at DATETIME,
      validation_count INT DEFAULT 0,
      metadata JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_license_key (license_key),
      INDEX idx_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Staff table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS staff (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      username VARCHAR(50) NOT NULL,
      email VARCHAR(100),
      password VARCHAR(255) NOT NULL,
      full_name VARCHAR(100),
      phone VARCHAR(20),
      avatar_url VARCHAR(500),
      role VARCHAR(50) DEFAULT 'staff',
      permissions JSON,
      is_active TINYINT(1) DEFAULT 1,
      is_owner TINYINT(1) DEFAULT 0,
      last_login DATETIME,
      invited_by INT,
      invited_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      UNIQUE KEY unique_tenant_username (tenant_id, username),
      UNIQUE KEY unique_tenant_email (tenant_id, email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Accounts table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      industry VARCHAR(100),
      website VARCHAR(255),
      phone VARCHAR(50),
      email VARCHAR(100),
      address TEXT,
      city VARCHAR(100),
      country VARCHAR(100),
      status ENUM('active', 'inactive', 'prospect') DEFAULT 'active',
      owner_id INT,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_owner (owner_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Contacts table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      account_id INT,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100),
      email VARCHAR(100),
      phone VARCHAR(50),
      mobile VARCHAR(50),
      job_title VARCHAR(100),
      department VARCHAR(100),
      is_primary TINYINT(1) DEFAULT 0,
      status ENUM('active', 'inactive') DEFAULT 'active',
      owner_id INT,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_account (account_id),
      INDEX idx_owner (owner_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Leads table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS leads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100),
      company VARCHAR(255),
      job_title VARCHAR(100),
      email VARCHAR(100),
      phone VARCHAR(50),
      mobile VARCHAR(50),
      whatsapp VARCHAR(50),
      website VARCHAR(255),
      industry VARCHAR(100),
      source VARCHAR(100),
      status ENUM('new', 'contacted', 'qualified', 'unqualified', 'converted') DEFAULT 'new',
      rating ENUM('hot', 'warm', 'cold') DEFAULT 'warm',
      score INT DEFAULT 0,
      address TEXT,
      city VARCHAR(100),
      country VARCHAR(100),
      notes TEXT,
      owner_id INT,
      created_by INT,
      converted_at DATETIME,
      converted_account_id INT,
      converted_contact_id INT,
      converted_deal_id INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_status (status),
      INDEX idx_owner (owner_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Pipelines table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS pipelines (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(100) NOT NULL,
      description TEXT,
      industry VARCHAR(100),
      is_default TINYINT(1) DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Pipeline stages table (tenant inherited from pipeline)
  await execute(`
    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pipeline_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      color VARCHAR(20) DEFAULT '#667eea',
      probability INT DEFAULT 0,
      sort_order INT DEFAULT 0,
      is_won TINYINT(1) DEFAULT 0,
      is_lost TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pipeline (pipeline_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Deals table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS deals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      account_id INT,
      contact_id INT,
      lead_id INT,
      pipeline_id INT,
      stage_id INT,
      amount DECIMAL(15, 2),
      currency VARCHAR(10) DEFAULT 'AED',
      probability INT DEFAULT 0,
      expected_close_date DATE,
      status ENUM('open', 'won', 'lost') DEFAULT 'open',
      description TEXT,
      owner_id INT,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_stage (stage_id),
      INDEX idx_status (status),
      INDEX idx_owner (owner_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Activities table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS activities (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      type ENUM('call', 'meeting', 'email', 'task', 'note', 'whatsapp', 'sms', 'follow_up', 'other') NOT NULL,
      subject VARCHAR(255) NOT NULL,
      description TEXT,
      due_date DATE,
      due_time TIME,
      priority ENUM('low', 'medium', 'high', 'urgent') DEFAULT 'medium',
      status ENUM('pending', 'in_progress', 'completed', 'cancelled') DEFAULT 'pending',
      related_type ENUM('lead', 'contact', 'account', 'deal'),
      related_id INT,
      owner_id INT,
      assigned_to INT,
      completed_at DATETIME,
      reminder_datetime DATETIME,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_due_date (due_date),
      INDEX idx_status (status),
      INDEX idx_assigned (assigned_to)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Notes table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS notes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      title VARCHAR(255),
      content TEXT NOT NULL,
      related_type VARCHAR(50),
      related_id INT,
      is_pinned TINYINT(1) DEFAULT 0,
      is_private TINYINT(1) DEFAULT 0,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_related (related_type, related_id),
      INDEX idx_pinned (is_pinned)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Tags table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS tags (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(50) NOT NULL,
      color VARCHAR(20) DEFAULT '#667eea',
      entity_type VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Audit logs table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      user_id INT,
      action VARCHAR(50) NOT NULL,
      entity_type VARCHAR(50),
      entity_id INT,
      old_values JSON,
      new_values JSON,
      ip_address VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_user (user_id),
      INDEX idx_entity (entity_type, entity_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Products table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS products (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      sku VARCHAR(100),
      description TEXT,
      category VARCHAR(100),
      unit_price DECIMAL(15, 2) DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'AED',
      stock_quantity INT DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_category (category),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Quotes table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS quotes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      quote_number VARCHAR(50),
      deal_id INT,
      account_id INT,
      contact_id INT,
      title VARCHAR(255),
      subtotal DECIMAL(15, 2) DEFAULT 0,
      discount DECIMAL(15, 2) DEFAULT 0,
      tax DECIMAL(15, 2) DEFAULT 0,
      total DECIMAL(15, 2) DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'AED',
      status ENUM('draft', 'sent', 'accepted', 'rejected', 'expired') DEFAULT 'draft',
      valid_until DATE,
      terms TEXT,
      notes TEXT,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_deal (deal_id),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Quote items table
  await execute(`
    CREATE TABLE IF NOT EXISTS quote_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      quote_id INT NOT NULL,
      product_id INT,
      description TEXT,
      quantity DECIMAL(10, 2) DEFAULT 1,
      unit_price DECIMAL(15, 2) DEFAULT 0,
      discount DECIMAL(15, 2) DEFAULT 0,
      total DECIMAL(15, 2) DEFAULT 0,
      sort_order INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_quote (quote_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Branches table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS branches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      code VARCHAR(50),
      address TEXT,
      city VARCHAR(100),
      country VARCHAR(100),
      phone VARCHAR(50),
      email VARCHAR(100),
      manager_id INT,
      is_headquarters TINYINT(1) DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      timezone VARCHAR(50) DEFAULT 'Asia/Dubai',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Campaigns table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      type ENUM('email', 'sms', 'social', 'event', 'whatsapp', 'other') DEFAULT 'email',
      status ENUM('draft', 'scheduled', 'active', 'paused', 'completed') DEFAULT 'draft',
      start_date DATE,
      end_date DATE,
      budget DECIMAL(15, 2),
      target_audience TEXT,
      description TEXT,
      expected_response INT,
      actual_response INT DEFAULT 0,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_status (status),
      INDEX idx_type (type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Documents table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS documents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      file_path VARCHAR(500),
      file_type VARCHAR(50),
      file_size INT,
      category VARCHAR(100),
      related_type VARCHAR(50),
      related_id INT,
      description TEXT,
      is_public TINYINT(1) DEFAULT 0,
      uploaded_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_related (related_type, related_id),
      INDEX idx_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Custom fields table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS custom_fields (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      entity_type VARCHAR(50) NOT NULL,
      field_name VARCHAR(100) NOT NULL,
      field_label VARCHAR(100) NOT NULL,
      field_type ENUM('text', 'textarea', 'number', 'date', 'select', 'multiselect', 'checkbox', 'radio', 'email', 'phone', 'url', 'color') DEFAULT 'text',
      options JSON,
      default_value TEXT,
      is_required TINYINT(1) DEFAULT 0,
      is_visible TINYINT(1) DEFAULT 1,
      sort_order INT DEFAULT 0,
      section VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_entity (entity_type),
      UNIQUE KEY unique_field (tenant_id, entity_type, field_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Workflows table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS workflows (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      entity_type VARCHAR(50),
      trigger_event VARCHAR(50),
      conditions JSON,
      actions JSON,
      is_active TINYINT(1) DEFAULT 1,
      run_count INT DEFAULT 0,
      last_run DATETIME,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_entity (entity_type),
      INDEX idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Email templates table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      subject VARCHAR(255),
      body TEXT,
      category VARCHAR(100),
      variables JSON,
      is_active TINYINT(1) DEFAULT 1,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Inbox conversations table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS inbox_conversations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      channel VARCHAR(50) NOT NULL,
      channel_id VARCHAR(255),
      customer_name VARCHAR(255),
      customer_email VARCHAR(255),
      customer_phone VARCHAR(100),
      customer_identifier VARCHAR(255),
      subject VARCHAR(500),
      status ENUM('new', 'open', 'pending', 'resolved', 'closed') DEFAULT 'new',
      priority ENUM('low', 'medium', 'high', 'urgent') DEFAULT 'medium',
      assigned_to INT,
      contact_id INT,
      lead_id INT,
      account_id INT,
      is_starred TINYINT(1) DEFAULT 0,
      last_message_at DATETIME,
      first_response_at DATETIME,
      resolved_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_channel (channel),
      INDEX idx_status (status),
      INDEX idx_assigned (assigned_to)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Inbox messages table
  await execute(`
    CREATE TABLE IF NOT EXISTS inbox_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      conversation_id INT NOT NULL,
      direction ENUM('inbound', 'outbound') NOT NULL,
      message_type ENUM('text', 'html', 'attachment', 'system') DEFAULT 'text',
      content TEXT,
      sender_name VARCHAR(255),
      sender_email VARCHAR(255),
      attachments JSON,
      is_read TINYINT(1) DEFAULT 0,
      is_private TINYINT(1) DEFAULT 0,
      sent_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_conversation (conversation_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Inbox channels configuration (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS inbox_channels (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      channel_type VARCHAR(50) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      config JSON,
      is_active TINYINT(1) DEFAULT 1,
      color VARCHAR(20) DEFAULT '#244066',
      icon VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Audiences/Segments table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS audiences (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      criteria JSON,
      member_count INT DEFAULT 0,
      is_dynamic TINYINT(1) DEFAULT 1,
      last_calculated_at DATETIME,
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Integrations table (with tenant_id)
  await execute(`
    CREATE TABLE IF NOT EXISTS integrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT,
      name VARCHAR(100) NOT NULL,
      type VARCHAR(50) NOT NULL,
      config JSON,
      is_active TINYINT(1) DEFAULT 0,
      last_sync_at DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      UNIQUE KEY unique_tenant_type (tenant_id, type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ===========================================
  // BEAUTY CENTER SPECIFIC TABLES
  // ===========================================
  
  // Appointments table
  await execute(`
    CREATE TABLE IF NOT EXISTS appointments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      customer_id INT,
      service_id INT,
      staff_id INT,
      start_time DATETIME NOT NULL,
      end_time DATETIME NOT NULL,
      status ENUM('scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'no_show') DEFAULT 'scheduled',
      notes TEXT,
      reminder_sent BOOLEAN DEFAULT FALSE,
      customer_showed BOOLEAN DEFAULT FALSE,
      payment_status ENUM('pending', 'paid', 'refunded') DEFAULT 'pending',
      created_by INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_customer (customer_id),
      INDEX idx_staff (staff_id),
      INDEX idx_start_time (start_time),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Appointment reminders table
  await execute(`
    CREATE TABLE IF NOT EXISTS appointment_reminders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      appointment_id INT NOT NULL,
      send_at DATETIME,
      method ENUM('email', 'sms', 'whatsapp') DEFAULT 'email',
      sent_at DATETIME,
      status ENUM('pending', 'sent', 'failed') DEFAULT 'pending',
      INDEX idx_appointment (appointment_id),
      INDEX idx_send_at (send_at),
      INDEX idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Staff schedule table
  await execute(`
    CREATE TABLE IF NOT EXISTS staff_schedule (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      staff_id INT NOT NULL,
      day_of_week INT NOT NULL COMMENT '0=Sunday, 6=Saturday',
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      break_start TIME,
      break_end TIME,
      is_working TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_staff (staff_id),
      INDEX idx_day (day_of_week)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Staff days off table
  await execute(`
    CREATE TABLE IF NOT EXISTS staff_days_off (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      staff_id INT NOT NULL,
      date DATE NOT NULL,
      reason VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_staff (staff_id),
      INDEX idx_date (date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Staff specializations table
  await execute(`
    CREATE TABLE IF NOT EXISTS staff_specializations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      staff_id INT NOT NULL,
      service_id INT NOT NULL,
      skill_level ENUM('beginner', 'intermediate', 'expert', 'master') DEFAULT 'intermediate',
      certified BOOLEAN DEFAULT FALSE,
      certification_date DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_staff (staff_id),
      INDEX idx_service (service_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Loyalty points table
  await execute(`
    CREATE TABLE IF NOT EXISTS loyalty_points (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      customer_id INT NOT NULL,
      points INT DEFAULT 0,
      total_earned INT DEFAULT 0,
      total_redeemed INT DEFAULT 0,
      tier VARCHAR(50) DEFAULT 'bronze' COMMENT 'bronze, silver, gold, platinum',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_customer (customer_id),
      UNIQUE KEY unique_tenant_customer (tenant_id, customer_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Loyalty transactions table
  await execute(`
    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tenant_id INT NOT NULL,
      customer_id INT NOT NULL,
      points INT NOT NULL,
      transaction_type ENUM('earn', 'redeem', 'expire', 'adjust') NOT NULL,
      reference_type VARCHAR(50),
      reference_id INT,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tenant (tenant_id),
      INDEX idx_customer (customer_id),
      INDEX idx_type (transaction_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Super Admins table (platform-level admins)
  await execute(`
    CREATE TABLE IF NOT EXISTS super_admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      email VARCHAR(100) UNIQUE,
      password VARCHAR(255) NOT NULL,
      full_name VARCHAR(100),
      role VARCHAR(50) DEFAULT 'super_admin',
      permissions JSON,
      is_active TINYINT(1) DEFAULT 1,
      last_login DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log('Tables created/verified successfully');
}

// Run migrations to add tenant_id to existing tables
async function runMultiTenantMigrations() {
  console.log('Running multi-tenant migrations...');
  
  const tablesNeedingTenantId = [
    'staff', 'accounts', 'contacts', 'leads', 'pipelines', 'deals',
    'activities', 'notes', 'tags', 'audit_logs', 'products', 'quotes',
    'branches', 'campaigns', 'documents', 'custom_fields', 'workflows',
    'email_templates', 'inbox_conversations', 'inbox_channels', 'audiences', 'integrations'
  ];
  
  for (const table of tablesNeedingTenantId) {
    try {
      // Check if tenant_id column exists
      const [columns] = await pool.execute(`SHOW COLUMNS FROM ${table} LIKE 'tenant_id'`);
      if (columns.length === 0) {
        await execute(`ALTER TABLE ${table} ADD COLUMN tenant_id INT AFTER id`);
        await execute(`ALTER TABLE ${table} ADD INDEX idx_tenant (tenant_id)`);
        console.log(`Added tenant_id to ${table}`);
      }
    } catch (e) {
      // Table might not exist yet
    }
  }
  
  // Add stock_quantity to products if not exists
  try {
    await execute(`ALTER TABLE products ADD COLUMN stock_quantity INT DEFAULT 0 AFTER currency`);
  } catch (e) { /* exists */ }
  
  // Add is_owner to staff if not exists
  try {
    await execute(`ALTER TABLE staff ADD COLUMN is_owner TINYINT(1) DEFAULT 0 AFTER is_active`);
  } catch (e) { /* exists */ }
  
  // Add avatar_url to staff if not exists
  try {
    await execute(`ALTER TABLE staff ADD COLUMN avatar_url VARCHAR(500) AFTER phone`);
  } catch (e) { /* exists */ }
  
  // Drop old unique constraint on username if exists (from before multi-tenant)
  try {
    await execute(`ALTER TABLE staff DROP INDEX username`);
    console.log('Dropped old unique constraint on staff.username');
  } catch (e) { /* Constraint may not exist */ }
  
  // Try to add composite unique key if not exists
  try {
    await execute(`ALTER TABLE staff ADD UNIQUE KEY unique_tenant_username (tenant_id, username)`);
    console.log('Added composite unique key for tenant_id + username');
  } catch (e) { /* Key may already exist */ }
  
  try {
    await execute(`ALTER TABLE staff ADD UNIQUE KEY unique_tenant_email (tenant_id, email)`);
    console.log('Added composite unique key for tenant_id + email');
  } catch (e) { /* Key may already exist */ }

  // ============================================================
  // Schema alignment migrations - add missing columns to tables
  // that were created by createTables() with minimal schemas
  // but routes expect additional columns from ensureTable()
  // ============================================================

  const columnMigrations = [
    // --- quotes ---
    { table: 'quotes', column: 'owner_id', definition: 'INT' },
    { table: 'quotes', column: 'subject', definition: 'VARCHAR(255)' },

    // --- branches ---
    { table: 'branches', column: 'name_ar', definition: 'VARCHAR(255)' },
    { table: 'branches', column: 'currency', definition: "VARCHAR(10) DEFAULT 'AED'" },

    // --- campaigns ---
    { table: 'campaigns', column: 'owner_id', definition: 'INT' },
    { table: 'campaigns', column: 'actual_cost', definition: 'DECIMAL(15,2) DEFAULT 0' },
    { table: 'campaigns', column: 'total_sent', definition: 'INT DEFAULT 0' },
    { table: 'campaigns', column: 'total_opened', definition: 'INT DEFAULT 0' },
    { table: 'campaigns', column: 'total_clicked', definition: 'INT DEFAULT 0' },
    { table: 'campaigns', column: 'total_converted', definition: 'INT DEFAULT 0' },

    // --- documents ---
    { table: 'documents', column: 'title', definition: 'VARCHAR(255)' },
    { table: 'documents', column: 'file_name', definition: 'VARCHAR(255)' },
    { table: 'documents', column: 'version', definition: "VARCHAR(20) DEFAULT '1.0'" },
    { table: 'documents', column: 'is_private', definition: 'TINYINT(1) DEFAULT 0' },
    { table: 'documents', column: 'owner_id', definition: 'INT' },
    { table: 'documents', column: 'created_by', definition: 'INT' },
    { table: 'documents', column: 'updated_at', definition: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP' },

    // --- inbox_messages ---
    { table: 'inbox_messages', column: 'sender_type', definition: "ENUM('customer','agent','system')" },
    { table: 'inbox_messages', column: 'sender_id', definition: 'INT' },
    { table: 'inbox_messages', column: 'content_type', definition: "ENUM('text','html','image','file','audio','video') DEFAULT 'text'" },
    { table: 'inbox_messages', column: 'read_at', definition: 'TIMESTAMP NULL' },

    // --- inbox_channels ---
    { table: 'inbox_channels', column: 'name', definition: 'VARCHAR(255)' },
    { table: 'inbox_channels', column: 'is_enabled', definition: 'TINYINT(1) DEFAULT 1' },

    // --- integrations ---
    { table: 'integrations', column: 'provider', definition: 'VARCHAR(100)' },
    { table: 'integrations', column: 'credentials', definition: 'JSON' },
    { table: 'integrations', column: 'is_connected', definition: 'TINYINT(1) DEFAULT 0' },
    { table: 'integrations', column: 'last_error', definition: 'TEXT' },
    { table: 'integrations', column: 'webhook_url', definition: 'VARCHAR(500)' },
    { table: 'integrations', column: 'webhook_secret', definition: 'VARCHAR(255)' },
    { table: 'integrations', column: 'created_by', definition: 'INT' },

    // --- email_templates ---
    { table: 'email_templates', column: 'placeholders', definition: 'JSON' },

    // --- workflows ---
    { table: 'workflows', column: 'trigger_field', definition: 'VARCHAR(100)' },
    { table: 'workflows', column: 'execution_count', definition: 'INT DEFAULT 0' },
    { table: 'workflows', column: 'last_executed_at', definition: 'TIMESTAMP NULL' },

    // --- audiences ---
    { table: 'audiences', column: 'type', definition: "ENUM('static','dynamic') DEFAULT 'static'" },
    { table: 'audiences', column: 'tags', definition: 'JSON' },
    { table: 'audiences', column: 'is_active', definition: 'TINYINT(1) DEFAULT 1' },
    { table: 'audiences', column: 'last_synced_at', definition: 'DATETIME' },

    // --- custom_fields ---
    { table: 'custom_fields', column: 'field_label_ar', definition: 'VARCHAR(255)' },
    { table: 'custom_fields', column: 'placeholder', definition: 'VARCHAR(255)' },
    { table: 'custom_fields', column: 'is_unique', definition: 'TINYINT(1) DEFAULT 0' },
    { table: 'custom_fields', column: 'is_active', definition: 'TINYINT(1) DEFAULT 1' },
    { table: 'custom_fields', column: 'validation', definition: 'JSON' },
    { table: 'custom_fields', column: 'description', definition: 'TEXT' },
    { table: 'custom_fields', column: 'created_by', definition: 'INT' },
  ];

  for (const { table, column, definition } of columnMigrations) {
    try {
      await execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`  Added ${table}.${column}`);
    } catch (e) {
      // Column already exists or table doesn't exist yet – skip silently
    }
  }

  // ============================================================
  // Fix NOT NULL constraints on columns that routes don't populate
  // (table was created by createTables with columns the route
  //  doesn't use; those NOT NULL cols block INSERTs)
  // ============================================================
  const modifyMigrations = [
    // documents: createTables has "name NOT NULL" but route uses "title"
    { table: 'documents', sql: 'ALTER TABLE documents MODIFY COLUMN name VARCHAR(255) NULL' },
    // inbox_conversations: createTables has "channel NOT NULL" but route INSERT doesn't set it
    { table: 'inbox_conversations', sql: 'ALTER TABLE inbox_conversations MODIFY COLUMN channel VARCHAR(50) NULL' },
    // inbox_messages: createTables has "direction NOT NULL" but route INSERT doesn't set it
    { table: 'inbox_messages', sql: 'ALTER TABLE inbox_messages MODIFY COLUMN direction ENUM(\'inbound\', \'outbound\') NULL' },
  ];

  for (const { table, sql } of modifyMigrations) {
    try {
      await execute(sql);
      console.log(`  Modified ${table} column constraint`);
    } catch (e) {
      // Column or table might not exist
    }
  }

  // Migrate staff.role from ENUM to VARCHAR for flexible roles
  try {
    await pool.execute("ALTER TABLE staff MODIFY COLUMN role VARCHAR(50) DEFAULT 'staff'");
  } catch (e) { /* already VARCHAR or other issue */ }

  console.log('Multi-tenant migrations completed');
}

async function createDefaultTenantAndAdmin() {
  const bcrypt = await import('bcryptjs');
  
  // Create default Trasealla tenant
  const [tenantExists] = await pool.execute("SELECT id FROM tenants WHERE slug = 'trasealla'");
  let tenantId;
  
  if (tenantExists.length === 0) {
    const trialEnds = new Date();
    trialEnds.setDate(trialEnds.getDate() + 14); // 14-day trial
    
    const [tenantResult] = await pool.execute(
      `INSERT INTO tenants (name, slug, subdomain, email, status, trial_ends_at, settings) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'Trasealla',
        'trasealla',
        'trasealla',
        'info@trasealla.com',
        'active',
        trialEnds.toISOString().slice(0, 19).replace('T', ' '),
        JSON.stringify({ isDemo: true, isPlatformOwner: true })
      ]
    );
    tenantId = tenantResult.insertId;
    console.log('Default tenant created: Trasealla');
  } else {
    tenantId = tenantExists[0].id;
  }
  
  if (tenantExists.length === 0) {
    // Create subscription for default tenant
    await execute(
      `INSERT INTO subscriptions (tenant_id, plan, status, max_users, features) VALUES (?, ?, ?, ?, ?)`,
      [tenantId, 'enterprise', 'active', 999, JSON.stringify({ all: true })]
    );
  }
  
  // Create Trasealla Super Admin (Platform Owner)
  const [superAdminExists] = await pool.execute("SELECT id FROM staff WHERE username = 'osama'");
  if (superAdminExists.length === 0) {
    const hashedPassword = await bcrypt.default.hash('ALPHa251611@', 10);
    await execute(
      `INSERT INTO staff (tenant_id, username, email, password, full_name, role, permissions, is_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        null, // null tenant_id means platform super admin (can access all tenants)
        'osama',
        'osama@trasealla.com',
        hashedPassword,
        'Osama - Platform Owner',
        'super_admin',
        JSON.stringify({ 
          super_admin: true,
          platform_owner: true,
          manage_tenants: true,
          manage_all: true
        }),
        1
      ]
    );
    console.log('Platform Super Admin created: osama');
  } else {
    // Update existing osama user to be platform owner
    await execute(
      `UPDATE staff SET tenant_id = NULL, role = 'super_admin', is_owner = 1, 
       permissions = ? WHERE username = 'osama'`,
      [JSON.stringify({ super_admin: true, platform_owner: true, manage_tenants: true, manage_all: true })]
    );
    console.log('Updated osama as Platform Super Admin');
  }

  // Seed super_admins table for the Super Admin portal
  const [saExists] = await pool.execute("SELECT id FROM super_admins WHERE username = 'trasealla_admin'");
  const saHash = await bcrypt.default.hash('Trasealla@2025!', 10);
  if (saExists.length === 0) {
    await execute(
      `INSERT INTO super_admins (username, email, password, full_name, role, permissions) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        'trasealla_admin',
        'admin@trasealla.com',
        saHash,
        'Trasealla Super Admin',
        'super_admin',
        JSON.stringify({ super_admin: true, platform_owner: true, manage_tenants: true, manage_all: true })
      ]
    );
    console.log('Super Admin portal user created: trasealla_admin');
  } else {
    // Always ensure the password is up-to-date
    await execute('UPDATE super_admins SET password = ? WHERE username = ?', [saHash, 'trasealla_admin']);
  }
  
  // Create or update Trasealla tenant admin
  const [adminExists] = await pool.execute("SELECT id, tenant_id FROM staff WHERE username = 'admin'");
  if (adminExists.length === 0) {
    const hashedPassword = await bcrypt.default.hash('admin123', 10);
    await execute(
      `INSERT INTO staff (tenant_id, username, email, password, full_name, role, permissions, is_owner, password_set) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [tenantId, 'admin', 'admin@trasealla.com', hashedPassword, 'Tenant Administrator', 'admin', JSON.stringify({ all: true }), 1]
    );
    console.log('Tenant admin created: admin / admin123');
  } else if (adminExists[0].tenant_id === null) {
    // Update existing admin to belong to the default tenant
    await execute(
      `UPDATE staff SET tenant_id = ?, is_owner = 1 WHERE username = 'admin'`,
      [tenantId]
    );
    console.log('Updated admin user with tenant_id');
  }
  
  // Create or update demo user for the default tenant
  const [demoExists] = await pool.execute("SELECT id, tenant_id FROM staff WHERE username = 'demo'");
  if (demoExists.length === 0) {
    const hashedPassword = await bcrypt.default.hash('demo123', 10);
    await execute(
      `INSERT INTO staff (tenant_id, username, email, password, full_name, role, permissions) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, 'demo', 'demo@trasealla.com', hashedPassword, 'Demo User', 'staff', JSON.stringify({ read: true, write: true })]
    );
    console.log('Demo user created: demo / demo123');
  } else if (demoExists[0].tenant_id === null) {
    await execute(`UPDATE staff SET tenant_id = ? WHERE username = 'demo'`, [tenantId]);
    console.log('Updated demo user with tenant_id');
  }

  // Create demo users for each predefined role
  const demoRoleUsers = [
    { username: 'manager_demo', email: 'manager@beauty.com', password: 'Manager123', full_name: 'Sarah Manager', role: 'manager', job_title: 'Salon Manager' },
    { username: 'reception_demo', email: 'reception@beauty.com', password: 'Reception123', full_name: 'Lina Receptionist', role: 'receptionist', job_title: 'Front Desk' },
    { username: 'stylist_demo', email: 'stylist@beauty.com', password: 'Stylist123', full_name: 'Nora Stylist', role: 'stylist', job_title: 'Senior Hair Stylist' },
  ];

  for (const u of demoRoleUsers) {
    const [exists] = await pool.execute("SELECT id FROM staff WHERE username = ?", [u.username]);
    if (exists.length === 0) {
      const hp = await bcrypt.default.hash(u.password, 10);
      await execute(
        `INSERT INTO staff (tenant_id, username, email, password, full_name, role, job_title, is_active, password_set) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
        [tenantId, u.username, u.email, hp, u.full_name, u.role, u.job_title]
      );
      console.log(`Demo ${u.role} created: ${u.username} / ${u.password}`);
    }
  }
  
  // Create default pipeline for the tenant if none exists
  const [pipelines] = await pool.execute('SELECT id FROM pipelines WHERE tenant_id = ?', [tenantId]);
  if (pipelines.length === 0) {
    const [result] = await pool.execute(
      "INSERT INTO pipelines (tenant_id, name, description, is_default) VALUES (?, ?, ?, ?)",
      [tenantId, 'Sales Pipeline', 'Default sales pipeline', 1]
    );
    const pipelineId = result.insertId;
    
    const stages = [
      { name: 'Qualification', color: '#3b82f6', probability: 10, order: 1 },
      { name: 'Needs Analysis', color: '#8b5cf6', probability: 25, order: 2 },
      { name: 'Proposal', color: '#f59e0b', probability: 50, order: 3 },
      { name: 'Negotiation', color: '#ef4444', probability: 75, order: 4 },
      { name: 'Closed Won', color: '#22c55e', probability: 100, order: 5, is_won: 1 },
      { name: 'Closed Lost', color: '#6b7280', probability: 0, order: 6, is_lost: 1 },
    ];
    
    for (const stage of stages) {
      await execute(
        'INSERT INTO pipeline_stages (pipeline_id, name, color, probability, sort_order, is_won, is_lost) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [pipelineId, stage.name, stage.color, stage.probability, stage.order, stage.is_won || 0, stage.is_lost || 0]
      );
    }
    console.log('Default pipeline created for tenant');
  }
  
  // Update existing data to have tenant_id (migration for existing data)
  const [existingDataWithoutTenant] = await pool.execute('SELECT COUNT(*) as cnt FROM accounts WHERE tenant_id IS NULL');
  if (existingDataWithoutTenant[0].cnt > 0) {
    console.log('Migrating existing data to default tenant...');
    const tablesToMigrate = ['accounts', 'contacts', 'leads', 'deals', 'activities', 'notes', 'tags', 'products', 'quotes', 'campaigns', 'documents'];
    for (const table of tablesToMigrate) {
      try {
        await execute(`UPDATE ${table} SET tenant_id = ? WHERE tenant_id IS NULL`, [tenantId]);
      } catch (e) { /* ignore */ }
    }
  }
}

export default pool;
