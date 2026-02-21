// Add plan/subscription columns to tenants table
import { query, execute } from '/Users/usama/Desktop/trasealla/crm-project/beauty-center-crm/crm-backend/src/lib/database.js';

async function run() {
  const alterations = [
    "ALTER TABLE tenants ADD COLUMN plan ENUM('trial','starter','professional','enterprise') DEFAULT 'trial'",
    "ALTER TABLE tenants ADD COLUMN max_users INT DEFAULT 5",
    "ALTER TABLE tenants ADD COLUMN subscription_ends_at DATETIME DEFAULT NULL",
    "ALTER TABLE tenants ADD COLUMN billing_email VARCHAR(255) DEFAULT NULL",
    "ALTER TABLE tenants ADD COLUMN monthly_price DECIMAL(10,2) DEFAULT 0.00",
    "ALTER TABLE tenants ADD COLUMN is_active TINYINT(1) DEFAULT 1",
  ];

  for (const sql of alterations) {
    const col = sql.match(/ADD COLUMN (\w+)/)?.[1];
    try {
      await execute(sql);
      console.log(`✅ Added column: ${col}`);
    } catch(e) {
      if (e.message.includes('Duplicate column')) {
        console.log(`⚠️  Column ${col} already exists — skipping`);
      } else {
        console.log(`❌ Failed ${col}: ${e.message}`);
      }
    }
  }

  // Set trial end dates for existing tenants
  await execute("UPDATE tenants SET plan='trial', subscription_ends_at = DATE_ADD(NOW(), INTERVAL 30 DAY) WHERE plan IS NULL OR plan = 'trial'");
  console.log('✅ Updated trial dates for existing tenants');

  // Show current state
  const tenants = await query('SELECT id, name, status, plan, max_users, subscription_ends_at, email FROM tenants');
  console.log('\nTenants:');
  tenants.forEach(t => console.log(`  ${t.id}: ${t.name} | status=${t.status} | plan=${t.plan} | max_users=${t.max_users} | email=${t.email}`));

  process.exit(0);
}
run().catch(e => { console.error(e); process.exit(1); });
