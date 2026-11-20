// The marks of the two shells over the Rust core (Tauri and iOS). Neither logs
// "every record applied" or "every body local", so the benchmark reads:
// - start: the shell's own log line (Tauri main.log `bootstrap window opened`,
//   iOS unified log `a first sync started`);
// - records: iOS logs `the first sync is pulling bodies` when the metadata pass
//   ends; Tauri does not, and it runs no first sync, only passes, so its mark is
//   the feed head on the proxy's timeline (`feedHeadMs`);
// - bodies: the vault's data.db, read-only: no document still owes a body
//   (`sync.body_owed:*`, crates/memry-core src/sync/body_debt.rs), and on iOS
//   the first sync has completed.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { channelOf } from './metrics.mjs'

const OWED_FROM = 'sync.body_owed:'
// The key right after every `sync.body_owed:*` key (';' follows ':').
const OWED_TO = 'sync.body_owed;'

/**
 * `{ bound, completed, owed }` of one data.db, opened read-only: whether the
 * vault is bound to a server vault (`sync.server_vault_id`), whether its
 * first sync completed, and how many documents still owe a body.
 */
export function bodyDebt(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const has = (key) => db.prepare('SELECT 1 FROM meta WHERE key = ?').get(key) !== undefined
    const { owed } = db
      .prepare('SELECT COUNT(*) AS owed FROM meta WHERE key >= ? AND key < ?')
      .get(OWED_FROM, OWED_TO)
    return {
      bound: has('sync.server_vault_id'),
      completed: has('first_sync.completed'),
      owed: Number(owed)
    }
  } finally {
    db.close()
  }
}

function dataDbsUnder(root, depth) {
  if (depth < 0 || !fs.existsSync(root)) return []
  const found = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isFile() && entry.name === 'data.db') found.push(full)
    else if (entry.isDirectory()) found.push(...dataDbsUnder(full, depth - 1))
  }
  return found
}

/**
 * The data.db under `roots`, changed at or after `sinceMs`, of a vault bound to
 * a server vault, or null. `sinceMs` skips the vaults of earlier runs.
 */
export function findBootstrapDb(roots, sinceMs, depth = 6) {
  const fresh = roots
    .flatMap((root) => dataDbsUnder(root, depth))
    .filter((db) => fs.statSync(db).mtimeMs >= sinceMs)
  for (const db of fresh) {
    try {
      if (bodyDebt(db).bound) return db
    } catch {
      // Not a vault database yet (created, not migrated): look again next poll.
    }
  }
  return null
}

/**
 * When every record was fetched, read off the proxy's timeline: the feed head
 * is the first `GET /sync/changes` page after `startMs` without more, and the
 * mark is the end of the last `POST /sync/pull` that follows it before the
 * first CRDT body request (the item fetches of that page, or the core's
 * metadata pass). Null before the head.
 */
export function feedHeadMs(requests, startMs) {
  const sorted = requests
    .filter((r) => r.startMs >= startMs && !r.refused && r.method !== 'WS')
    .toSorted((a, b) => a.startMs - b.startMs)
  const head = sorted.findIndex(
    (r) => r.method === 'GET' && r.path.startsWith('/sync/changes') && r.hasMore === false
  )
  if (head < 0) return null
  let end = sorted[head].endMs
  for (const request of sorted.slice(head + 1)) {
    if (['snapshots', 'updates'].includes(channelOf(request))) break
    if (request.method === 'POST' && request.path.split('?')[0] === '/sync/pull') {
      end = Math.max(end, request.endMs)
    }
  }
  return end
}

const TAURI_LINE =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) .*bootstrap window opened/

/** When Tauri's main.log (local time) opened the bootstrap window, or null. */
export function tauriStartMs(lines) {
  for (const line of lines) {
    const match = TAURI_LINE.exec(line)
    if (match) {
      const [, y, mo, d, h, mi, s, ms] = match.map(Number)
      return new Date(y, mo - 1, d, h, mi, s, ms).getTime()
    }
  }
  return null
}

const IOS_MARKS = {
  startMs: 'a first sync started',
  recordsMs: 'the first sync is pulling bodies',
  firstSyncMs: 'a first sync finished'
}

/**
 * Reads `log stream --style ndjson` lines of the app's subsystem. Returns the
 * first time of each mark; the stream's header line is not JSON and skipped.
 */
export function iosMarks(lines) {
  const marks = { startMs: null, recordsMs: null, firstSyncMs: null }
  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const message = event.eventMessage ?? ''
    for (const [mark, text] of Object.entries(IOS_MARKS)) {
      if (marks[mark] !== null || !message.startsWith(text)) continue
      // `2026-11-20 01:02:03.123456+0000`
      const iso = event.timestamp.replace(' ', 'T').replace(/(\.\d{3})\d*/, '$1')
      marks[mark] = Date.parse(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
    }
  }
  return marks
}
