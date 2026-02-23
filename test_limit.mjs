// ============================================================
// TEST: max_users limit enforcement via live API
// Tests what actually happens when a tenant tries to add a
// user that would exceed their max_users cap.
// ============================================================
import bcrypt from 'bcryptjs';
import { query, execute } from './src/lib/database.js';

const BASE = 'http://localhost:4000/api';
const SA_LOGIN = { username: 'trasealla_admin', password: 'Trasealla@2025!' };

const pass = (name, detail = '') => console.log(`  ✅  ${name}${detail ? '  —  ' + detail : ''}`);
const fail = (name, detail = '') => { console.log(`  ❌  ${name}${detail ? '  —  ' + detail : ''}`); };

const results = [];
const ok   = (n, d = '') => { results.push({ s:'PASS', n, d }); pass(n, d); };
const nok  = (n, d = '') => { results.push({ s:'FAIL', n, d }); fail(n, d); };

// ── helpers ───────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// ── SETUP: clean stale data ────────────────────────────────
console.log('\n📦  CLEANUP...');
const stale = await query("SELECT id FROM tenants WHERE slug LIKE 'limit-test-%'");
for (const t of stale) {
  await execute('DELETE FROM staff WHERE tenant_id=?', [t.id]);
  await execute('DELETE FROM tenants WHERE id=?', [t.id]);
}
console.log(`   Removed ${stale.length} stale tenant(s)\n`);

// ── STEP 1: create tenant with max_users=2 ─────────────────
console.log('🔵  STEP 1  Create test tenant (max_users=2)');
const slug = `limit-test-${Date.now()}`;
const hash = await bcrypt.hash('Pass@1234!', 12);

const { insertId: tenantId } = await execute(
  `INSERT INTO tenants (name,slug,email,status,plan,max_users,billing_email,is_active,created_at)
   VALUES (?,?,?,'trial','trial',2,?,1,NOW())`,
  ['LimitTest Salon', slug, 'limitowner@yopmail.com', 'limitowner@yopmail.com']
);
console.log(`   Tenant id=${tenantId}  max_users=2\n`);

// ── STEP 2: log in as super-admin, then create tenant admin ─
console.log('🔵  STEP 2  Get super-admin token');
const saLogin = await apiFetch('/super-admin/login', { method: 'POST', body: SA_LOGIN });
const saToken = saLogin.body.token;
saToken ? ok('SA-login', `${saToken.length} chars`) : nok('SA-login', 'no token');

// Create the tenant's first admin directly in DB (simulates onboarding):
await execute(
  `INSERT INTO staff (tenant_id,username,email,password,full_name,role,is_active,created_at)
   VALUES (?,?,?,?,?,'admin',1,NOW())`,
  [tenantId, 'lt_admin', 'lt-admin@yopmail.com', hash, 'LimitTest Admin']
);

// Log in as that tenant admin to get a tenant JWT
console.log('\n🔵  STEP 3  Log in as tenant admin');
const tenantLogin = await apiFetch('/auth/login', { method: 'POST', body: { username: 'lt-admin@yopmail.com', password: 'Pass@1234!' } });
const tenantToken = tenantLogin.body.token || tenantLogin.body.data?.token;
tenantToken
  ? ok('Tenant-login', `HTTP ${tenantLogin.status}`)
  : nok('Tenant-login', `HTTP ${tenantLogin.status}  ${JSON.stringify(tenantLogin.body).slice(0, 120)}`);

const authH = { Authorization: `Bearer ${tenantToken}` };

// ── STEP 4: add user #2 (should succeed — only 1 active now) ─
console.log('\n🔵  STEP 4  Add user #2 (1/2 used → should succeed)');
const r4 = await apiFetch('/staff', {
  method: 'POST',
  headers: authH,
  body: { full_name: 'LT Staff One', email: 'lt-staff1@yopmail.com', password: 'Pass@1234!', role: 'staff' }
});
[200, 201].includes(r4.status)
  ? ok('TC-ADD-2nd-user', `HTTP ${r4.status}  ${r4.body.message || ''}`)
  : nok('TC-ADD-2nd-user', `HTTP ${r4.status}  ${r4.body.message || JSON.stringify(r4.body).slice(0, 100)}`);

// ── STEP 5: add user #3 — should hit 403 ──────────────────
console.log('\n🔵  STEP 5  Add user #3 (2/2 used → should get 403)');
const r5 = await apiFetch('/staff', {
  method: 'POST',
  headers: authH,
  body: { full_name: 'LT Staff Two', email: 'lt-staff2@yopmail.com', password: 'Pass@1234!', role: 'staff' }
});
console.log(`   HTTP ${r5.status}  →  ${r5.body.message || JSON.stringify(r5.body)}`);
if (r5.status === 403) {
  ok('TC-LIMIT-ENFORCE', `HTTP 403 returned — "${r5.body.message}"`);
} else if (r5.status === 201) {
  nok('TC-LIMIT-ENFORCE', `HTTP 201 — guard DID NOT fire (user was created despite being over limit!)`);
} else {
  nok('TC-LIMIT-ENFORCE', `Unexpected HTTP ${r5.status} — ${r5.body.message}`);
}

// ── STEP 6: verify DB — user #3 should NOT exist ──────────
console.log('\n🔵  STEP 6  Verify 3rd user was NOT inserted in DB');
const [{ cnt }] = await query('SELECT COUNT(*) AS cnt FROM staff WHERE tenant_id=? AND is_active=1', [tenantId]);
console.log(`   Active staff in DB for this tenant: ${cnt}`);
cnt <= 2
  ? ok('TC-DB-COUNT', `Only ${cnt} active user(s) in DB — guard held`)
  : nok('TC-DB-COUNT', `${cnt} active users in DB — extra user slipped through!`);

// ── STEP 7: upgrade max_users to 3, retry ─────────────────
console.log('\n🔵  STEP 7  Upgrade max_users → 3, then retry adding user #3');
await execute('UPDATE tenants SET max_users=3 WHERE id=?', [tenantId]);

const r7 = await apiFetch('/staff', {
  method: 'POST',
  headers: authH,
  body: { full_name: 'LT Staff Two', email: 'lt-staff2@yopmail.com', password: 'Pass@1234!', role: 'staff' }
});
console.log(`   HTTP ${r7.status}  →  ${r7.body.message || JSON.stringify(r7.body).slice(0, 80)}`);
[200, 201].includes(r7.status)
  ? ok('TC-POST-UPGRADE', `HTTP ${r7.status} after upgrade — 3rd user created successfully`)
  : nok('TC-POST-UPGRADE', `HTTP ${r7.status} — user should have been allowed after upgrade`);

// ── STEP 8: at new limit (3/3), try adding #4 ─────────────
console.log('\n🔵  STEP 8  At new limit (3/3), try adding user #4 → should get 403 again');
const r8 = await apiFetch('/staff', {
  method: 'POST',
  headers: authH,
  body: { full_name: 'LT Staff Three', email: 'lt-staff3@yopmail.com', password: 'Pass@1234!', role: 'staff' }
});
console.log(`   HTTP ${r8.status}  →  ${r8.body.message || JSON.stringify(r8.body)}`);
r8.status === 403
  ? ok('TC-LIMIT-RECHECK', `HTTP 403 again at new limit of 3 — "${r8.body.message}"`)
  : nok('TC-LIMIT-RECHECK', `HTTP ${r8.status} — expected 403`);

// ── STEP 9: verify final DB count ─────────────────────────
console.log('\n🔵  STEP 9  Final DB user count check');
const [{ cnt: final }] = await query('SELECT COUNT(*) AS cnt FROM staff WHERE tenant_id=? AND is_active=1', [tenantId]);
console.log(`   Final active staff in DB: ${final}`);
final === 3
  ? ok('TC-FINAL-COUNT', `Exactly 3 active users — matches max_users=3`)
  : nok('TC-FINAL-COUNT', `Expected 3, got ${final}`);

// ── SUMMARY ───────────────────────────────────────────────
const p = results.filter(r => r.s === 'PASS').length;
const f = results.filter(r => r.s === 'FAIL').length;
console.log('\n' + '='.repeat(64));
console.log('  LIMIT ENFORCEMENT TEST RESULTS');
console.log('='.repeat(64));
results.forEach(r => console.log(`  ${r.s}  ${r.n.padEnd(30)} ${r.d}`));
console.log('-'.repeat(64));
console.log(`  TOTAL ${p + f}   PASS ${p}   FAIL ${f}`);
console.log('='.repeat(64) + '\n');
process.exit(f > 0 ? 1 : 0);
