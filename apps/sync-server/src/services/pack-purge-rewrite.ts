import { createLogger } from '../lib/logger'
import { extractEntry, openPack, type PackKindName, type PackedEntry } from './pack-format'
import {
  allLive,
  packDocuments,
  packIndexInsert,
  packKeyRange,
  packObjectKey,
  type Guard,
  type VaultScope
} from './pack-index-write'
import { roomGuard } from './pack-list'
import { deleteUnlisted, listingBatch, recordUnlisted } from './pack-replaced-objects'
import { liveIndexes, planOf, readPackObject } from './pack-repack'
import { snapshotsLive } from './pack-snapshot-selection'
import { updatesLive } from './pack-update-selection'

const logger = createLogger('PackPurgeRewrite')

/**
 * The rewrite half of the scoped purge (protocol 08 §8.13, #5229). The purge
 * batch takes each body pack that holds a deleted document out of the listing
 * and records its object in `pack_replaced_objects` as `replaced_by =
 * 'rewrite'`, `removed_at` the purge time. This pass rewrites each such object
 * as a rollup of one pack: the same kind and range under a new key, without
 * the entries whose row is gone (the purged document's, and any other dead
 * ones). The commit makes the old object due at once, so the deletion pass
 * removes it; it never goes before its rewrite committed, because the rewrite
 * reads it. A rewrite that cannot commit resets the kind instead
 * (packKindReset): the vault's packs of that kind are dropped and rebuilt from
 * source rows, so no range stays a gap.
 */

/** Marker of a recorded object still waiting for its rewrite. */
export const REWRITE_PENDING = 'rewrite'

// Rewrites per pass, one at a time: each holds the old pack and the new buffer
// (up to twice PACK_TARGET_BYTES) and costs one R2 GET, one PUT and two D1
// round trips. The purge and every compaction message run a pass; what is left
// waits for the purge's delayed message (PACK_PURGE_RETRY_DELAY_SECONDS).
export const PURGE_REWRITES_PER_PASS = 4

// One retry covers a rewrite that lost to a prune or another purge between
// its read and its commit; a second loss resets the kind.
const REWRITE_ATTEMPTS = 2

const kindPath = (kind: PackKindName): string => `/packs/${kind}/`

type BodyKind = Exclude<PackKindName, 'record'>

/** The live join of a body kind (pack-rollup.ts liveJoin, without `record`). */
const bodyLive = (kind: BodyKind, scope: VaultScope, entries: readonly PackedEntry[]): Guard =>
  kind === 'crdt_snapshot' ? snapshotsLive(scope, entries) : updatesLive(scope, entries)

/**
 * Statements that drop every listed `kind` pack of the vault while `when`
 * holds, reset the kind's watermark so compaction rebuilds it from source
 * rows, and make every recorded object of the kind due at once, a pending
 * rewrite's included (the rebuild replaces it). `when` is read before the
 * `pack_index` delete, so it may test the rows that delete removes.
 */
export const packKindReset = (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName,
  when: Guard
): D1PreparedStatement[] => {
  const vault = [scope.userId, scope.vaultId]
  return [
    db
      .prepare(
        `INSERT INTO pack_replaced_objects (pack_key, user_id, vault_id, replaced_by, removed_at)
         SELECT pack_key, user_id, vault_id, 'purge', 0 FROM pack_index
         WHERE user_id = ? AND vault_id = ? AND item_kind = ? AND ${when.sql}
         ON CONFLICT (pack_key) DO UPDATE SET replaced_by = 'purge', removed_at = 0`
      )
      .bind(...vault, kind, ...when.bind),
    db
      .prepare(
        `UPDATE pack_replaced_objects SET removed_at = 0,
           replaced_by = CASE WHEN replaced_by = '${REWRITE_PENDING}' THEN 'purge' ELSE replaced_by END
         WHERE user_id = ? AND vault_id = ? AND instr(pack_key, ?) > 0 AND ${when.sql}
         RETURNING pack_key AS replaced_key`
      )
      .bind(...vault, kindPath(kind), ...when.bind),
    db
      .prepare(
        `DELETE FROM pack_watermarks WHERE user_id = ? AND vault_id = ? AND item_kind = ? AND ${when.sql}`
      )
      .bind(...vault, kind, ...when.bind),
    db
      .prepare(
        `DELETE FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = ? AND ${when.sql}`
      )
      .bind(...vault, kind, ...when.bind)
  ]
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
  kind: BodyKind,
  range: { minSortValue: number; maxSortValue: number },
  packKey: string
): Promise<true | string> => {
  const read = await readPackObject(storage, kind, packKey)
  if (typeof read === 'string') return read
  const waiting: Guard = {
    sql: `EXISTS (SELECT 1 FROM pack_replaced_objects WHERE pack_key = ? AND replaced_by = '${REWRITE_PENDING}')`,
    bind: [packKey]
  }
  for (let attempt = 0; attempt < REWRITE_ATTEMPTS; attempt++) {
    const live = await liveIndexes(db, bodyLive(kind, scope, read.entries))
    const kept = read.entries.filter((_, index) => live.has(index))
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
      const current = allLive(bodyLive(kind, scope, kept), kept.length)
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
            coverage: null,
            documents: packDocuments(kind, kept)
          },
          {
            sql: `${waiting.sql} AND ${current.sql} AND ${room.sql}`,
            bind: [...waiting.bind, ...current.bind, ...room.bind]
          }
        ),
        recordUnlisted(db, scope, packId, newKey)
      )
    }
    const settles = kept.length > 0 ? listed : { sql: '1', bind: [] }
    statements.push(
      db
        .prepare(
          `UPDATE pack_replaced_objects SET replaced_by = ?, removed_at = 0
           WHERE pack_key = ? AND replaced_by = '${REWRITE_PENDING}' AND ${settles.sql}`
        )
        .bind(kept.length > 0 ? packId : 'purge', packKey, ...settles.bind),
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
          `SELECT pack_key FROM pack_replaced_objects
           WHERE user_id = ? AND vault_id = ? AND replaced_by = '${REWRITE_PENDING}'
           ORDER BY removed_at ASC, pack_key ASC
           LIMIT ?`
        )
        .bind(scope.userId, scope.vaultId, PURGE_REWRITES_PER_PASS + 1)
        .all<{ pack_key: string }>()
    ).results ?? []
  for (const { pack_key: packKey } of rows.slice(0, PURGE_REWRITES_PER_PASS)) {
    const range = packKeyRange(packKey)
    if (!range || range.kind === 'record') {
      await markDue(db, packKey, range ? 'record pack' : 'unparsed key')
      continue
    }
    let outcome: true | string
    try {
      outcome = await rewriteOne(db, storage, scope, range.kind, range, packKey)
    } catch (error) {
      outcome = error instanceof Error ? error.message : String(error)
    }
    if (outcome !== true) await resetKind(db, scope, range.kind, packKey, outcome)
  }
  return { pending: rows.length > PURGE_REWRITES_PER_PASS }
}
