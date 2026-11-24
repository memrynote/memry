import { createLogger } from '../lib/logger'
import { EXPIRED_TOMBSTONE_SQL } from './expired-tombstone'
import { extractEntry, openPack, type PackKindName, type PackedEntry } from './pack-format'
import {
  ALWAYS,
  allLive,
  packDocuments,
  type Coverage,
  packIndexInsert,
  packKeyRange,
  packObjectKey,
  type Guard,
  type VaultScope
} from './pack-index-write'
import { roomGuard } from './pack-list'
import {
  REWRITE_PENDING,
  deleteUnlisted,
  listingBatch,
  packKindReset,
  recordUnlisted
} from './pack-replaced-objects'
import { recordsLive } from './pack-record-live'
import { liveIndexes, planOf, readPackObject } from './pack-repack'
import { snapshotsLive } from './pack-snapshot-selection'
import { updatesLive } from './pack-update-selection'

const logger = createLogger('PackPurgeRewrite')

/**
 * The rewrite half of the scoped purge (protocol 08 §8.13, #5229, #5247). The
 * purge batch takes each pack that holds a deleted document out of the listing
 * (a record pack also before a tombstone shed, record-pack-purge.ts) and
 * records its object in `pack_replaced_objects` as `replaced_by = 'rewrite'`,
 * `removed_at` the purge time. This pass rewrites each such object as a rollup
 * of one pack: the same kind, range and coverage under a new key, without the
 * entries whose row is gone or moved (the purged document's, older versions of
 * a deleted record, and any other dead ones) and without the entry of a
 * tombstone past retention, which the shed empties next. The commit makes the old object due at once, so the deletion pass
 * removes it. A deletion pass that reaches the object first, past its grace,
 * resets the kind (pack-replaced-objects.ts). A rewrite that cannot commit
 * resets the kind too
 * (packKindReset): the vault's packs of that kind are dropped and rebuilt from
 * source rows, so no range stays a gap.
 */

// Rewrites per pass, one at a time: each holds the old pack and the new buffer
// (up to twice PACK_TARGET_BYTES) and costs one R2 GET, one PUT and two D1
// round trips; each retry of an emptied record pack (rewritePurgedPacks) costs
// one more D1 round trip and no R2 read. The purge and every compaction message
// run a pass; what is left waits for the purge's delayed message
// (PACK_PURGE_RETRY_DELAY_SECONDS).
export const PURGE_REWRITES_PER_PASS = 4

// One retry covers a rewrite that lost to a prune or another purge between
// its read and its commit; a second loss resets the kind.
const REWRITE_ATTEMPTS = 2

/** Outcome of an emptied record pack that no listed record pack borders yet. */
const NO_NEIGHBOUR = 'no listed record pack adjacent to take its coverage'

type PendingRewrite = { pack_key: string; cover_from: number | null; cover_through: number | null }

/** An emptied record pack waiting for a listed neighbour to take its coverage. */
type Emptied = { packKey: string; coverage: { from: number; through: number } }

const waitingFor = (packKey: string): Guard => ({
  sql: `EXISTS (SELECT 1 FROM pack_replaced_objects WHERE pack_key = ? AND replaced_by = '${REWRITE_PENDING}')`,
  bind: [packKey]
})

/** Settles the pending rewrite of `packKey` as `by`, while `when` holds. */
const settleRewrite = (
  db: D1Database,
  packKey: string,
  by: string,
  when: Guard
): D1PreparedStatement =>
  db
    .prepare(
      `UPDATE pack_replaced_objects SET replaced_by = ?, removed_at = 0
       WHERE pack_key = ? AND replaced_by = '${REWRITE_PENDING}' AND ${when.sql}`
    )
    .bind(by, packKey, ...when.bind)

/**
 * The entries a rewrite keeps: pack-rollup.ts liveJoin, less a record whose
 * row is a tombstone past retention (§8.13, purged-tombstone markers).
 */
const keptJoin = (
  kind: PackKindName,
  scope: VaultScope,
  entries: readonly PackedEntry[]
): Guard => {
  if (kind === 'crdt_snapshot') return snapshotsLive(scope, entries)
  if (kind === 'crdt_update') return updatesLive(scope, entries)
  const live = recordsLive(scope, entries)
  return {
    sql: `${live.sql} AND NOT EXISTS (SELECT 1 FROM sync_items si
      LEFT JOIN sync_entitlements e ON e.user_id = si.user_id
      WHERE si.id = s.id AND ${EXPIRED_TOMBSTONE_SQL})`,
    bind: [...live.bind, Math.floor(Date.now() / 1000)]
  }
}

const resetKind = async (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName,
  packKey: string,
  reason: string
): Promise<void> => {
  logger.error('purge rewrite failed; the kind is dropped and rebuilt from source rows', {
    userId: scope.userId,
    vaultId: scope.vaultId,
    kind,
    packKey,
    reason
  })
  await db.batch(packKindReset(db, scope, kind, { sql: '1', bind: [] }))
}

const markDue = async (db: D1Database, packKey: string, reason: string): Promise<void> => {
  logger.error('purge rewrite of an unknown pack key; object made due', { packKey, reason })
  await db
    .prepare(
      `UPDATE pack_replaced_objects SET replaced_by = 'purge', removed_at = 0
       WHERE pack_key = ? AND replaced_by = '${REWRITE_PENDING}'`
    )
    .bind(packKey)
    .run()
}

/**
 * Rewrite one recorded object. True when its rewrite record is settled (by
 * this pass or a concurrent one), or the reason it cannot be rewritten.
 */
const rewriteOne = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope,
  kind: PackKindName,
  range: { minSortValue: number; maxSortValue: number },
  coverage: Coverage,
  packKey: string
): Promise<true | string> => {
  const waiting = waitingFor(packKey)
  const read = await readPackObject(storage, kind, packKey)
  // A concurrent pass may settle the rewrite and delete the object after this
  // pass selected the row (VERIFY-5636 #9): settled, so no reset.
  if (typeof read === 'string') {
    const row = await db
      .prepare(`SELECT ${waiting.sql} AS pending`)
      .bind(...waiting.bind)
      .first<{ pending: number }>()
    return row?.pending ? read : true
  }
  for (let attempt = 0; attempt < REWRITE_ATTEMPTS; attempt++) {
    const live = await liveIndexes(db, keptJoin(kind, scope, read.entries))
    const kept = read.entries.filter((_, index) => live.has(index))
    // A covered record pack that keeps nothing lists no pack, so its coverage
    // moves to a listed neighbour, or the chain would keep a hole that no
    // rollup closes (§8.10, REVIEW-5452).
    if (kept.length === 0 && coverage !== null) return handOn(db, scope, coverage, packKey)
    const packId = crypto.randomUUID()
    const newKey = packObjectKey(scope, kind, range.minSortValue, range.maxSortValue, packId)
    const listed: Guard = { sql: 'EXISTS (SELECT 1 FROM pack_index WHERE id = ?)', bind: [packId] }
    const statements: D1PreparedStatement[] = []
    if (kept.length > 0) {
      const plans = kept.map((entry) => planOf(kind, entry))
      const pack = openPack(plans)
      for (let i = 0; i < kept.length; i++) {
        await pack.writeEntry(plans[i], extractEntry(read.bytes, kept[i]))
      }
      const built = await pack.finish()
      await storage.put(newKey, built.bytes)
      // The §7.15 recheck: every kept entry is still current at commit. The
      // listing cap holds too (§8.14): a build may have taken the freed slot.
      const current = allLive(keptJoin(kind, scope, kept), kept.length)
      const room = roomGuard(scope)
      statements.push(
        packIndexInsert(
          db,
          scope,
          {
            id: packId,
            kind,
            packKey: newKey,
            minSortValue: range.minSortValue,
            maxSortValue: range.maxSortValue,
            itemCount: kept.length,
            byteSize: built.payloadBytes,
            coverage,
            documents: packDocuments(kept)
          },
          {
            sql: `${waiting.sql} AND ${current.sql} AND ${room.sql}`,
            bind: [...waiting.bind, ...current.bind, ...room.bind]
          }
        ),
        recordUnlisted(db, scope, packId, newKey)
      )
    }
    statements.push(
      kept.length > 0
        ? settleRewrite(db, packKey, packId, listed)
        : settleRewrite(db, packKey, 'purge', ALWAYS),
      db
        .prepare(`SELECT NOT ${waiting.sql} AS settled, ${listed.sql} AS listed`)
        .bind(...waiting.bind, ...listed.bind)
    )
    const results = await listingBatch<{ settled: number; listed: number }>(
      db,
      scope,
      kept.length > 0 ? { packId, packKey: newKey } : null,
      statements
    )
    const check = results[results.length - 1].results?.[0]
    // The one object-delete rule: this rewrite's own row is absent.
    if (kept.length > 0 && !check?.listed) await deleteUnlisted(storage, newKey)
    if (check?.settled) {
      logger.info('purge rewrite', {
        userId: scope.userId,
        vaultId: scope.vaultId,
        kind,
        entriesIn: read.entries.length,
        entriesKept: kept.length,
        listed: Boolean(check.listed)
      })
      return true
    }
  }
  return 'lost the commit to a concurrent prune, purge or listing'
}

/**
 * Hands an emptied record pack's coverage on and settles its rewrite. True
 * when the rewrite is settled, by this batch or a concurrent pass, else
 * NO_NEIGHBOUR: no listed record pack borders it yet, and its rewrite stays
 * pending. Reads no object: the pack kept nothing.
 */
const handOn = async (
  db: D1Database,
  scope: VaultScope,
  coverage: { from: number; through: number },
  packKey: string
): Promise<true | string> => {
  const waiting = waitingFor(packKey)
  const neighbour: Guard = {
    sql: `EXISTS (SELECT 1 FROM pack_index WHERE user_id = ? AND vault_id = ?
      AND item_kind = 'record' AND (cover_from = ? OR cover_through = ?))`,
    bind: [scope.userId, scope.vaultId, coverage.from, coverage.through]
  }
  const results = await db.batch<{ settled: number }>([
    ...absorbCoverage(db, scope, coverage, waiting),
    settleRewrite(db, packKey, 'purge', neighbour),
    db.prepare(`SELECT NOT ${waiting.sql} AS settled`).bind(...waiting.bind)
  ])
  if (!results[results.length - 1].results?.[0]?.settled) return NO_NEIGHBOUR
  logger.info('purge rewrite handed its coverage on', {
    userId: scope.userId,
    vaultId: scope.vaultId
  })
  return true
}

/**
 * Statements that hand an emptied record pack's coverage `(from, through]` to
 * the listed pack that starts where it ended, else to the one that ends where
 * it started, while its rewrite is still pending.
 */
const absorbCoverage = (
  db: D1Database,
  scope: VaultScope,
  coverage: { from: number; through: number },
  waiting: Guard
): D1PreparedStatement[] => {
  const record = `user_id = ? AND vault_id = ? AND item_kind = 'record'`
  const vault = [scope.userId, scope.vaultId]
  return [
    db
      .prepare(
        `UPDATE pack_index SET cover_from = ? WHERE ${record} AND cover_from = ? AND ${waiting.sql}`
      )
      .bind(coverage.from, ...vault, coverage.through, ...waiting.bind),
    db
      .prepare(
        `UPDATE pack_index SET cover_through = ? WHERE ${record} AND cover_through = ?
           AND NOT EXISTS (SELECT 1 FROM pack_index WHERE ${record} AND cover_from = ?)
           AND ${waiting.sql}`
      )
      .bind(coverage.through, ...vault, coverage.from, ...vault, coverage.from, ...waiting.bind)
  ]
}

/**
 * Runs one step of a rewrite; a step that fails resets the kind. False while
 * the pack waits for a neighbour (NO_NEIGHBOUR): its rewrite is still pending.
 */
const runStep = async (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName,
  packKey: string,
  step: () => Promise<true | string>
): Promise<boolean> => {
  let outcome: true | string
  try {
    outcome = await step()
  } catch (error) {
    outcome = error instanceof Error ? error.message : String(error)
  }
  if (outcome === NO_NEIGHBOUR) return false
  if (outcome !== true) await resetKind(db, scope, kind, packKey, outcome)
  return true
}

/** Rewrite one recorded object. The emptied record pack it leaves waiting, if any. */
const rewriteRow = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope,
  row: PendingRewrite
): Promise<Emptied | null> => {
  const packKey = row.pack_key
  const range = packKeyRange(packKey)
  if (!range) {
    await markDue(db, packKey, 'unparsed key')
    return null
  }
  // A record pack keeps its coverage, so the record chain keeps tiling (§8.10).
  const coverage =
    row.cover_from !== null && row.cover_through !== null
      ? { from: row.cover_from, through: row.cover_through }
      : null
  const rewrite = () => rewriteOne(db, storage, scope, range.kind, range, coverage, packKey)
  const settled = await runStep(db, scope, range.kind, packKey, rewrite)
  return settled || coverage === null ? null : { packKey, coverage }
}

/**
 * Rewrite up to PURGE_REWRITES_PER_PASS objects of the vault a purge took out
 * of the listing, oldest first. `pending` is true when more are waiting.
 */
export const rewritePurgedPacks = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope
): Promise<{ pending: boolean }> => {
  const rows =
    (
      await db
        .prepare(
          `SELECT pack_key, cover_from, cover_through FROM pack_replaced_objects
           WHERE user_id = ? AND vault_id = ? AND replaced_by = '${REWRITE_PENDING}'
           ORDER BY removed_at ASC, pack_key ASC
           LIMIT ?`
        )
        .bind(scope.userId, scope.vaultId, PURGE_REWRITES_PER_PASS + 1)
        .all<PendingRewrite>()
    ).results ?? []
  const pending = rows.length > PURGE_REWRITES_PER_PASS
  const first = rows.slice(0, PURGE_REWRITES_PER_PASS)
  let waiting: Emptied[] = []
  for (const row of first) {
    const emptied = await rewriteRow(db, storage, scope, row)
    if (emptied) waiting.push(emptied)
  }
  // An emptied record pack whose neighbour still waits for its own rewrite
  // takes its turn again once that rewrite lists or hands on coverage, for as
  // long as each round settles another row (VERIFY-5452 #3).
  let round = first.length
  while (waiting.length > 0 && waiting.length < round) {
    round = waiting.length
    const retries = waiting
    waiting = []
    for (const row of retries) {
      const retry = () => handOn(db, scope, row.coverage, row.packKey)
      if (!(await runStep(db, scope, 'record', row.packKey, retry))) waiting.push(row)
    }
  }
  // No rewrite of this pass can border them. A pass that settled a rewrite
  // and leaves more pending leaves them to the next pass, which may list
  // their neighbour; otherwise the reset settles every pending rewrite of the
  // kind.
  if (waiting.length > 0 && !(pending && waiting.length < first.length)) {
    await resetKind(db, scope, 'record', waiting[0].packKey, NO_NEIGHBOUR)
  }
  return { pending }
}
