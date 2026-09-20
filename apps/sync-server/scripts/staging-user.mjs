#!/usr/bin/env node
// Test-account helper for REMOTE staging. Never touches production.
//
//   pnpm staging:user <email>             -> delete the account from staging (D1 rows + its R2 blobs)
//   pnpm staging:user <email> --believer  -> grant a lifetime believer entitlement (admin_override)
//
// Delete mirrors services/account-deletion.ts (child rows before `users`).
// Grant mirrors services/entitlements.ts upsertSyncEntitlement + SYNC_PLAN_LIMITS.believer.

import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SYNC_SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

// Hardcoded so a misread config can never redirect this at production.
const ENV = 'staging'
const DB_NAME = 'memry-sync-staging'
const BUCKET = 'memry-encrypted-blobs-staging'
if (DB_NAME.includes('production') || ENV !== 'staging') {
  console.error('Refusing to run: target is not staging.')
  process.exit(1)
}

const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024
const BELIEVER = { storage: 50 * GIB, maxFileSize: 200 * MIB, versionHistoryDays: 365 }

const args = process.argv.slice(2)
// '--beilever' is a frequent typo; accept it instead of silently falling through to delete.
const GRANT = args.includes('--believer') || args.includes('--beilever')
const EMAIL = args.find((a) => !a.startsWith('--'))?.toLowerCase()
if (!EMAIL) {
  console.error('Usage: pnpm staging:user <email> [--believer]')
  process.exit(1)
}

function wrangler(wranglerArgs, { capture = false } = {}) {
  const result = spawnSync('wrangler', wranglerArgs, {
    cwd: SYNC_SERVER_DIR,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`wrangler ${wranglerArgs.join(' ')} exited with ${result.status}`)
  }
  return result.stdout ?? ''
}

function d1(sql, { capture = true } = {}) {
  const flags = ['d1', 'execute', DB_NAME, '--env', ENV, '--remote', '--yes', '--command', sql]
  if (!capture) return wrangler(flags)
  const out = wrangler([...flags, '--json'], { capture: true })
  const start = out.indexOf('[')
  if (start === -1) return []
  try {
    return JSON.parse(out.slice(start)).flatMap((r) => r.results ?? [])
  } catch {
    throw new Error(`Could not parse wrangler d1 JSON output:\n${out}`)
  }
}

const sqlStr = (value) => `'${String(value).replace(/'/g, "''")}'`

const user = d1(`SELECT id, email FROM users WHERE lower(email) = ${sqlStr(EMAIL)}`)[0]
if (!user) {
  console.log(`No staging account for ${EMAIL}. Nothing to do.`)
  process.exit(0)
}
const id = sqlStr(user.id)
const now = Math.floor(Date.now() / 1000)

if (GRANT) {
  d1(
    `INSERT INTO sync_entitlements (user_id, plan, cadence, status, source, storage_limit,
       max_file_size, max_vaults, version_history_days, expires_at, updated_at)
     VALUES (${id}, 'believer', 'lifetime', 'active', 'admin_override', ${BELIEVER.storage},
       ${BELIEVER.maxFileSize}, NULL, ${BELIEVER.versionHistoryDays}, NULL, ${now})
     ON CONFLICT(user_id) DO UPDATE SET
       plan = 'believer', cadence = 'lifetime', status = 'active', source = 'admin_override',
       storage_limit = ${BELIEVER.storage}, max_file_size = ${BELIEVER.maxFileSize},
       max_vaults = NULL, version_history_days = ${BELIEVER.versionHistoryDays},
       expires_at = NULL, updated_at = ${now};
     UPDATE users SET storage_limit = ${BELIEVER.storage}, updated_at = ${now} WHERE id = ${id};`,
    { capture: false }
  )
  console.log(`Granted believer (lifetime, admin_override) to ${EMAIL} on staging.`)
  process.exit(0)
}

// --- delete ---------------------------------------------------------------
// R2 keys must be read before the rows that reference them are deleted.
const keys = d1(
  `SELECT blob_key AS k FROM sync_items WHERE user_id = ${id} AND blob_key IS NOT NULL
   UNION SELECT blob_key FROM crdt_snapshots WHERE user_id = ${id} AND blob_key IS NOT NULL
   UNION SELECT r2_key FROM upload_sessions WHERE user_id = ${id} AND r2_key IS NOT NULL
   UNION SELECT r2_key FROM blob_chunks WHERE user_id = ${id} AND r2_key IS NOT NULL`
)
  .map((r) => r.k)
  .filter((k) => typeof k === 'string' && k.length)

console.log(`R2: deleting ${keys.length} object(s)...`)
for (const key of keys) {
  // ponytail: serial deletes; parallelize if a test account ever holds thousands of blobs.
  const res = spawnSync('wrangler', ['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote'], {
    cwd: SYNC_SERVER_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe']
  })
  if (res.status !== 0) console.warn(`  ! failed to delete ${key}: ${res.stderr?.trim()}`)
}

// Same order as services/account-deletion.ts: children before the `users` parent.
const tables = [
  'google_calendar_channels',
  'crdt_updates',
  'crdt_snapshots',
  'upload_sessions',
  'blob_chunks',
  'device_sync_state',
  'sync_items',
  'server_cursor_sequence',
  'linking_sessions',
  'refresh_tokens',
  'sync_entitlements',
  'sync_vaults',
  'consumed_setup_tokens',
  'devices',
  'user_identities'
]
d1(
  [
    ...tables.map((t) => `DELETE FROM ${t} WHERE user_id = ${id};`),
    `DELETE FROM otp_codes WHERE email = ${sqlStr(user.email)};`,
    `DELETE FROM users WHERE id = ${id};`
  ].join('\n'),
  { capture: false }
)

console.log(`Deleted ${EMAIL} (${user.id}) from staging.`)
