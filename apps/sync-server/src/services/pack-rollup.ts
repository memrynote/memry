import { PACK_MAX_ENTRIES } from '@memry/contracts/pack-format'
import { PACK_REPLACED_GRACE_SECONDS } from '@memry/contracts/sync-api'

import { createLogger } from '../lib/logger'
import {
  extractEntry,
  openPack,
  parsePack,
  type PackEntryPlan,
  type PackEntryPlanMeta,
  type PackKindName,
  type PackedEntry
} from './pack-format'
import {
  allLive,
  packIndexInsert,
  packObjectKey,
  type Coverage,
  type Guard,
  type VaultScope
} from './pack-index-write'
import { recordsLive } from './pack-record-selection'
import { PACK_TARGET_BYTES, packCountBound } from './pack-sizing'
import { snapshotsLive } from './pack-snapshot-selection'
import { updatesLive } from './pack-update-selection'

const logger = createLogger('PackRollup')

/**
 * Rollup (protocol 08 §8.12, #5229): rewrite a run of adjacent packs of one
 * kind into one new pack that keeps every entry still current and drops the
 * rest, then swap the listing in one D1 batch. The old objects stay for
 * PACK_REPLACED_GRACE_SECONDS, so a reader that listed them before the swap
 * still downloads them, and go through `pack_replaced_objects`, which outlives
 * a Worker restart.
 *
 * A kind is rolled up only while it lists more packs than packCountBound, so a
 * full pack is not rewritten for every small one that lands beside it.
 */

// Inputs per rollup: one R2 GET each, about 70 subrequests with the PUT and the
// D1 batch. Inputs are also capped at PACK_TARGET_BYTES together, so the input
// bytes and the merged buffer stay under twice the build's peak.
export const ROLLUP_MAX_INPUTS = 64
export const ROLLUP_SUBREQUESTS = ROLLUP_MAX_INPUTS + 8
const ROLLUP_FETCH_CONCURRENCY = 8
// Replaced objects one deletion pass removes: one R2 bulk delete takes 1000.
const REPLACED_DELETE_BATCH = 500

export interface ListedPack {
  id: string
  pack_key: string
  min_cursor: number
  max_cursor: number
  item_count: number
  byte_size: number
  cover_from: number | null
  cover_through: number | null
}

const covered = (pack: ListedPack): boolean =>
  pack.cover_from !== null && pack.cover_through !== null

/**
 * Two adjacent packs merge only when the merged coverage is the union of
 * theirs: both cache-only, or covered ranges that meet (protocol 08 §8.10).
 */
const chains = (previous: ListedPack, next: ListedPack): boolean =>
  covered(previous) === covered(next) &&
  (!covered(next) || next.cover_from === previous.cover_through)

/**
 * The longest run of at least two adjacent packs (ascending `min_cursor`) that
 * chain and fit one pack by their listed counts. Longest, so tiny packs merge
 * before a full pack is rewritten. Empty when no two neighbours fit.
 */
export const planRollup = (packs: readonly ListedPack[]): ListedPack[] => {
  let best: ListedPack[] = []
  for (let start = 0; start < packs.length; start++) {
    const run: ListedPack[] = []
    let entries = 0
    let bytes = 0
    for (let i = start; i < packs.length && run.length < ROLLUP_MAX_INPUTS; i++) {
      const pack = packs[i]
      const previous = run[run.length - 1]
      if (previous && !chains(previous, pack)) break
      if (entries + pack.item_count > PACK_MAX_ENTRIES) break
      if (bytes + pack.byte_size > PACK_TARGET_BYTES) break
      entries += pack.item_count
      bytes += pack.byte_size
      run.push(pack)
    }
    if (run.length > best.length) best = run
  }
  return best.length >= 2 ? best : []
}

/** Live-entry join per kind: the same rows a build would pack today. */
const liveJoin = (kind: PackKindName, scope: VaultScope, entries: readonly PackedEntry[]): Guard =>
  kind === 'record'
    ? recordsLive(scope, entries)
    : kind === 'crdt_snapshot'
      ? snapshotsLive(scope, entries)
      : updatesLive(scope, entries)

interface Input {
  pack: ListedPack
  bytes: Uint8Array
  entries: PackedEntry[]
}

interface KindStats {
  packs: number
  entries: number
  bytes: number
}

const kindStats = async (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName
): Promise<KindStats> => {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS packs, COALESCE(SUM(item_count), 0) AS entries, COALESCE(SUM(byte_size), 0) AS bytes
       FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = ?`
    )
    .bind(scope.userId, scope.vaultId, kind)
    .first<KindStats>()
  return row ?? { packs: 0, entries: 0, bytes: 0 }
}

/** Read and verify one listed pack, or null when it cannot be rolled up. */
const readInput = async (
  storage: R2Bucket,
  kind: PackKindName,
  pack: ListedPack
): Promise<Input | null> => {
  const object = await storage.get(pack.pack_key)
  if (!object) return null
  const bytes = new Uint8Array(await object.arrayBuffer())
  const parsed = await parsePack(bytes)
  if (parsed.entries.some((entry) => entry.kind !== kind)) return null
  return { pack, bytes, entries: parsed.entries }
}

const readInputs = async (
  storage: R2Bucket,
  kind: PackKindName,
  packs: readonly ListedPack[]
): Promise<Input[] | null> => {
  const inputs: Input[] = []
  for (let i = 0; i < packs.length; i += ROLLUP_FETCH_CONCURRENCY) {
    const window = await Promise.all(
      packs.slice(i, i + ROLLUP_FETCH_CONCURRENCY).map((pack) => readInput(storage, kind, pack))
    )
    for (const input of window) {
      if (!input) return null
      inputs.push(input)
    }
  }
  return inputs
}

const liveIndexes = async (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName,
  entries: readonly PackedEntry[]
): Promise<Set<number>> => {
  const live = liveJoin(kind, scope, entries)
  const rows = await db
    .prepare(`SELECT e.key AS i ${live.sql}`)
    .bind(...live.bind)
    .all<{ i: number }>()
  return new Set((rows.results ?? []).map((row) => row.i))
}

export interface RollupResult {
  replaced: number
  kept: number
  dropped: number
  packId: string | null
}

const scopeLog = (scope: VaultScope, kind: PackKindName) => ({
  user: scope.userId.slice(0, 8),
  vaultId: scope.vaultId,
  kind
})

/**
 * Roll up one run of `kind` packs when the kind lists more than its bound.
 * Returns null when nothing ran. Never moves the watermark: a rollup lists no
 * new rows, only fewer packs over the same coverage.
 */
export const rollupKind = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope,
  kind: PackKindName
): Promise<RollupResult | null> => {
  const stats = await kindStats(db, scope, kind)
  const bound = packCountBound(stats.entries, stats.bytes)
  if (stats.packs <= bound) return null

  const listed = await db
    .prepare(
      `SELECT id, pack_key, min_cursor, max_cursor, item_count, byte_size, cover_from, cover_through
       FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = ?
       ORDER BY min_cursor ASC, id ASC`
    )
    .bind(scope.userId, scope.vaultId, kind)
    .all<ListedPack>()
  const packs = listed.results ?? []
  let run = planRollup(packs)
  if (run.length === 0) {
    logger.warn('pack kind above its bound with no mergeable run', {
      ...scopeLog(scope, kind),
      ...stats,
      bound
    })
    return null
  }

  let inputs: Input[] | null
  try {
    inputs = await readInputs(storage, kind, run)
  } catch (error) {
    logger.error('rollup input pack failed verification; rollup skipped', {
      ...scopeLog(scope, kind),
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
  if (!inputs) {
    logger.error('rollup input pack object missing or of another kind; rollup skipped', {
      ...scopeLog(scope, kind),
      inputs: run.length
    })
    return null
  }

  let entries = inputs.flatMap((input) => input.entries.map((entry) => ({ input, entry })))
  let live = await liveIndexes(
    db,
    scope,
    kind,
    entries.map(({ entry }) => entry)
  )
  // A covered run whose entries all died still carries its range: merge it into
  // a neighbour instead of opening a coverage gap (protocol 08 §8.10).
  if (live.size === 0 && covered(run[0])) {
    const at = packs.indexOf(run[run.length - 1]) + 1
    const before = packs.indexOf(run[0]) - 1
    const neighbour =
      packs[at] && chains(run[run.length - 1], packs[at])
        ? { pack: packs[at], after: true }
        : packs[before] && chains(packs[before], run[0])
          ? { pack: packs[before], after: false }
          : null
    if (neighbour) {
      const extra = await readInputs(storage, kind, [neighbour.pack])
      if (!extra) return null
      run = neighbour.after ? [...run, neighbour.pack] : [neighbour.pack, ...run]
      inputs = neighbour.after ? [...inputs, ...extra] : [...extra, ...inputs]
      entries = inputs.flatMap((input) => input.entries.map((entry) => ({ input, entry })))
      live = await liveIndexes(
        db,
        scope,
        kind,
        entries.map(({ entry }) => entry)
      )
    }
  }
  const kept = entries.filter((_, index) => live.has(index))

  const packId = crypto.randomUUID()
  const minSortValue = Math.min(...run.map((pack) => pack.min_cursor))
  const maxSortValue = Math.max(...run.map((pack) => pack.max_cursor))
  const coverage: Coverage = covered(run[0])
    ? { from: run[0].cover_from ?? 0, through: run[run.length - 1].cover_through ?? 0 }
    : null
  const packKey = packObjectKey(scope, kind, minSortValue, maxSortValue, packId)

  let payloadBytes = 0
  if (kept.length > 0) {
    const plans: PackEntryPlan[] = kept.map(({ entry }) => ({
      kind,
      id: entry.id,
      sourceKey: entry.sourceKey,
      sortKey: entry.sortKey,
      sizeBytes: entry.length,
      ...(entry.meta
        ? {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the meta a build wrote into this index block, carried over verbatim
            meta: entry.meta as PackEntryPlanMeta
          }
        : {})
    }))
    const pack = openPack(plans)
    for (let i = 0; i < kept.length; i++) {
      await pack.writeEntry(plans[i], extractEntry(kept[i].input.bytes, kept[i].entry))
    }
    const built = await pack.finish()
    payloadBytes = built.payloadBytes
    await storage.put(packKey, built.bytes)
  }

  const swapped = await swapListing(db, scope, kind, {
    run,
    packId,
    packKey,
    minSortValue,
    maxSortValue,
    coverage,
    kept: kept.map(({ entry }) => entry),
    payloadBytes
  })
  if (!swapped) {
    // The one object-delete rule: this rollup's own row is absent.
    if (kept.length > 0) await storage.delete(packKey)
    logger.info('rollup lost a race with a purge, a shed, a push or another rollup; discarded', {
      ...scopeLog(scope, kind),
      inputs: run.length
    })
    return null
  }

  const entriesIn = entries.length
  logger.info('pack rollup', {
    ...scopeLog(scope, kind),
    packsBefore: stats.packs,
    packsAfter: stats.packs - run.length + (kept.length > 0 ? 1 : 0),
    bound,
    inputs: run.length,
    entriesIn,
    entriesKept: kept.length,
    deadRatio: entriesIn === 0 ? 0 : Number(((entriesIn - kept.length) / entriesIn).toFixed(3))
  })
  return {
    replaced: run.length,
    kept: kept.length,
    dropped: entriesIn - kept.length,
    packId: kept.length > 0 ? packId : null
  }
}

interface Swap {
  run: ListedPack[]
  packId: string
  packKey: string
  minSortValue: number
  maxSortValue: number
  coverage: Coverage
  kept: PackedEntry[]
  payloadBytes: number
}

/**
 * The index swap (protocol 08 §8.12), one D1 batch:
 *   1. record every input object for deletion after the grace period, only
 *      while every input row is still listed, no other row holds the merged
 *      `min_cursor`, and every kept entry is still current (the §7.15 recheck);
 *   2. delete the input rows when step 1 recorded all of them;
 *   3. insert the merged row under the same condition.
 * Deleting first keeps the listing from holding an input and its replacement
 * at once, and the `min_cursor` unique key from refusing the insert.
 */
const swapListing = async (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName,
  swap: Swap
): Promise<boolean> => {
  const ids = JSON.stringify(swap.run.map((pack) => pack.id))
  const n = swap.run.length
  const inVault = 'user_id = ? AND vault_id = ? AND item_kind = ?'
  const vaultBind = [scope.userId, scope.vaultId, kind]
  const current =
    swap.kept.length > 0
      ? allLive(liveJoin(kind, scope, swap.kept), swap.kept.length)
      : { sql: '1', bind: [] }
  const recorded = {
    sql: '(SELECT COUNT(*) FROM pack_replaced_objects WHERE replaced_by = ?) = ?',
    bind: [swap.packId, n]
  }
  const statements = [
    db
      .prepare(
        `INSERT INTO pack_replaced_objects (pack_key, user_id, vault_id, replaced_by, removed_at)
         SELECT pack_key, user_id, vault_id, ?, ? FROM pack_index
         WHERE ${inVault} AND id IN (SELECT value FROM json_each(?))
           AND (SELECT COUNT(*) FROM pack_index WHERE ${inVault} AND id IN (SELECT value FROM json_each(?))) = ?
           AND NOT EXISTS (SELECT 1 FROM pack_index WHERE ${inVault} AND min_cursor = ?
             AND id NOT IN (SELECT value FROM json_each(?)))
           AND ${current.sql}
         ON CONFLICT (pack_key) DO NOTHING`
      )
      .bind(
        swap.packId,
        Math.floor(Date.now() / 1000),
        ...vaultBind,
        ids,
        ...vaultBind,
        ids,
        n,
        ...vaultBind,
        swap.minSortValue,
        ids,
        ...current.bind
      ),
    db
      .prepare(
        `DELETE FROM pack_index WHERE ${inVault} AND id IN (SELECT value FROM json_each(?)) AND ${recorded.sql}`
      )
      .bind(...vaultBind, ids, ...recorded.bind)
  ]
  if (swap.kept.length > 0) {
    statements.push(
      packIndexInsert(
        db,
        scope,
        {
          id: swap.packId,
          kind,
          packKey: swap.packKey,
          minSortValue: swap.minSortValue,
          maxSortValue: swap.maxSortValue,
          itemCount: swap.kept.length,
          byteSize: swap.payloadBytes,
          coverage: swap.coverage
        },
        recorded
      )
    )
  }
  statements.push(
    db
      .prepare(
        `SELECT ${recorded.sql} AS swapped, EXISTS (SELECT 1 FROM pack_index WHERE id = ?) AS listed`
      )
      .bind(...recorded.bind, swap.packId)
  )
  const results = await db.batch<{ swapped: number; listed: number }>(statements)
  const check = results[results.length - 1].results?.[0]
  return Boolean(check?.swapped) && (swap.kept.length === 0 || Boolean(check?.listed))
}

/**
 * Delete replaced pack objects whose grace period has passed (protocol 08
 * §8.12), oldest first. An object some row still lists is never deleted (the
 * one object-delete rule); its stale record is dropped. A failed R2 delete
 * keeps the records, so the next pass retries.
 */
export const deleteReplacedPackObjects = async (
  db: D1Database,
  storage: R2Bucket,
  scope?: VaultScope
): Promise<number> => {
  const due = Math.floor(Date.now() / 1000) - PACK_REPLACED_GRACE_SECONDS
  const where = scope ? 'AND r.user_id = ? AND r.vault_id = ?' : ''
  const rows = await db
    .prepare(
      `SELECT r.pack_key, EXISTS (SELECT 1 FROM pack_index p
           WHERE p.user_id = r.user_id AND p.vault_id = r.vault_id AND p.pack_key = r.pack_key) AS listed
       FROM pack_replaced_objects r
       WHERE r.removed_at <= ? ${where}
       ORDER BY r.removed_at ASC
       LIMIT ?`
    )
    .bind(due, ...(scope ? [scope.userId, scope.vaultId] : []), REPLACED_DELETE_BATCH)
    .all<{ pack_key: string; listed: number }>()
  const found = rows.results ?? []
  if (found.length === 0) return 0
  const doomed = found.filter((row) => !row.listed).map((row) => row.pack_key)
  try {
    if (doomed.length > 0) await storage.delete(doomed)
  } catch (error) {
    logger.error('replaced pack objects not deleted; retried next pass', {
      objects: doomed.length,
      error: error instanceof Error ? error.message : String(error)
    })
    return 0
  }
  await db
    .prepare('DELETE FROM pack_replaced_objects WHERE pack_key IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(found.map((row) => row.pack_key)))
    .run()
  if (doomed.length > 0) logger.info('replaced pack objects deleted', { count: doomed.length })
  return doomed.length
}
