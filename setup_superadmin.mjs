// Check if super_admins table exists and create the Trasealla account
import { query, execute } from '/Users/usama/Desktop/trasealla/crm-project/beauty-center-crm/crm-backend/src/lib/database.js';
import bcrypt from 'bcryptjs';

async function run() {
  // Check if table exists
  try {
    const rows = await query('SELECT * FROM super_admins LIMIT 5');
    console.log('super_admins table EXISTS. Rows:', rows.length);
    rows.forEach(r => console.log(`  id=${r.id} username=${r.username} email=${r.email} active=${r.is_active}`));
  } catch (e) {
    console.log('super_admins table DOES NOT EXIST. Creating...');
    await execute(`
      CREATE TABLE IF NOT EXISTS super_admins (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        full_name VARCHAR(255) DEFAULT 'Trasealla Admin',
        role VARCHAR(50) DEFAULT 'super_admin',
        permissions JSON DEFAULT NULL,
        is_active TINYINT(1) DEFAULT 1,
        last_login DATETIME DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('Table created!');
  }

  // Check if trasealla account exists
  const existing = await query("SELECT id, email FROM super_admins WHERE email = 'info@trasealla.com'");
  const hashed = await bcrypt.hash('ALPHa251611@', 12);

  if (existing.length > 0) {
    await execute("UPDATE super_admins SET password = ?, is_active = 1 WHERE email = 'info@trasealla.com'", [hashed]);
    console.log('Updated password for info@trasealla.com');
  } else {
    await execute(
      "INSERT INTO super_admins (username, email, password, full_name, role, is_active) VALUES (?,?,?,?,?,1)",
      ['trasealla', 'info@trasealla.com', hashed, 'Trasealla Admin', 'super_admin']
    );
    console.log('Created super admin account: info@trasealla.com');
  }

  // Check tenants table structure
  try {
    const tenants = await query('SELECT id, name, status, plan, email, created_at FROM tenants LIMIT 10');
    console.log('\nTenants in DB:', tenants.length);
    tenants.forEach(t => console.log(`  id=${t.id} name=${t.name} status=${t.status} plan=${t.plan||'N/A'} email=${t.email}`));
  } catch(e) {
    console.log('Tenants query failed:', e.message);
  }

  // Check if tenants table has plan / subscription fields
  try {
    const cols = await query("SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='tenants' AND TABLE_SCHEMA=DATABASE()");
    console.log('\nTenants table columns:', cols.map(c=>`${c.COLUMN_NAME}(${c.COLUMN_TYPE})`).join(', '));
  } catch(e) {
    console.log('Column check failed:', e.message);
  }

  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
