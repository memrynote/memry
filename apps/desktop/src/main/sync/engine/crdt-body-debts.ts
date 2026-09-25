/**
 * Durable per-note CRDT body debts (#2297, protocol 07 §7.17.5).
 *
 * A debt says: this device knows the server holds body state for this note or
 * journal that its local doc has not merged. It is written before any
 * `LAST_CURSOR` write that moves past the evidence, so a crash cannot leave a
 * note looking merged with nothing left to pull it. It is deleted only by a
 * pull that walked the whole server body clean, or when the note has no row
 * left to pull into.
 *
 * A pull settles only debts at or below the generation it captured when it
 * started, so a debt raised while it ran stands. Generations come from one
 * counter per database handle, shared by every writer in the process and
 * seeded from the table, so they never go back (not even when the table
 * empties) and never depend on the wall clock.
 *
 * Every function is synchronous better-sqlite3 work, so a call made inside a
 * record page's transaction commits or rolls back with that page. A database
 * without the table (a migration that did not run) degrades to session-only
 * tracking with one logged error; sync keeps running.
 *
 * `crdtUnmergedDebt` in `sync_state` is kept as a mirror of "the table has a
 * row" for builds that predate the table.
 */
import { and, eq, gt, inArray, isNotNull, lte, max, or, sql } from 'drizzle-orm'
import { crdtBodyDebts } from '@memry/db-schema/schema/crdt-body-debts'
import { syncState } from '@memry/db-schema/schema/sync-state'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { createLogger } from '../../lib/logger'
import { SYNC_STATE_KEYS } from './sync-context'

const log = createLogger('CrdtBodyDebts')

/** Why a debt was raised. Only logs and tests read it. */
export type CrdtBodyDebtReason =
  | 'record'
  | 'feed_refused'
  | 'feed_owed'
  | 'missing_base'
  | 'land_failed'
  | 'pull_failed'
  | 'broadcast'
  | 'snapshot_refused'
  | 'local_only'
  | 'compaction'
  | 'sweep'
  | 'legacy'

export interface CrdtBodyDebt {
  noteId: string
  reason: string
  lowestCursor: number | null
  generation: number
  failures: number
  lastFailedAt: number | null
  needsWalk: number
  createdAt: number
  updatedAt: number
}

export interface OweCrdtBodyDebtOptions {
  /** Lowest change-feed cursor the note may lack; `null` (default) owes the whole body. */
  lowestCursor?: number | null
  /** A real failed body pull: counts a failure and restarts the backoff. */
  failed?: boolean
  /**
   * Re-owe only a note that already has a debt (a new generation, nothing
   * else); a note without one gains no row. For a pull that failed without
   * evidence about the note: a rate limit, an abort, a missing credential.
   */
  existingOnly?: boolean
  /**
   * The cause dropped the snapshot watermark (a signer skip, a dropped update,
   * a compaction): only a clean walk may settle the debt, never a probe. Once
   * set it stays set until the row is deleted.
   */
  needsWalk?: boolean
  now?: number
}

/** What `CrdtSyncCoordinator` needs from the table. */
export interface CrdtBodyDebtStore {
  owe(
    noteIds: readonly string[],
    reason: CrdtBodyDebtReason,
    options?: OweCrdtBodyDebtOptions
  ): void
  /** Settles what it may; answers the notes that still owe a debt. */
  settle(noteIds: readonly string[], generation?: number): Set<string>
  /** The highest generation raised so far: what a pull captures when it starts. */
  generation(): number
  /** Takes the next generation, for a flag that has no row (session-only). */
  bumpGeneration(): number
  /** Of these notes, those whose debt only a walk may settle. */
  needsWalk(noteIds: readonly string[]): Set<string>
  list(): CrdtBodyDebt[]
  /** When each failing debt's backoff ends (epoch ms). */
  backoffUntil(): Map<string, number>
}

/** For a coordinator with no data DB (unit tests of in-memory behaviour). */
export const SESSION_ONLY_CRDT_BODY_DEBTS: CrdtBodyDebtStore = {
  owe: () => {},
  settle: () => new Set(),
  generation: () => 0,
  bumpGeneration: () => 0,
  needsWalk: () => new Set(),
  list: () => [],
  backoffUntil: () => new Map()
}

export function crdtBodyDebtStore(db: DrizzleDb): CrdtBodyDebtStore {
  return {
    owe: (noteIds, reason, options) => oweCrdtBodyDebts(db, noteIds, reason, options),
    settle: (noteIds, generation) => settleCrdtBodyDebts(db, noteIds, generation),
    generation: () => currentCrdtBodyDebtGeneration(db),
    bumpGeneration: () => guarded(db, 0, () => ++generationCounter(db, db).value),
    needsWalk: (noteIds) => crdtBodyDebtsNeedingWalk(db, noteIds),
    list: () => listCrdtBodyDebts(db),
    backoffUntil: () => crdtBodyDebtBackoffUntil(db)
  }
}

const MAX_BACKOFF_MINUTES = 32
/** The longest a failing debt waits; also the cap on the retry timer. */
export const CRDT_BODY_DEBT_MAX_BACKOFF_MS = MAX_BACKOFF_MINUTES * 60_000

/** 2^(failures-1) minutes, capped at 32; 0 for a debt that has not failed. */
export function crdtBodyDebtBackoffMs(failures: number): number {
  if (failures <= 0) return 0
  return Math.min(2 ** (failures - 1), MAX_BACKOFF_MINUTES) * 60_000
}

/** Databases found without the table; everything on them is a no-op. */
const missingTable = new WeakSet<object>()

/** Handles whose table has been checked for the columns round 1 lacked. */
const shapeChecked = new WeakSet<object>()

/**
 * Unreleased round-1 builds created the table without `generation`,
 * `last_failed_at` and `needs_walk`. 0060's journal `when` is unchanged, so
 * the migrator never reruns it there: add what is missing, once per handle.
 * Additive and idempotent.
 */
function healTableShape(db: DrizzleDb): void {
  if (shapeChecked.has(db)) return
  shapeChecked.add(db)
  const columns = new Set(
    db.all<{ name: string }>(sql`PRAGMA table_info(crdt_body_debts)`).map((column) => column.name)
  )
  if (columns.size === 0) return
  if (!columns.has('generation')) {
    db.run(sql`ALTER TABLE crdt_body_debts ADD COLUMN generation INTEGER NOT NULL DEFAULT 0`)
  }
  if (!columns.has('last_failed_at')) {
    db.run(sql`ALTER TABLE crdt_body_debts ADD COLUMN last_failed_at INTEGER`)
  }
  if (!columns.has('needs_walk')) {
    db.run(sql`ALTER TABLE crdt_body_debts ADD COLUMN needs_walk INTEGER NOT NULL DEFAULT 0`)
  }
}

/** A missing table, or one whose shape this build cannot use. */
const UNUSABLE_TABLE = /no such table: crdt_body_debts|no such column|has no column named/

function guarded<T>(db: DrizzleDb, fallback: T, fn: () => T): T {
  if (missingTable.has(db)) return fallback
  try {
    healTableShape(db)
    return fn()
  } catch (err) {
    if (!(err instanceof Error) || !UNUSABLE_TABLE.test(err.message)) {
      throw err
    }
    missingTable.add(db)
    log.error('crdt_body_debts is unusable: CRDT body debts are tracked for this session only', {
      error: err.message
    })
    return fallback
  }
}

/** The generation counter of each database handle, seeded from the table once. */
const generations = new WeakMap<object, { value: number }>()

function generationCounter(root: DrizzleDb, tx: DrizzleDb): { value: number } {
  let counter = generations.get(root)
  if (!counter) {
    const row = tx
      .select({ value: max(crdtBodyDebts.generation) })
      .from(crdtBodyDebts)
      .get()
    counter = { value: row?.value ?? 0 }
    generations.set(root, counter)
  }
  return counter
}

export function currentCrdtBodyDebtGeneration(db: DrizzleDb): number {
  return guarded(db, 0, () => generationCounter(db, db).value)
}

/**
 * Raise a debt per note, in one transaction with the mirror. A second debt for
 * the same note keeps the first reason and the lower cursor, and NULL (whole
 * body) wins. Every debt
 * takes a new generation; only a `failed` one counts a failure and moves
 * `last_failed_at`, so other debts never extend a backoff.
 */
export function oweCrdtBodyDebts(
  db: DrizzleDb,
  noteIds: readonly string[],
  reason: CrdtBodyDebtReason,
  options: OweCrdtBodyDebtOptions = {}
): void {
  if (noteIds.length === 0) return
  guarded(db, undefined, () => db.transaction((tx) => oweInTx(db, tx, noteIds, reason, options)))
}

function oweInTx(
  root: DrizzleDb,
  tx: DrizzleDb,
  noteIds: readonly string[],
  reason: CrdtBodyDebtReason,
  {
    lowestCursor = null,
    failed = false,
    existingOnly = false,
    needsWalk = false,
    now = Date.now()
  }: OweCrdtBodyDebtOptions,
  writeMirror = true
): void {
  const counter = generationCounter(root, tx)
  for (const noteId of new Set(noteIds)) {
    const generation = ++counter.value
    if (existingOnly) {
      tx.update(crdtBodyDebts)
        .set({ generation, updatedAt: now, ...(needsWalk ? { needsWalk: 1 } : {}) })
        .where(eq(crdtBodyDebts.noteId, noteId))
        .run()
      continue
    }
    tx.insert(crdtBodyDebts)
      .values({
        noteId,
        reason,
        lowestCursor,
        generation,
        failures: failed ? 1 : 0,
        lastFailedAt: failed ? now : null,
        needsWalk: needsWalk ? 1 : 0,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: crdtBodyDebts.noteId,
        set: {
          lowestCursor: sql`CASE WHEN ${crdtBodyDebts.lowestCursor} IS NULL OR excluded.lowest_cursor IS NULL THEN NULL ELSE min(${crdtBodyDebts.lowestCursor}, excluded.lowest_cursor) END`,
          generation,
          ...(failed ? { failures: sql`${crdtBodyDebts.failures} + 1`, lastFailedAt: now } : {}),
          ...(needsWalk ? { needsWalk: 1 } : {}),
          updatedAt: now
        }
      })
      .run()
  }
  if (writeMirror && !existingOnly) writeUnmergedDebtMirror(tx, true, now)
}

/**
 * Delete the notes' debts in one transaction. With `generation`, only a debt
 * raised at or before it is deleted: one raised while the pull ran is not in
 * the doc it walked. Without it (the notes lost their rows) they go
 * regardless. Answers the notes that still owe a debt.
 */
export function settleCrdtBodyDebts(
  db: DrizzleDb,
  noteIds: readonly string[],
  generation?: number,
  now = Date.now()
): Set<string> {
  if (noteIds.length === 0) return new Set()
  return guarded(db, new Set<string>(), () =>
    db.transaction((tx) => {
      const byIds = inArray(crdtBodyDebts.noteId, [...new Set(noteIds)])
      const { changes } = tx
        .delete(crdtBodyDebts)
        .where(
          generation === undefined ? byIds : and(byIds, lte(crdtBodyDebts.generation, generation))
        )
        .run()
      const remaining = new Set(
        tx
          .select({ noteId: crdtBodyDebts.noteId })
          .from(crdtBodyDebts)
          .where(byIds)
          .all()
          .map((row) => row.noteId)
      )
      if (changes > 0 && !hasDebtsInTx(tx)) writeUnmergedDebtMirror(tx, false, now)
      return remaining
    })
  )
}

export function listCrdtBodyDebts(db: DrizzleDb): CrdtBodyDebt[] {
  return guarded(db, [], () =>
    db.select().from(crdtBodyDebts).orderBy(crdtBodyDebts.generation).all()
  )
}

export function hasCrdtBodyDebts(db: DrizzleDb): boolean {
  return guarded(db, false, () => hasDebtsInTx(db))
}

function hasDebtsInTx(db: DrizzleDb): boolean {
  return (
    db.select({ noteId: crdtBodyDebts.noteId }).from(crdtBodyDebts).limit(1).get() !== undefined
  )
}

/**
 * When each failing debt's backoff ends. A last failure dated after `now` (a
 * clock set back) counts from `now`, so no backoff runs past 32 minutes.
 */
export function crdtBodyDebtBackoffUntil(db: DrizzleDb, now = Date.now()): Map<string, number> {
  return guarded(db, new Map<string, number>(), () => {
    const failing = db
      .select({
        noteId: crdtBodyDebts.noteId,
        failures: crdtBodyDebts.failures,
        lastFailedAt: crdtBodyDebts.lastFailedAt
      })
      .from(crdtBodyDebts)
      .where(and(gt(crdtBodyDebts.failures, 0), isNotNull(crdtBodyDebts.lastFailedAt)))
      .all()
    return new Map(
      failing.map((debt) => [
        debt.noteId,
        Math.min(debt.lastFailedAt ?? 0, now) + crdtBodyDebtBackoffMs(debt.failures)
      ])
    )
  })
}

/**
 * The notes whose debt a batch probe may not settle, only a walk: a compaction
 * debt, a failing one, or one whose cause dropped the watermark. Durable, so a
 * watermark persisted before a crash cannot settle it after the restart.
 */
export function crdtBodyDebtsNeedingWalk(db: DrizzleDb, noteIds: readonly string[]): Set<string> {
  if (noteIds.length === 0) return new Set()
  return guarded(db, new Set<string>(), () => {
    const rows = db
      .select({ noteId: crdtBodyDebts.noteId })
      .from(crdtBodyDebts)
      .where(
        and(
          inArray(crdtBodyDebts.noteId, [...new Set(noteIds)]),
          or(
            eq(crdtBodyDebts.needsWalk, 1),
            eq(crdtBodyDebts.reason, 'compaction'),
            gt(crdtBodyDebts.failures, 0)
          )
        )
      )
      .all()
    return new Set(rows.map((row) => row.noteId))
  })
}

/**
 * Engine start: turn a `crdtUnmergedDebt = '1'` this build did not write into a
 * whole-body debt for every note in `noteIds()`, then make the mirror match the
 * table. Before the table existed that key was the only record of unmerged
 * state, naming no notes; a downgraded build, or a CRDT store whose epoch does
 * not match the data DB, writes it the same way. Returns how many debts it
 * raised.
 *
 * Ours is recognised by `crdtBodyDebtMirrorAt` matching the row's
 * `updated_at`. That column has second precision, so a foreign write in the
 * same second as ours reads as ours.
 */
export function convertUnmergedDebtMirror(
  db: DrizzleDb,
  noteIds: () => string[],
  now = Date.now()
): number {
  return guarded(db, 0, () =>
    db.transaction((tx) => {
      const mirror = readState(tx, SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT)
      const mirrorAt = readState(tx, SYNC_STATE_KEYS.CRDT_BODY_DEBT_MIRROR_AT)?.value
      const foreign = mirror?.value === '1' && mirrorAt !== String(mirror.updatedAt.getTime())
      const ids = foreign ? [...new Set(noteIds())] : []
      if (ids.length > 0) oweInTx(db, tx, ids, 'legacy', { now }, false)
      writeUnmergedDebtMirror(tx, hasDebtsInTx(tx), now, foreign)
      return ids.length
    })
  )
}

function readState(db: DrizzleDb, key: string): { value: string; updatedAt: Date } | undefined {
  return db
    .select({ value: syncState.value, updatedAt: syncState.updatedAt })
    .from(syncState)
    .where(eq(syncState.key, key))
    .get()
}

function writeUnmergedDebtMirror(
  db: DrizzleDb,
  hasDebt: boolean,
  now: number,
  force = false
): void {
  const value = hasDebt ? '1' : '0'
  if (!force && readState(db, SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT)?.value === value) return
  // `updated_at` is stored in whole seconds; the marker must equal what reads back.
  const updatedAt = new Date(Math.floor(now / 1000) * 1000)
  for (const [key, v] of [
    [SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT, value],
    [SYNC_STATE_KEYS.CRDT_BODY_DEBT_MIRROR_AT, String(updatedAt.getTime())]
  ] as const) {
    db.insert(syncState)
      .values({ key, value: v, updatedAt })
      .onConflictDoUpdate({ target: syncState.key, set: { value: v, updatedAt } })
      .run()
  }
}
