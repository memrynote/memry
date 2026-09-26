import { asc, eq, inArray, sql } from 'drizzle-orm'
import { syncIntents, type SyncIntentRow } from '@memry/db-schema/schema/sync-intents'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createLogger } from '../lib/logger'
import { trackMainEvent } from '../telemetry/track'
import {
  callLocalMutation,
  hasLocalSyncAdapter,
  recordDeleteTombstone,
  type LocalSyncType
} from './local-mutations'
import { clearPendingDelete } from './pending-deletes'

const log = createLogger('SyncIntents')

/** Values that round-trip through JSON unchanged; every local sync adapter argument is one. */
export type SyncIntentArg = string | readonly string[]

export type SyncIntentOp = 'create' | 'update' | 'delete'

/** What one committed local change owes the server. `args` are the adapter's extra arguments. */
export interface SyncIntent {
  type: LocalSyncType
  itemId: string
  op: SyncIntentOp
  args: readonly SyncIntentArg[]
}

export interface LocalChange<T> {
  value: T
  intents: readonly SyncIntent[]
}

/**
 * Who is draining, which decides whether a failure spends the attempt budget.
 * Only `startup` (the runtime-start replay) counts: `pull` (every pull start),
 * `settle` (a remote upsert for the item) and `commit` (right after the edit)
 * run on a cadence that would burn any budget in minutes.
 */
export type SyncIntentDrainRole = 'startup' | 'pull' | 'settle' | 'commit'

export interface SyncIntentDrainResult {
  /** Queued and removed. */
  applied: number
  /** Threw; kept pending (owned by the sweep, guarding the applier) for the next drain. */
  failed: number
  /** Delete intents dropped because their row exists locally again. */
  staleDeletes: number
  /** Start-up only: failed intents at or past `MAX_SYNC_INTENT_ATTEMPTS`. Still pending. */
  overCap: number
}

const OP_METHOD = {
  create: 'enqueueCreate',
  update: 'enqueueUpdate',
  delete: 'enqueueDelete'
} as const satisfies Record<SyncIntentOp, Parameters<typeof callLocalMutation>[1]>

/**
 * Start-up replays after which a still-failing intent is reported as over cap.
 * Nothing is given up at the cap: the row stays pending, so its un-clocked edit
 * keeps the applier guard and the sweep's hands off until the replay succeeds.
 */
export const MAX_SYNC_INTENT_ATTEMPTS = 5

const MAX_STORED_ERROR_LENGTH = 500

/** Rows whose presence makes a delete intent stale; only these types write intents today. */
const LOCAL_ROW_TABLES = { task: tasks, project: projects } as const

/** Unreadable rows already logged this session, so each is reported once. */
const loggedUnreadable = new Set<string>()

export const syncIntentItemKey = (type: string, itemId: string): string => `${type}\u0000${itemId}`

type ParsedIntent =
  | { ok: true; type: LocalSyncType; op: SyncIntentOp; args: unknown[] }
  | { ok: false; reason: string }

/**
 * Runs `write` and records its intents in ONE transaction (a SAVEPOINT when the
 * caller already holds one), so the row and what it owes the server commit or
 * roll back together (#2301). `write` must be synchronous.
 *
 * A delete intent's tombstone (`sync_pending_deletes`) is written here too, so
 * the resurrection guard never depends on the queueing step succeeding.
 *
 * After COMMIT the intents of the touched items are drained at once. The
 * transaction holds only the row, the intent rows and delete tombstones, never
 * clock or payload code: a sync failure cannot undo the user's edit, it leaves
 * the intent for the next drain.
 */
export function commitLocalChange<T>(db: DrizzleDb, write: () => LocalChange<T>): T {
  const change = db.transaction(() => {
    const out = write()
    const createdAt = new Date()
    for (const intent of out.intents) {
      db.insert(syncIntents)
        .values({
          type: intent.type,
          itemId: intent.itemId,
          op: intent.op,
          args: JSON.stringify(intent.args),
          createdAt
        })
        .run()
      const snapshot = intent.args[0]
      if (intent.op === 'delete' && typeof snapshot === 'string') {
        recordDeleteTombstone(intent.type, intent.itemId, snapshot, false)
      }
    }
    return out
  })
  if (change.intents.length > 0) drainSyncIntents(db, 'commit', change.intents)
  return change.value
}

/**
 * Turns pending intents into clock bumps and `sync_queue` rows through the
 * ordinary local sync adapters, so every type keeps its own clock rule,
 * offline fallback and delete tombstone. One transaction per intent: the
 * adapter call and the DELETE of the intent commit together or not at all, so
 * a clock is never bumped without its queue row and a replay is exactly-once.
 *
 * A failed intent keeps its row and holds back the later intents of the same
 * item for this pass, so per-item order holds. It is never given up: it stays
 * pending until a replay succeeds. Rows this build cannot read are left
 * untouched for a newer build. `itemKeys` limits the pass to those items;
 * omitted, everything pending is drained. Never throws.
 */
export function drainSyncIntents(
  db: DrizzleDb,
  role: SyncIntentDrainRole,
  itemKeys?: ReadonlyArray<{ type: string; itemId: string }>
): SyncIntentDrainResult {
  const result: SyncIntentDrainResult = { applied: 0, failed: 0, staleDeletes: 0, overCap: 0 }
  let rows: SyncIntentRow[]
  try {
    rows = selectIntents(db, itemKeys)
  } catch (err) {
    log.warn('Failed to read pending sync intents', { error: err })
    return result
  }

  const blocked = new Set<string>()
  for (const row of rows) {
    const key = syncIntentItemKey(row.type, row.itemId)
    if (blocked.has(key)) continue

    const intent = readIntent(row)
    if (!intent) continue

    if (intent.op === 'delete' && localRowExists(db, intent.type, row.itemId)) {
      dropStaleDelete(db, row)
      result.staleDeletes++
      continue
    }

    try {
      db.transaction(() => {
        callLocalMutation(intent.type, OP_METHOD[intent.op], row.itemId, intent.args)
        db.delete(syncIntents).where(eq(syncIntents.seq, row.seq)).run()
      })
      result.applied++
    } catch (err) {
      const countAttempt = role === 'startup'
      result.failed++
      if (countAttempt && row.attempts + 1 >= MAX_SYNC_INTENT_ATTEMPTS) result.overCap++
      blocked.add(key)
      recordFailure(db, row, err, countAttempt)
    }
  }
  return result
}

/**
 * Drains every pending intent and reports what it found: at sync runtime start
 * (`startup`, from `recoverDirtyItems`) and at the start of every pull
 * (`pull`), so an intent that failed once is retried within the session and
 * before remote rows land on its item. Numeric metrics only. A pull reports
 * only when something moved, so a stuck intent is not re-reported every pull;
 * the start-up replay reports every time, plus the over-cap count.
 */
export function drainPendingSyncIntents(
  db: DrizzleDb,
  role: 'startup' | 'pull'
): SyncIntentDrainResult {
  const result = drainSyncIntents(db, role)
  const attempted = result.applied + result.failed + result.staleDeletes
  const moved = result.applied + result.staleDeletes
  if (attempted === 0 || (role === 'pull' && moved === 0)) return result
  log.info('Drained pending sync intents', { role, ...result })
  trackMainEvent('sync_run_completed', {
    surface: 'sync',
    action: 'sync_intents_replayed',
    result: result.failed > 0 ? 'failed' : 'success',
    metrics: {
      itemCount: attempted,
      resultCount: result.applied,
      retryCount: result.failed,
      value: result.staleDeletes
    }
  })
  if (result.overCap > 0) {
    trackMainEvent('sync_run_completed', {
      surface: 'sync',
      action: 'sync_intents_over_cap',
      result: 'failed',
      metrics: { itemCount: result.overCap }
    })
  }
  return result
}

/**
 * Pull apply guard: a local edit whose intent is still pending carries its
 * pre-edit clock, so a remote row compared against it would overwrite the
 * edit. Drains the item first; false when an intent is still pending after.
 */
export function settleItemSyncIntents(db: DrizzleDb, type: string, itemId: string): boolean {
  if (!hasPendingIntent(db, type, itemId)) return true
  drainSyncIntents(db, 'settle', [{ type, itemId }])
  return !hasPendingIntent(db, type, itemId)
}

/** `type\0itemId` keys of every item with a pending intent this build can replay. */
export function listPendingIntentKeys(db: DrizzleDb): Set<string> {
  const rows = selectIntents(db, undefined).filter((row) => readIntent(row) !== null)
  return new Set(rows.map((row) => syncIntentItemKey(row.type, row.itemId)))
}

function hasPendingIntent(db: DrizzleDb, type: string, itemId: string): boolean {
  return selectIntents(db, [{ type, itemId }]).some((row) => readIntent(row) !== null)
}

function selectIntents(
  db: DrizzleDb,
  itemKeys: ReadonlyArray<{ type: string; itemId: string }> | undefined
): SyncIntentRow[] {
  const query = db.select().from(syncIntents)
  if (!itemKeys) return query.orderBy(asc(syncIntents.seq)).all()

  const wanted = new Set(itemKeys.map((key) => syncIntentItemKey(key.type, key.itemId)))
  const itemIds = [...new Set(itemKeys.map((key) => key.itemId))]
  return query
    .where(inArray(syncIntents.itemId, itemIds))
    .orderBy(asc(syncIntents.seq))
    .all()
    .filter((row) => wanted.has(syncIntentItemKey(row.type, row.itemId)))
}

/**
 * A row a newer build wrote (unknown type or op, args this build cannot
 * parse) is left pending and untouched so a re-upgrade replays it. This build
 * ignores it entirely: it does not own the item, guard it, or block it.
 */
function readIntent(row: SyncIntentRow): Extract<ParsedIntent, { ok: true }> | null {
  const intent = parseIntent(row)
  if (intent.ok) return intent
  const logKey = `${row.seq}\u0000${row.type}\u0000${row.itemId}\u0000${row.op}\u0000${row.args}`
  if (!loggedUnreadable.has(logKey)) {
    loggedUnreadable.add(logKey)
    log.warn(`Ignoring a sync intent this build cannot read (${intent.reason})`, {
      type: row.type,
      op: row.op
    })
  }
  return null
}

function parseIntent(row: SyncIntentRow): ParsedIntent {
  if (!hasLocalSyncAdapter(row.type)) return { ok: false, reason: 'unknown type' }
  if (!Object.hasOwn(OP_METHOD, row.op)) return { ok: false, reason: 'unknown op' }
  let args: unknown
  try {
    args = JSON.parse(row.args)
  } catch {
    return { ok: false, reason: 'unparseable args' }
  }
  if (!Array.isArray(args)) return { ok: false, reason: 'non-array args' }
  return { ok: true, type: row.type, op: row.op as SyncIntentOp, args }
}

function localRowExists(db: DrizzleDb, type: LocalSyncType, itemId: string): boolean {
  const table = LOCAL_ROW_TABLES[type as keyof typeof LOCAL_ROW_TABLES]
  if (!table) return false
  return db.select({ id: table.id }).from(table).where(eq(table.id, itemId)).get() !== undefined
}

/**
 * The row came back (a downgrade and re-upgrade across a crash is the known
 * path), so the delete is stale: pushing it would delete a live item on every
 * device while this one keeps it. The intent and its tombstone go; the row stays.
 */
function dropStaleDelete(db: DrizzleDb, row: SyncIntentRow): void {
  log.warn('Dropping a stale delete intent; the item exists locally again', {
    type: row.type,
    itemId: row.itemId
  })
  try {
    db.transaction(() => {
      db.delete(syncIntents).where(eq(syncIntents.seq, row.seq)).run()
      clearPendingDelete(db, row.type as LocalSyncType, row.itemId)
    })
  } catch (err) {
    log.warn('Failed to drop a stale delete intent', { error: err })
  }
}

function recordFailure(
  db: DrizzleDb,
  row: SyncIntentRow,
  err: unknown,
  countAttempt: boolean
): void {
  const message = (err instanceof Error ? err.message : String(err)).slice(
    0,
    MAX_STORED_ERROR_LENGTH
  )
  log.warn('Sync intent replay failed; kept pending for the next drain', {
    type: row.type,
    itemId: row.itemId,
    op: row.op,
    error: err
  })
  try {
    db.update(syncIntents)
      .set({
        lastError: message,
        ...(countAttempt ? { attempts: sql`${syncIntents.attempts} + 1` } : {})
      })
      .where(eq(syncIntents.seq, row.seq))
      .run()
  } catch (updateErr) {
    log.warn('Failed to record a sync intent failure', { error: updateErr })
  }
}
