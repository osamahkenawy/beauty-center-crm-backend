#!/usr/bin/env bash
set -euo pipefail

BASE="${BASE_URL:-http://localhost:4000/api}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-admin123}"

json_get() {
  local expr="$1"
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=($expr);process.stdout.write(v==null?'':String(v));}catch{process.stdout.write('')}})"
}

ADMIN_TOKEN=$(curl -sS -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" | json_get "j.token")

if [[ -z "$ADMIN_TOKEN" ]]; then
  echo "SMOKE_FAIL: admin login failed"
  exit 1
fi

TS=$(date +%s)
STAFF_USER="smoke_staff_${TS}"
STAFF_PASS="Smoke123!"
STAFF_EMAIL="${STAFF_USER}@yopmail.com"
CLIENT_EMAIL="smoke_client_${TS}@yopmail.com"
SERVICE_NAME="Smoke Service ${TS}"

check_pdf() {
  local endpoint="$1"
  local body head code sig
  body=$(mktemp)
  head=$(mktemp)

  code=$(curl -sS -o "$body" -D "$head" -w "%{http_code}" \
    "$BASE/$endpoint" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H 'Accept: application/pdf')

  sig=$(dd if="$body" bs=1 count=4 2>/dev/null || true)
  if [[ "$code" != "200" || "$sig" != "%PDF" ]]; then
    echo "SMOKE_FAIL: PDF check failed for /$endpoint (status=$code, sig=$sig)"
    rm -f "$body" "$head"
    exit 1
  fi

  rm -f "$body" "$head"
}

CREATE_STAFF=$(curl -sS -X POST "$BASE/staff" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$STAFF_USER\",\"email\":\"$STAFF_EMAIL\",\"password\":\"$STAFF_PASS\",\"full_name\":\"Smoke Staff ${TS}\",\"phone\":\"+971501234567\",\"role\":\"staff\",\"send_invite\":false}")

STAFF_ID=$(echo "$CREATE_STAFF" | json_get "j.data?.id")
if [[ -z "$STAFF_ID" ]]; then
  echo "SMOKE_FAIL: create staff failed -> $CREATE_STAFF"
  exit 1
fi

STAFF_TOKEN=$(curl -sS -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$STAFF_USER\",\"password\":\"$STAFF_PASS\"}" | json_get "j.token")
if [[ -z "$STAFF_TOKEN" ]]; then
  echo "SMOKE_FAIL: staff login failed"
  exit 1
fi

PATCH_STAFF=$(curl -sS -X PATCH "$BASE/staff/$STAFF_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"job_title":"Smoke QA Stylist"}')
PATCH_STAFF_OK=$(echo "$PATCH_STAFF" | json_get "j.success")
if [[ "$PATCH_STAFF_OK" != "true" ]]; then
  echo "SMOKE_FAIL: patch staff failed -> $PATCH_STAFF"
  exit 1
fi

CREATE_CLIENT=$(curl -sS -X POST "$BASE/contacts" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"first_name\":\"Smoke\",\"last_name\":\"Client ${TS}\",\"email\":\"$CLIENT_EMAIL\",\"phone\":\"+971509999999\",\"source\":\"walk-in\"}")

CLIENT_ID=$(echo "$CREATE_CLIENT" | json_get "j.data?.id")
if [[ -z "$CLIENT_ID" ]]; then
  echo "SMOKE_FAIL: create client failed -> $CREATE_CLIENT"
  exit 1
fi

LIST_CLIENT=$(curl -sS "$BASE/contacts?search=$CLIENT_EMAIL" -H "Authorization: Bearer $ADMIN_TOKEN")
FOUND_CLIENT=$(echo "$LIST_CLIENT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const ok=(j.data||[]).some(c=>String(c.id)==='$CLIENT_ID');process.stdout.write(ok?'true':'false')}catch{process.stdout.write('false')}})")
if [[ "$FOUND_CLIENT" != "true" ]]; then
  echo "SMOKE_FAIL: list/search client failed -> $LIST_CLIENT"
  exit 1
fi

PATCH_CLIENT=$(curl -sS -X PATCH "$BASE/contacts/$CLIENT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"notes":"Smoke test updated note","status":"active"}')
PATCH_CLIENT_OK=$(echo "$PATCH_CLIENT" | json_get "j.success")
if [[ "$PATCH_CLIENT_OK" != "true" ]]; then
  echo "SMOKE_FAIL: patch client failed -> $PATCH_CLIENT"
  exit 1
fi

CREATE_SERVICE=$(curl -sS -X POST "$BASE/products" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$SERVICE_NAME\",\"unit_price\":120,\"currency\":\"AED\",\"duration\":60,\"is_active\":true}")
SERVICE_ID=$(echo "$CREATE_SERVICE" | json_get "j.data?.id")
if [[ -z "$SERVICE_ID" ]]; then
  echo "SMOKE_FAIL: create service failed -> $CREATE_SERVICE"
  exit 1
fi

START_TIME=$(node -e "const d=new Date(Date.now()+24*60*60*1000);d.setHours(10,0,0,0);process.stdout.write(d.toISOString())")
END_TIME=$(node -e "const d=new Date(Date.now()+24*60*60*1000);d.setHours(11,0,0,0);process.stdout.write(d.toISOString())")

CREATE_APPOINTMENT=$(curl -sS -X POST "$BASE/appointments" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"customer_id\":$CLIENT_ID,\"service_id\":$SERVICE_ID,\"staff_id\":$STAFF_ID,\"start_time\":\"$START_TIME\",\"end_time\":\"$END_TIME\",\"notes\":\"Smoke test appointment\"}")
APPOINTMENT_ID=$(echo "$CREATE_APPOINTMENT" | json_get "j.data?.id")
if [[ -z "$APPOINTMENT_ID" ]]; then
  echo "SMOKE_FAIL: create appointment failed -> $CREATE_APPOINTMENT"
  exit 1
fi

CREATE_INVOICE=$(curl -sS -X POST "$BASE/invoices" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"customer_id\":$CLIENT_ID,\"staff_id\":$STAFF_ID,\"appointment_id\":$APPOINTMENT_ID,\"status\":\"sent\",\"items\":[{\"item_type\":\"service\",\"item_id\":$SERVICE_ID,\"name\":\"$SERVICE_NAME\",\"quantity\":1,\"unit_price\":120,\"discount\":0}],\"tax_rate\":5,\"discount_amount\":0}")
INVOICE_ID=$(echo "$CREATE_INVOICE" | json_get "j.data?.id")
INVOICE_TOTAL=$(echo "$CREATE_INVOICE" | json_get "j.data?.total")
if [[ -z "$INVOICE_ID" || -z "$INVOICE_TOTAL" ]]; then
  echo "SMOKE_FAIL: create invoice failed -> $CREATE_INVOICE"
  exit 1
fi

PAY_INVOICE=$(curl -sS -X POST "$BASE/invoices/$INVOICE_ID/pay" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"amount\":$INVOICE_TOTAL,\"payment_method\":\"cash\"}")
PAY_OK=$(echo "$PAY_INVOICE" | json_get "j.success")
if [[ "$PAY_OK" != "true" ]]; then
  echo "SMOKE_FAIL: pay invoice failed -> $PAY_INVOICE"
  exit 1
fi

check_pdf "invoices/$INVOICE_ID/pdf"
check_pdf "invoices/$INVOICE_ID/receipt-pdf"

DELETE_APPOINTMENT=$(curl -sS -X DELETE "$BASE/appointments/$APPOINTMENT_ID" -H "Authorization: Bearer $ADMIN_TOKEN")
DELETE_APPOINTMENT_OK=$(echo "$DELETE_APPOINTMENT" | json_get "j.success")
if [[ "$DELETE_APPOINTMENT_OK" != "true" ]]; then
  echo "SMOKE_FAIL: delete appointment failed -> $DELETE_APPOINTMENT"
  exit 1
fi

DELETE_CLIENT=$(curl -sS -X DELETE "$BASE/contacts/$CLIENT_ID" -H "Authorization: Bearer $ADMIN_TOKEN")
DELETE_CLIENT_OK=$(echo "$DELETE_CLIENT" | json_get "j.success")
if [[ "$DELETE_CLIENT_OK" != "true" ]]; then
  echo "SMOKE_FAIL: delete client failed -> $DELETE_CLIENT"
  exit 1
fi

DELETE_SERVICE=$(curl -sS -X DELETE "$BASE/products/$SERVICE_ID" -H "Authorization: Bearer $ADMIN_TOKEN")
DELETE_SERVICE_OK=$(echo "$DELETE_SERVICE" | json_get "j.success")
if [[ "$DELETE_SERVICE_OK" != "true" ]]; then
  echo "SMOKE_FAIL: delete service failed -> $DELETE_SERVICE"
  exit 1
fi

DELETE_STAFF=$(curl -sS -X DELETE "$BASE/staff/$STAFF_ID" -H "Authorization: Bearer $ADMIN_TOKEN")
DELETE_STAFF_OK=$(echo "$DELETE_STAFF" | json_get "j.success")
if [[ "$DELETE_STAFF_OK" != "true" ]]; then
  echo "SMOKE_FAIL: delete staff failed -> $DELETE_STAFF"
  exit 1
fi

echo "SMOKE_PASS"
echo "staff_email=$STAFF_EMAIL"
echo "client_email=$CLIENT_EMAIL"
echo "staff_id=$STAFF_ID"
echo "client_id=$CLIENT_ID"
echo "service_id=$SERVICE_ID"
echo "appointment_id=$APPOINTMENT_ID"
echo "invoice_id=$INVOICE_ID"
