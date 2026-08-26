#!/usr/bin/env node
// Reset the REMOTE staging sync backend to a fresh state.
//
//   D1   memry-sync-staging          -> drop all tables, re-apply schema/d1.sql (same id)
//   R2   memry-encrypted-blobs-staging -> delete every object referenced by staging D1
//   DO   memry-sync-server-staging   -> redeploy to restart UserSyncState/LinkingSession isolates
//
// Pure wrangler CLI. R2 keys are read from D1 (sync_items/crdt_snapshots/upload_sessions/
// blob_chunks) so we only ever touch staging's own blobs even though dev shares the bucket.
//
// Usage: pnpm sync:reset:staging [--yes] [--no-redeploy]

import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SYNC_SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const SCHEMA_FILE = join(SYNC_SERVER_DIR, 'schema', 'd1.sql')

// Mirrors [env.staging] in wrangler.toml. Hardcoded so a misread config can never
// redirect this destructive script at production.
const ENV = 'staging'
const DB_NAME = 'memry-sync-staging'
const BUCKET = 'memry-encrypted-blobs-staging'
const WORKER = 'memry-sync-server-staging'

const R2_DELETE_CONCURRENCY = 8

const args = process.argv.slice(2)
const SKIP_CONFIRM = args.includes('--yes') || args.includes('-y')
const REDEPLOY = !args.includes('--no-redeploy')

// Belt-and-suspenders: never run against anything that isn't staging.
if (DB_NAME.includes('production') || WORKER.includes('production') || ENV !== 'staging') {
  console.error('Refusing to run: target is not staging.')
  process.exit(1)
}

function wrangler(wranglerArgs, { capture = false } = {}) {
  const result = spawnSync('wrangler', wranglerArgs, {
    cwd: SYNC_SERVER_DIR,
    encoding: 'utf8',
    // Default maxBuffer is 1MB; the R2 key query's JSON output exceeds it once
    // staging holds a few thousand sync items (spawnSync fails with ENOBUFS).
    maxBuffer: 256 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`wrangler ${wranglerArgs.join(' ')} exited with ${result.status}`)
  }
  return result.stdout ?? ''
}

// Run a remote read-only query against staging D1 and return its rows.
function d1Query(sql) {
  const out = wrangler(
    ['d1', 'execute', DB_NAME, '--env', ENV, '--remote', '--yes', '--json', '--command', sql],
    { capture: true }
  )
  const start = out.indexOf('[')
  if (start === -1) return []
  const parsed = JSON.parse(out.slice(start))
  return parsed.flatMap((r) => r.results ?? [])
}

function deleteR2Object(key) {
  return new Promise((resolve) => {
    const child = spawn('wrangler', ['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote'], {
      cwd: SYNC_SERVER_DIR,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (code) => resolve({ key, ok: code === 0, stderr }))
  })
}

async function purgeR2(keys) {
  let done = 0
  let failed = 0
  const queue = [...keys]
  async function worker() {
    while (queue.length) {
      const key = queue.shift()
      const res = await deleteR2Object(key)
      done += 1
      if (!res.ok) {
        failed += 1
        console.warn(`  ! failed to delete ${res.key}: ${res.stderr.trim()}`)
      }
      if (done % 25 === 0 || done === keys.length) {
        console.log(`  deleted ${done}/${keys.length}`)
      }
    }
  }
  await Promise.all(Array.from({ length: R2_DELETE_CONCURRENCY }, worker))
  return failed
}

async function confirm() {
  if (SKIP_CONFIRM) return true
  if (!process.stdin.isTTY) {
    console.error('Refusing to run without a TTY. Pass --yes to confirm non-interactively.')
    return false
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((resolve) =>
    rl.question(`Type "reset staging" to wipe ${DB_NAME} + ${BUCKET}: `, resolve)
  )
  rl.close()
  return answer.trim() === 'reset staging'
}

async function main() {
  console.log('Target (staging):')
  console.log(`  D1     ${DB_NAME}`)
  console.log(`  R2     ${BUCKET} (staging-referenced objects only)`)
  console.log(`  Worker ${WORKER}${REDEPLOY ? ' (will redeploy)' : ' (--no-redeploy)'}`)
  console.log('')

  if (!(await confirm())) {
    console.error('Aborted.')
    process.exit(1)
  }

  // 1. Which tables currently exist (handles an already-empty / uninitialized DB).
  const tables = d1Query(
    "SELECT name FROM sqlite_master WHERE type='table' " +
      "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'"
  ).map((r) => r.name)

  // 2. Enumerate R2 object keys from whichever blob-bearing tables exist, then purge.
  const keySources = [
    ['sync_items', 'blob_key'],
    ['crdt_snapshots', 'blob_key'],
    ['upload_sessions', 'r2_key'],
    ['blob_chunks', 'r2_key']
  ].filter(([t]) => tables.includes(t))

  if (keySources.length) {
    const sql = keySources
      .map(([t, col]) => `SELECT ${col} AS k FROM ${t} WHERE ${col} IS NOT NULL`)
      .join(' UNION ')
    const keys = d1Query(sql)
      .map((r) => r.k)
      .filter((k) => typeof k === 'string' && k.length)
    console.log(`R2: deleting ${keys.length} object(s)...`)
    if (keys.length) {
      const failed = await purgeR2(keys)
      if (failed) console.warn(`R2: ${failed} object(s) failed to delete (see above).`)
    }
  } else {
    console.log('R2: no blob tables present, skipping object purge.')
  }

  // 3. Drop every table, then re-apply the schema (same database_id).
  //    No PRAGMA: a leading `PRAGMA foreign_keys=OFF` / `defer_foreign_keys=true` in the same
  //    --command batch makes D1 fail the DROPs with a bogus "no such table" (SQLITE_ERROR 7500).
  //    Drop children before parents: D1 enforces foreign keys, so dropping a still-referenced
  //    parent (e.g. `users`, referenced by every other table) also 7500s as "no such table".
  //    sqlite_master returns tables in creation order and the schema is dependency-ordered
  //    (referenced tables first), so reversing drops each table only once nothing references it.
  if (tables.length) {
    console.log(`D1: dropping ${tables.length} table(s)...`)
    const dropSql = [...tables]
      .reverse()
      .map((t) => `DROP TABLE IF EXISTS "${t}";`)
      .join('\n')
    wrangler(['d1', 'execute', DB_NAME, '--env', ENV, '--remote', '--yes', '--command', dropSql])
  }
  console.log('D1: applying schema/d1.sql...')
  wrangler(['d1', 'execute', DB_NAME, '--env', ENV, '--remote', '--yes', '--file', SCHEMA_FILE])

  // 4. Restart Durable Object isolates via redeploy (drops in-memory + live WS state).
  //    Note: this does NOT wipe DO storage; UserSyncState's harmless periodic alarm survives.
  if (REDEPLOY) {
    console.log('DO: redeploying staging worker to restart isolates...')
    wrangler(['deploy', '--env', ENV])
  } else {
    console.log('DO: skipped (--no-redeploy); warm isolates keep in-memory state until eviction.')
  }

  console.log('\nStaging reset complete.')
}

main().catch((err) => {
  console.error(err.message ?? err)
  process.exit(1)
})
