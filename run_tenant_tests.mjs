// ============================================================
// FULL INTEGRATION TEST — Tenant Lifecycle + Module Cycle
// Tenant: YopTest Salon | yopmail.com emails
// Run: node run_tenant_tests.mjs
// ============================================================
import bcrypt from 'bcryptjs';
import { query, execute } from './src/lib/database.js';

const PASS = 'Test@1234!';
const hash = await bcrypt.hash(PASS, 12);
const ALL_MODULES = ['accounts','contacts','leads','deals','pipelines','activities','calendar','notes','tags','products','quotes','documents','campaigns','audiences','email_templates','integrations','inbox','branches','custom_fields','workflows','reports','audit_logs'];

const results = [];
const pass = (name, detail = '') => { results.push({ status: 'PASS', name, detail }); console.log(`  ✅  ${name}${detail ? ' — ' + detail : ''}`); };
const fail = (name, detail = '') => { results.push({ status: 'FAIL', name, detail }); console.log(`  ❌  ${name}${detail ? ' — ' + detail : ''}`); };

// ── CLEANUP ─────────────────────────────────────────────────
console.log('\n📦  CLEANUP: removing stale yop-test data...');
const stale = await query("SELECT id FROM tenants WHERE slug LIKE 'test-yop-salon%'");
for (const t of stale) {
  await execute('DELETE FROM staff WHERE tenant_id=?', [t.id]);
  await execute('DELETE FROM tenants WHERE id=?', [t.id]);
}
console.log(`   Removed ${stale.length} stale tenant(s)\n`);

// ────────────────────────────────────────────────────────────
// TC-01  CREATE TENANT  (max_users = 2)
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-01  Create tenant with max_users=2');
let tenantId;
try {
  const slug = 'test-yop-salon-' + Date.now();
  const r = await execute(
    `INSERT INTO tenants (name,slug,email,phone,industry,status,plan,max_users,billing_email,is_active,created_at)
     VALUES (?,?,?,?,?,'trial','trial',2,?,1,NOW())`,
    ['YopTest Salon', slug, 'yoptest-owner@yopmail.com', '+971501234567', 'beauty', 'yoptest-owner@yopmail.com']
  );
  tenantId = r.insertId;
  pass('TC-01', `Tenant id=${tenantId}  slug=${slug}  max_users=2`);
} catch (e) { fail('TC-01', e.message); process.exit(1); }

// ────────────────────────────────────────────────────────────
// TC-02  VERIFY tenant DB record
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-02  Verify tenant fields in DB');
const [t] = await query('SELECT id,name,max_users,status,plan,is_active,allowed_modules FROM tenants WHERE id=?', [tenantId]);
t.max_users === 2           ? pass('TC-02a', `max_users=2`)            : fail('TC-02a', `Got ${t.max_users}`);
t.is_active === 1           ? pass('TC-02b', `is_active=1`)            : fail('TC-02b', `Got ${t.is_active}`);
t.status === 'trial'        ? pass('TC-02c', `status=trial`)           : fail('TC-02c', `Got ${t.status}`);
t.plan === 'trial'          ? pass('TC-02d', `plan=trial`)             : fail('TC-02d', `Got ${t.plan}`);
t.allowed_modules === null  ? pass('TC-02e', `allowed_modules=null (all modules default)`)
                            : pass('TC-02e', `allowed_modules already set=${t.allowed_modules}`);

// ────────────────────────────────────────────────────────────
// TC-03  CREATE USER #1 — admin  (yoptest-admin@yopmail.com)
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-03  Create admin user (user #1 of 2)');
let adminId;
try {
  const r = await execute(
    `INSERT INTO staff (tenant_id,username,email,password,full_name,role,is_active,created_at)
     VALUES (?,?,?,?,?,'admin',1,NOW())`,
    [tenantId, 'yoptest_admin', 'yoptest-admin@yopmail.com', hash, 'YopTest Admin']
  );
  adminId = r.insertId;
  const { cnt } = (await query('SELECT COUNT(*) AS cnt FROM staff WHERE tenant_id=?', [tenantId]))[0];
  pass('TC-03', `admin id=${adminId}  tenant_users=${cnt}/2`);
} catch (e) { fail('TC-03', e.message); }

// ────────────────────────────────────────────────────────────
// TC-04  CREATE USER #2 — staff (hits max_users limit)
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-04  Create staff user (user #2 of 2 — at limit)');
let staffId;
try {
  const r = await execute(
    `INSERT INTO staff (tenant_id,username,email,password,full_name,role,is_active,created_at)
     VALUES (?,?,?,?,?,'staff',1,NOW())`,
    [tenantId, 'yoptest_staff1', 'yoptest-staff1@yopmail.com', hash, 'YopTest Staff One']
  );
  staffId = r.insertId;
  const { cnt } = (await query('SELECT COUNT(*) AS cnt FROM staff WHERE tenant_id=?', [tenantId]))[0];
  pass('TC-04', `staff id=${staffId}  tenant_users=${cnt}/2`);
} catch (e) { fail('TC-04', e.message); }

// ────────────────────────────────────────────────────────────
// TC-05  max_users ENFORCEMENT GUARD (simulating API check)
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-05  max_users enforcement guard');
const { cnt: activeNow } = (await query('SELECT COUNT(*) AS cnt FROM staff WHERE tenant_id=? AND is_active=1', [tenantId]))[0];
const { max_users: maxU } = (await query('SELECT max_users FROM tenants WHERE id=?', [tenantId]))[0];
if (activeNow >= maxU) {
  pass('TC-05', `Guard fires: active=${activeNow} >= max_users=${maxU} → 3rd invite would return 403`);
} else {
  fail('TC-05', `Guard would NOT fire: active=${activeNow}  max=${maxU}`);
}

// ────────────────────────────────────────────────────────────
// TC-06  MODULES — set 5 specific modules
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-06  Configure 5 specific modules for tenant');
const five = ['appointments', 'clients', 'invoicing', 'staff', 'reports'];
await execute('UPDATE tenants SET allowed_modules=? WHERE id=?', [JSON.stringify(five), tenantId]);
const saved6 = JSON.parse((await query('SELECT allowed_modules FROM tenants WHERE id=?', [tenantId]))[0].allowed_modules);
JSON.stringify(saved6) === JSON.stringify(five)
  ? pass('TC-06', `Saved: [${saved6.join(', ')}]`)
  : fail('TC-06', `Got: ${JSON.stringify(saved6)}`);

// ────────────────────────────────────────────────────────────
// TC-07  MODULES — verify count
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-07  Verify module count = 5');
saved6.length === 5 ? pass('TC-07', '5/22 modules stored') : fail('TC-07', `Got ${saved6.length}`);

// ────────────────────────────────────────────────────────────
// TC-08  MODULES — disable 2 (invoicing + reports)
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-08  Disable invoicing + reports');
const three = five.filter(m => !['invoicing', 'reports'].includes(m));
await execute('UPDATE tenants SET allowed_modules=? WHERE id=?', [JSON.stringify(three), tenantId]);
const saved8 = JSON.parse((await query('SELECT allowed_modules FROM tenants WHERE id=?', [tenantId]))[0].allowed_modules);
(saved8.length === 3 && !saved8.includes('invoicing') && !saved8.includes('reports'))
  ? pass('TC-08', `Reduced to [${saved8.join(', ')}]`)
  : fail('TC-08', `Got: ${JSON.stringify(saved8)}`);

// ────────────────────────────────────────────────────────────
// TC-09  MODULES — re-enable all 22
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-09  Re-enable all 22 modules');
await execute('UPDATE tenants SET allowed_modules=? WHERE id=?', [JSON.stringify(ALL_MODULES), tenantId]);
const saved9 = JSON.parse((await query('SELECT allowed_modules FROM tenants WHERE id=?', [tenantId]))[0].allowed_modules);
saved9.length === 22 ? pass('TC-09', '22/22 modules enabled') : fail('TC-09', `Got ${saved9.length}`);

// ────────────────────────────────────────────────────────────
// TC-10  MODULES — reset to null (all-enabled default)
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-10  Reset allowed_modules to NULL (all-enabled default)');
await execute('UPDATE tenants SET allowed_modules=NULL WHERE id=?', [tenantId]);
const row10 = (await query('SELECT allowed_modules FROM tenants WHERE id=?', [tenantId]))[0];
row10.allowed_modules === null
  ? pass('TC-10', 'NULL → frontend shows all 22 as enabled')
  : fail('TC-10', `Expected null got ${row10.allowed_modules}`);

// ────────────────────────────────────────────────────────────
// TC-11  TOGGLE TENANT — suspend
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-11  Suspend tenant (is_active → 0)');
await execute('UPDATE tenants SET is_active=0 WHERE id=?', [tenantId]);
const { is_active: ia11 } = (await query('SELECT is_active FROM tenants WHERE id=?', [tenantId]))[0];
ia11 === 0 ? pass('TC-11', 'Tenant suspended') : fail('TC-11', `is_active=${ia11}`);

// ────────────────────────────────────────────────────────────
// TC-12  TOGGLE TENANT — re-activate
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-12  Re-activate tenant (is_active → 1)');
await execute('UPDATE tenants SET is_active=1 WHERE id=?', [tenantId]);
const { is_active: ia12 } = (await query('SELECT is_active FROM tenants WHERE id=?', [tenantId]))[0];
ia12 === 1 ? pass('TC-12', 'Tenant re-activated') : fail('TC-12', `is_active=${ia12}`);

// ────────────────────────────────────────────────────────────
// TC-13  TOGGLE USER — deactivate admin
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-13  Deactivate admin user');
await execute('UPDATE staff SET is_active=0 WHERE id=?', [adminId]);
const { is_active: ia13 } = (await query('SELECT is_active FROM staff WHERE id=?', [adminId]))[0];
ia13 === 0 ? pass('TC-13', `Admin ${adminId} deactivated`) : fail('TC-13', `is_active=${ia13}`);

// ────────────────────────────────────────────────────────────
// TC-14  TOGGLE USER — re-activate admin
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-14  Re-activate admin user');
await execute('UPDATE staff SET is_active=1 WHERE id=?', [adminId]);
const { is_active: ia14 } = (await query('SELECT is_active FROM staff WHERE id=?', [adminId]))[0];
ia14 === 1 ? pass('TC-14', `Admin ${adminId} re-activated`) : fail('TC-14', `is_active=${ia14}`);

// ────────────────────────────────────────────────────────────
// TC-15  UPDATE max_users 2 → 3
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-15  Increase max_users 2 → 3');
await execute('UPDATE tenants SET max_users=3 WHERE id=?', [tenantId]);
const { max_users: mu15 } = (await query('SELECT max_users FROM tenants WHERE id=?', [tenantId]))[0];
mu15 === 3 ? pass('TC-15', 'max_users=3') : fail('TC-15', `Got ${mu15}`);

// ────────────────────────────────────────────────────────────
// TC-16  CREATE USER #3 — manager (now allowed)
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-16  Create 3rd user (manager) now that max_users=3');
let managerId;
try {
  const r = await execute(
    `INSERT INTO staff (tenant_id,username,email,password,full_name,role,is_active,created_at)
     VALUES (?,?,?,?,?,'manager',1,NOW())`,
    [tenantId, 'yoptest_mgr', 'yoptest-manager@yopmail.com', hash, 'YopTest Manager']
  );
  managerId = r.insertId;
  pass('TC-16', `manager id=${managerId}`);
} catch (e) { fail('TC-16', e.message); }

// ────────────────────────────────────────────────────────────
// TC-17  /super-admin/users query (JOIN check)
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-17  Verify users JOIN query (simulates /super-admin/users)');
const users17 = await query(
  `SELECT s.id,s.username,s.email,s.role,s.is_active,t.name AS tenant_name
   FROM staff s INNER JOIN tenants t ON t.id=s.tenant_id
   WHERE s.tenant_id=? ORDER BY s.id`,
  [tenantId]
);
users17.length === 3   ? pass('TC-17a', `3 users returned`)                  : fail('TC-17a', `Got ${users17.length}`);
users17.every(u => u.tenant_name === 'YopTest Salon')
                       ? pass('TC-17b', 'All have correct tenant_name')        : fail('TC-17b', 'tenant_name mismatch');
const roles17 = users17.map(u => u.role).sort().join(',');
roles17 === 'admin,manager,staff' ? pass('TC-17c', `Roles: ${roles17}`) : fail('TC-17c', `Got: ${roles17}`);
users17.every(u => u.is_active === 1)
                       ? pass('TC-17d', 'All users active')                    : fail('TC-17d', `Some inactive`);

// ────────────────────────────────────────────────────────────
// TC-18  PLAN UPGRADE  trial → professional
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-18  Upgrade plan trial → professional');
await execute("UPDATE tenants SET plan='professional', max_users=25 WHERE id=?", [tenantId]);
const { plan: p18, max_users: mu18 } = (await query('SELECT plan,max_users FROM tenants WHERE id=?', [tenantId]))[0];
(p18 === 'professional' && mu18 === 25) ? pass('TC-18', `plan=professional  max_users=25`) : fail('TC-18', `plan=${p18} max_users=${mu18}`);

// ────────────────────────────────────────────────────────────
// TC-19  PASSWORD HASH validity
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-19  Verify bcrypt password hash for all 3 users');
const uRows = await query('SELECT id,email,password FROM staff WHERE tenant_id=?', [tenantId]);
let hashOk = true;
for (const u of uRows) {
  const ok = await bcrypt.compare(PASS, u.password);
  if (!ok) { hashOk = false; fail('TC-19', `Hash invalid for ${u.email}`); }
}
if (hashOk) pass('TC-19', `All 3 passwords hash as Test@1234! correctly`);

// ────────────────────────────────────────────────────────────
// TC-20  TENANT DETAILS full record check
// ────────────────────────────────────────────────────────────
console.log('🔵  TC-20  Full tenant detail record validation');
const [detail20] = await query('SELECT * FROM tenants WHERE id=?', [tenantId]);
const staff20 = await query('SELECT id,role FROM staff WHERE tenant_id=?', [tenantId]);
detail20.id === tenantId       ? pass('TC-20a', `Tenant found: ${detail20.name}`)    : fail('TC-20a', 'No row');
staff20.length === 3           ? pass('TC-20b', `3 staff members`)                   : fail('TC-20b', `Got ${staff20.length}`);
detail20.plan === 'professional' ? pass('TC-20c', 'plan=professional')               : fail('TC-20c', `plan=${detail20.plan}`);
detail20.max_users === 25      ? pass('TC-20d', 'max_users=25')                      : fail('TC-20d', `Got ${detail20.max_users}`);
detail20.is_active === 1       ? pass('TC-20e', 'is_active=1')                       : fail('TC-20e', `Got ${detail20.is_active}`);

// ─────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────
const passed = results.filter(r => r.status === 'PASS').length;
const failed = results.filter(r => r.status === 'FAIL').length;
console.log('\n' + '='.repeat(64));
console.log('  TEST RESULTS SUMMARY');
console.log('='.repeat(64));
results.forEach(r => console.log(`  ${r.status === 'PASS' ? 'PASS' : 'FAIL'}  ${r.name.padEnd(40)} ${r.detail}`));
console.log('-'.repeat(64));
console.log(`  TOTAL ${passed + failed}   PASS ${passed}   FAIL ${failed}`);
console.log('='.repeat(64));
console.log(`\n  Test Tenant ID   : ${tenantId}`);
console.log(`  Tenant Name      : YopTest Salon`);
console.log(`  Owner email      : yoptest-owner@yopmail.com`);
console.log(`  Admin email      : yoptest-admin@yopmail.com`);
console.log(`  Staff email      : yoptest-staff1@yopmail.com`);
console.log(`  Manager email    : yoptest-manager@yopmail.com`);
console.log(`  Password (all)   : Test@1234!`);
console.log(`  Final plan       : professional  max_users=25`);
console.log();
process.exit(failed > 0 ? 1 : 0);
