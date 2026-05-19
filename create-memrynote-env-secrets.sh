#!/usr/bin/env bash
set -euo pipefail
set +x

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYNC_DIR="$ROOT/apps/sync-server"
LANDING_DIR="$ROOT/apps/landing"
BW_FOLDER_NAME="Memrynote"
MODE="${1:-create}"

managed_keys=(
  JWT_PUBLIC_KEY
  JWT_PRIVATE_KEY
  OTP_HMAC_KEY
  RECOVERY_DUMMY_SECRET
  WEBHOOK_HMAC_KEY
  PADDLE_CHECKOUT_TOKEN_SECRET
  TELEMETRY_HMAC_KEY
)

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

usage() {
  cat <<'EOF'
Usage:
  ./create-memrynote-env-secrets.sh
  ./create-memrynote-env-secrets.sh cloudflare-only
  ./create-memrynote-env-secrets.sh vercel-only

Default mode generates fresh custom secrets, stores one Bitwarden secure-note item
per secret key in the Memrynote folder, uploads them to Cloudflare by env, and
writes the shared checkout token to Vercel when the landing project is linked.

Bitwarden item shape:
  Item name: OTP_HMAC_KEY
  Custom fields:
    staging: <secret value>
    production: <secret value>

cloudflare-only mode reads existing Bitwarden items and uploads them to
Cloudflare staging and production without generating new values.

vercel-only mode reads the PADDLE_CHECKOUT_TOKEN_SECRET Bitwarden item and writes
the staging field to Vercel Preview and the production field to Vercel Production.
EOF
}

is_vercel_linked() {
  if [ -f "$LANDING_DIR/.vercel/project.json" ]; then
    return 0
  fi

  if [ -f "$ROOT/.vercel/repo.json" ] &&
    jq -e '.projects[]? | select(.directory == "apps/landing")' "$ROOT/.vercel/repo.json" >/dev/null; then
    return 0
  fi

  return 1
}

print_vercel_link_hint() {
  cat >&2 <<EOF
Vercel project is not linked at:
  $LANDING_DIR/.vercel/project.json
  or $ROOT/.vercel/repo.json for apps/landing

Run this once, then rerun this script:
  cd "$LANDING_DIR"
  npx vercel@latest link
EOF
}

ensure_vercel_linked() {
  if is_vercel_linked; then
    return
  fi

  print_vercel_link_hint
  exit 1
}

need bw
need jq
need node
need pnpm
need npx

bw_status="$(bw status | jq -r '.status')"
case "$bw_status" in
  unlocked)
    ;;
  locked)
    export BW_SESSION="$(bw unlock --raw)"
    ;;
  unauthenticated)
    echo "Bitwarden is not logged in. Run: bw login" >&2
    exit 1
    ;;
  *)
    echo "Unknown Bitwarden status: $bw_status" >&2
    exit 1
    ;;
esac

bw sync >/dev/null

folder_id="$(
  bw list folders --search "$BW_FOLDER_NAME" \
    | jq -r --arg name "$BW_FOLDER_NAME" 'first(.[] | select(.name == $name) | .id) // ""'
)"

if [ -z "$folder_id" ]; then
  folder_json="$(
    bw get template folder \
      | jq --arg name "$BW_FOLDER_NAME" '.name = $name' \
      | bw encode \
      | bw create folder
  )"
  folder_id="$(printf '%s' "$folder_json" | jq -r '.id')"
fi

find_secret_item_id() {
  name="$1"

  bw list items --search "$name" \
    | jq -r --arg name "$name" --arg folderId "$folder_id" \
      'first(.[] | select(.name == $name and .folderId == $folderId) | .id) // ""'
}

assert_items_absent() {
  for key in "${managed_keys[@]}"; do
    existing_id="$(find_secret_item_id "$key")"
    if [ -n "$existing_id" ]; then
      echo "Bitwarden item already exists in $BW_FOLDER_NAME: $key ($existing_id)" >&2
      echo "Refusing to overwrite or rotate existing values." >&2
      exit 1
    fi
  done
}

make_value() {
  node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
}

make_jwt_pair() {
  node <<'NODE'
const { generateKeyPairSync } = require('crypto')

const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const oneLine = (value) => value.replace(/\n/g, '\\n')

console.log(JSON.stringify({
  publicKey: oneLine(publicKey),
  privateKey: oneLine(privateKey),
}))
NODE
}

create_bw_item() {
  key="$1"
  staging_value="$2"
  production_value="$3"
  source_note="$4"

  existing_id="$(find_secret_item_id "$key")"
  if [ -n "$existing_id" ]; then
    echo "Bitwarden item already exists in $BW_FOLDER_NAME: $key ($existing_id)" >&2
    exit 1
  fi

  bw get template item \
    | jq \
      --arg name "$key" \
      --arg folderId "$folder_id" \
      --arg notes "$source_note" \
      --arg staging "$staging_value" \
      --arg production "$production_value" \
      '.type = 2
       | .secureNote.type = 0
       | .name = $name
       | .folderId = $folderId
       | .notes = $notes
       | .fields = [
          { name: "staging", value: $staging, type: 1 },
          { name: "production", value: $production, type: 1 }
        ]' \
    | bw encode \
    | bw create item >/dev/null

  echo "Stored Bitwarden item: $BW_FOLDER_NAME / $key"
}

validate_payload() {
  payload="$1"

  for key in "${managed_keys[@]}"; do
    staging_value="$(printf '%s' "$payload" | jq -r --arg key "$key" '.staging[$key]')"
    production_value="$(printf '%s' "$payload" | jq -r --arg key "$key" '.production[$key]')"

    if [ -z "$staging_value" ] || [ "$staging_value" = "null" ]; then
      echo "Missing staging value for $key" >&2
      exit 1
    fi

    if [ -z "$production_value" ] || [ "$production_value" = "null" ]; then
      echo "Missing production value for $key" >&2
      exit 1
    fi
  done
}

create_bw_items_from_payload() {
  payload="$1"
  source_note="$2"

  validate_payload "$payload"
  assert_items_absent

  for key in "${managed_keys[@]}"; do
    staging_value="$(printf '%s' "$payload" | jq -r --arg key "$key" '.staging[$key]')"
    production_value="$(printf '%s' "$payload" | jq -r --arg key "$key" '.production[$key]')"
    create_bw_item "$key" "$staging_value" "$production_value" "$source_note"
  done
}

field_from_item() {
  item_json="$1"
  env_name="$2"

  printf '%s' "$item_json" \
    | jq -r --arg env "$env_name" 'first(.fields[]? | select(.name == $env) | .value) // ""'
}

field_from_bw_item_name() {
  key="$1"
  env_name="$2"
  item_id="$(find_secret_item_id "$key")"

  if [ -z "$item_id" ]; then
    echo "Missing Bitwarden item in $BW_FOLDER_NAME: $key" >&2
    exit 1
  fi

  item_json="$(bw get item "$item_id")"
  value="$(field_from_item "$item_json" "$env_name")"

  if [ -z "$value" ] || [ "$value" = "null" ]; then
    echo "Missing $env_name custom field on Bitwarden item: $key" >&2
    exit 1
  fi

  printf '%s' "$value"
}

add_vercel_checkout_values() {
  staging_value_arg="$1"
  production_value_arg="$2"

  ensure_vercel_linked
  cd "$LANDING_DIR"

  printf '%s' "$staging_value_arg" \
    | npx vercel@latest env add PADDLE_CHECKOUT_TOKEN_SECRET preview "" --yes --force

  printf '%s' "$production_value_arg" \
    | npx vercel@latest env add PADDLE_CHECKOUT_TOKEN_SECRET production --yes --force
}

maybe_add_vercel_checkout_values() {
  staging_value_arg="$1"
  production_value_arg="$2"

  if ! is_vercel_linked; then
    echo "Skipped Vercel checkout values because apps/landing is not linked."
    print_vercel_link_hint
    echo "After linking, run: ./create-memrynote-env-secrets.sh vercel-only"
    return
  fi

  add_vercel_checkout_values "$staging_value_arg" "$production_value_arg"
}

put_cf() {
  env_name="$1"
  key="$2"
  value="$3"

  cd "$SYNC_DIR"
  printf '%s' "$value" | pnpm exec wrangler secret put "$key" --env "$env_name"
}

put_cloudflare_from_payload() {
  payload="$1"

  validate_payload "$payload"

  for key in "${managed_keys[@]}"; do
    staging_value="$(printf '%s' "$payload" | jq -r --arg key "$key" '.staging[$key]')"
    production_value="$(printf '%s' "$payload" | jq -r --arg key "$key" '.production[$key]')"
    put_cf staging "$key" "$staging_value"
    put_cf production "$key" "$production_value"
  done
}

payload_from_bw_items() {
  jq -n \
    --arg stagingJwtPublic "$(field_from_bw_item_name JWT_PUBLIC_KEY staging)" \
    --arg stagingJwtPrivate "$(field_from_bw_item_name JWT_PRIVATE_KEY staging)" \
    --arg stagingOtp "$(field_from_bw_item_name OTP_HMAC_KEY staging)" \
    --arg stagingRecovery "$(field_from_bw_item_name RECOVERY_DUMMY_SECRET staging)" \
    --arg stagingWebhook "$(field_from_bw_item_name WEBHOOK_HMAC_KEY staging)" \
    --arg stagingCheckout "$(field_from_bw_item_name PADDLE_CHECKOUT_TOKEN_SECRET staging)" \
    --arg stagingTelemetry "$(field_from_bw_item_name TELEMETRY_HMAC_KEY staging)" \
    --arg productionJwtPublic "$(field_from_bw_item_name JWT_PUBLIC_KEY production)" \
    --arg productionJwtPrivate "$(field_from_bw_item_name JWT_PRIVATE_KEY production)" \
    --arg productionOtp "$(field_from_bw_item_name OTP_HMAC_KEY production)" \
    --arg productionRecovery "$(field_from_bw_item_name RECOVERY_DUMMY_SECRET production)" \
    --arg productionWebhook "$(field_from_bw_item_name WEBHOOK_HMAC_KEY production)" \
    --arg productionCheckout "$(field_from_bw_item_name PADDLE_CHECKOUT_TOKEN_SECRET production)" \
    --arg productionTelemetry "$(field_from_bw_item_name TELEMETRY_HMAC_KEY production)" \
    '{
      staging: {
        "JWT_PUBLIC_KEY": $stagingJwtPublic,
        "JWT_PRIVATE_KEY": $stagingJwtPrivate,
        "OTP_HMAC_KEY": $stagingOtp,
        "RECOVERY_DUMMY_SECRET": $stagingRecovery,
        "WEBHOOK_HMAC_KEY": $stagingWebhook,
        "PADDLE_CHECKOUT_TOKEN_SECRET": $stagingCheckout,
        "TELEMETRY_HMAC_KEY": $stagingTelemetry
      },
      production: {
        "JWT_PUBLIC_KEY": $productionJwtPublic,
        "JWT_PRIVATE_KEY": $productionJwtPrivate,
        "OTP_HMAC_KEY": $productionOtp,
        "RECOVERY_DUMMY_SECRET": $productionRecovery,
        "WEBHOOK_HMAC_KEY": $productionWebhook,
        "PADDLE_CHECKOUT_TOKEN_SECRET": $productionCheckout,
        "TELEMETRY_HMAC_KEY": $productionTelemetry
      }
    }'
}

if [ "$MODE" = "cloudflare-only" ]; then
  existing_payload="$(payload_from_bw_items)"
  put_cloudflare_from_payload "$existing_payload"
  echo "Done. Cloudflare staging and production values were written from Bitwarden."
  exit 0
fi

if [ "$MODE" = "vercel-only" ]; then
  staging_checkout_value="$(field_from_bw_item_name PADDLE_CHECKOUT_TOKEN_SECRET staging)"
  production_checkout_value="$(field_from_bw_item_name PADDLE_CHECKOUT_TOKEN_SECRET production)"

  add_vercel_checkout_values "$staging_checkout_value" "$production_checkout_value"
  echo "Done. Vercel checkout values were written from Bitwarden."
  exit 0
fi

if [ "$MODE" != "create" ]; then
  usage >&2
  exit 1
fi

assert_items_absent

staging_jwt="$(make_jwt_pair)"
production_jwt="$(make_jwt_pair)"
created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

payload_values="$(
  jq -n \
    --arg stagingJwtPublic "$(printf '%s' "$staging_jwt" | jq -r '.publicKey')" \
    --arg stagingJwtPrivate "$(printf '%s' "$staging_jwt" | jq -r '.privateKey')" \
    --arg stagingOtp "$(make_value)" \
    --arg stagingRecovery "$(make_value)" \
    --arg stagingWebhook "$(make_value)" \
    --arg stagingCheckout "$(make_value)" \
    --arg stagingTelemetry "$(make_value)" \
    --arg productionJwtPublic "$(printf '%s' "$production_jwt" | jq -r '.publicKey')" \
    --arg productionJwtPrivate "$(printf '%s' "$production_jwt" | jq -r '.privateKey')" \
    --arg productionOtp "$(make_value)" \
    --arg productionRecovery "$(make_value)" \
    --arg productionWebhook "$(make_value)" \
    --arg productionCheckout "$(make_value)" \
    --arg productionTelemetry "$(make_value)" \
    '{
      staging: {
        "JWT_PUBLIC_KEY": $stagingJwtPublic,
        "JWT_PRIVATE_KEY": $stagingJwtPrivate,
        "OTP_HMAC_KEY": $stagingOtp,
        "RECOVERY_DUMMY_SECRET": $stagingRecovery,
        "WEBHOOK_HMAC_KEY": $stagingWebhook,
        "PADDLE_CHECKOUT_TOKEN_SECRET": $stagingCheckout,
        "TELEMETRY_HMAC_KEY": $stagingTelemetry
      },
      production: {
        "JWT_PUBLIC_KEY": $productionJwtPublic,
        "JWT_PRIVATE_KEY": $productionJwtPrivate,
        "OTP_HMAC_KEY": $productionOtp,
        "RECOVERY_DUMMY_SECRET": $productionRecovery,
        "WEBHOOK_HMAC_KEY": $productionWebhook,
        "PADDLE_CHECKOUT_TOKEN_SECRET": $productionCheckout,
        "TELEMETRY_HMAC_KEY": $productionTelemetry
      }
    }'
)"

create_bw_items_from_payload \
  "$payload_values" \
  "Generated by create-memrynote-env-secrets.sh at $created_at."

put_cloudflare_from_payload "$payload_values"

maybe_add_vercel_checkout_values \
  "$(printf '%s' "$payload_values" | jq -r '.staging.PADDLE_CHECKOUT_TOKEN_SECRET')" \
  "$(printf '%s' "$payload_values" | jq -r '.production.PADDLE_CHECKOUT_TOKEN_SECRET')"

echo "Done. Provider values still manual: RESEND_API_KEY, PADDLE_WEBHOOK_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, Paddle API/client tokens, price IDs."
