import { PACK_MAX_ENTRIES } from '@memry/contracts/pack-format'

import { createLogger } from '../lib/logger'
import {
  extractEntry,
  openPack,
  type PackEntryPlan,
  type PackKindName,
  type PackedEntry
} from './pack-format'
import {
  ALWAYS,
  allLive,
  packDocuments,
  packIndexInsert,
  packKeyRange,
  packObjectKey,
  type Coverage,
  type Guard,
  type VaultScope
} from './pack-index-write'
import { recordsLive } from './pack-record-selection'
import {
  REWRITE_PENDING,
  deleteUnlisted,
  listingBatch,
  recordUnlisted
} from './pack-replaced-objects'
import { liveIndexes, planOf, readPackObject } from './pack-repack'
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
 * before a full pack is rewritten. Empty when no two neighbours fit. An
 * `excluded` pack (one that could not be read) ends a run: merging across it
 * would list two packs over its range. So does a `rewriting` min_cursor, the
 * range of a pack waiting for its purge rewrite (protocol 08 §8.13), which
 * lists its pack back there.
 */
export const planRollup = (
  packs: readonly ListedPack[],
  excluded: ReadonlySet<string> = new Set(),
  rewriting: readonly number[] = []
): ListedPack[] => {
  let best: ListedPack[] = []
  for (let start = 0; start < packs.length; start++) {
    const run: ListedPack[] = []
    let entries = 0
    let bytes = 0
    for (let i = start; i < packs.length && run.length < ROLLUP_MAX_INPUTS; i++) {
      const pack = packs[i]
      const previous = run[run.length - 1]
      if (excluded.has(pack.id)) break
      if (previous && !chains(previous, pack)) break
      if (previous && rewriting.some((min) => min >= previous.min_cursor && min <= pack.min_cursor))
        break
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
export const liveJoin = (
  kind: PackKindName,
  scope: VaultScope,
  entries: readonly PackedEntry[]
): Guard =>
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

/** Read and verify one listed pack, or the reason it cannot be rolled up. */
const readInput = async (
  storage: R2Bucket,
  kind: PackKindName,
  pack: ListedPack
): Promise<Input | string> => {
  const read = await readPackObject(storage, kind, pack.pack_key)
  return typeof read === 'string' ? read : { pack, ...read }
}

const inputOf = (read: ReadonlyMap<string, Input>, pack: ListedPack): Input => {
  const input = read.get(pack.id)
  if (!input) throw new Error(`rollup input ${pack.id} was never read`)
  return input
}

/**
 * Read the packs of `packs` not yet in `read`, ROLLUP_FETCH_CONCURRENCY at a
 * time. Returns every pack that failed with its reason.
 */
const readInputs = async (
  storage: R2Bucket,
  kind: PackKindName,
  packs: readonly ListedPack[],
  read: Map<string, Input>
): Promise<Array<{ pack: ListedPack; reason: string }>> => {
  const failed: Array<{ pack: ListedPack; reason: string }> = []
  const missing = packs.filter((pack) => !read.has(pack.id))
  for (let i = 0; i < missing.length; i += ROLLUP_FETCH_CONCURRENCY) {
    const window = missing.slice(i, i + ROLLUP_FETCH_CONCURRENCY)
    const results = await Promise.all(window.map((pack) => readInput(storage, kind, pack)))
    for (let j = 0; j < window.length; j++) {
      const result = results[j]
      if (typeof result === 'string') failed.push({ pack: window[j], reason: result })
      else read.set(window[j].id, result)
    }
  }
  return failed
}

export interface CollidingPack {
  pack: ListedPack
  /** Its entries that are still current, with their bytes. */
  kept: Array<{ plan: PackEntryPlan; bytes: Uint8Array }>
  /** True at commit while every kept entry is still current (the §7.15 recheck). */
  current: Guard
}

/**
 * The listed pack whose `min_cursor` a build's first row has (#5229 P6), read,
 * verified and filtered to its current entries as a rollup input is. The build
 * rolls it and its new rows into one pack, because the unique key lets only
 * one row hold that `min_cursor` (protocol 08 §8.10). Null when no row holds
 * it, and the reason when the pack cannot be read.
 */
export const readCollidingPack = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope,
  kind: PackKindName,
  minCursor: number
): Promise<CollidingPack | string | null> => {
  const pack = await db
    .prepare(
      `SELECT id, pack_key, min_cursor, max_cursor, item_count, byte_size, cover_from, cover_through
       FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = ? AND min_cursor = ?`
    )
    .bind(scope.userId, scope.vaultId, kind, minCursor)
    .first<ListedPack>()
  if (!pack) return null
  const input = await readInput(storage, kind, pack)
  if (typeof input === 'string') return input
  const live = await liveIndexes(db, liveJoin(kind, scope, input.entries))
  const kept = input.entries.filter((_, index) => live.has(index))
  return {
    pack,
    kept: kept.map((entry) => ({
      plan: planOf(kind, entry),
      bytes: extractEntry(input.bytes, entry)
    })),
    current: kept.length > 0 ? allLive(liveJoin(kind, scope, kept), kept.length) : ALWAYS
  }
}

/** The leading candidates that fit one pack beside a colliding pack's entries. */
export const fitBeside = <T extends { sizeBytes: number }>(
  prior: CollidingPack,
  candidates: readonly T[]
): T[] => {
  let entries = prior.kept.length
  let bytes = prior.kept.reduce((sum, entry) => sum + entry.bytes.byteLength, 0)
  const fit: T[] = []
  for (const candidate of candidates) {
    entries += 1
    bytes += candidate.sizeBytes
    if (entries > PACK_MAX_ENTRIES || bytes > PACK_TARGET_BYTES) break
    fit.push(candidate)
  }
  return fit
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

  // The pending rewrites are read before the listing (VERIFY-5283 V1): a
  // rewrite that commits between the two reads then shows as a listed pack,
  // never as a gap the run could span. A purge that takes a pack out after
  // the pending read fails the swap (pendingUnchanged).
  const pending = await db
    .prepare(
      `SELECT pack_key FROM pack_replaced_objects
       WHERE user_id = ? AND vault_id = ? AND replaced_by = '${REWRITE_PENDING}'`
    )
    .bind(scope.userId, scope.vaultId)
    .all<{ pack_key: string }>()
  const pendingKeys = (pending.results ?? []).map(({ pack_key: key }) => key)
  const listed = await db
    .prepare(
      `SELECT id, pack_key, min_cursor, max_cursor, item_count, byte_size, cover_from, cover_through
       FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = ?
       ORDER BY min_cursor ASC, id ASC`
    )
    .bind(scope.userId, scope.vaultId, kind)
    .all<ListedPack>()
  const packs = listed.results ?? []
  const rewriting = pendingKeys.flatMap((key) => {
    const range = packKeyRange(key)
    return range?.kind === kind ? [range.minSortValue] : []
  })
  const plan = (excluded: ReadonlySet<string> = new Set()) => planRollup(packs, excluded, rewriting)
  let run = plan()
  // An unreadable input is excluded and the rollup re-planned over every listed
  // pack, so bad packs do not wedge the kind above its bound (VERIFY-5267 F4).
  // GETs stay within ROLLUP_MAX_INPUTS per rollup: once a re-plan would pass
  // it, only packs already read are planned. A bad pack stays listed: a reader
  // treats its 404 as a gap (§8.12), and the next rollup reads it again.
  const read = new Map<string, Input>()
  const excluded = new Set<string>()
  let fetched = 0
  const unreadIn = (list: readonly ListedPack[]) => list.filter((pack) => !read.has(pack.id))
  for (;;) {
    if (fetched + unreadIn(run).length > ROLLUP_MAX_INPUTS) {
      run = plan(new Set([...excluded, ...unreadIn(packs).map((pack) => pack.id)]))
    }
    if (run.length === 0) {
      logger.warn('pack kind above its bound with no mergeable run', {
        ...scopeLog(scope, kind),
        ...stats,
        bound,
        excluded: [...excluded]
      })
      return null
    }
    fetched += unreadIn(run).length
    const failed = await readInputs(storage, kind, run, read)
    if (failed.length === 0) break
    for (const { pack, reason } of failed) {
      logger.error('rollup input pack unreadable; excluded and re-planned', {
        ...scopeLog(scope, kind),
        packId: pack.id,
        reason
      })
      excluded.add(pack.id)
    }
    run = plan(excluded)
  }
  let inputs = run.map((pack) => inputOf(read, pack))

  let entries = inputs.flatMap((input) => input.entries.map((entry) => ({ input, entry })))
  let live = await liveIndexes(
    db,
    liveJoin(
      kind,
      scope,
      entries.map(({ entry }) => entry)
    )
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
      const [failed] = await readInputs(storage, kind, [neighbour.pack], read)
      if (failed) {
        logger.error('rollup neighbour pack unreadable; rollup skipped', {
          ...scopeLog(scope, kind),
          packId: failed.pack.id,
          reason: failed.reason
        })
        return null
      }
      run = neighbour.after ? [...run, neighbour.pack] : [neighbour.pack, ...run]
      inputs = run.map((pack) => inputOf(read, pack))
      entries = inputs.flatMap((input) => input.entries.map((entry) => ({ input, entry })))
      live = await liveIndexes(
        db,
        liveJoin(
          kind,
          scope,
          entries.map(({ entry }) => entry)
        )
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
    const plans = kept.map(({ entry }) => planOf(kind, entry))
    const pack = openPack(plans)
    for (let i = 0; i < kept.length; i++) {
      await pack.writeEntry(plans[i], extractEntry(kept[i].input.bytes, kept[i].entry))
    }
    const built = await pack.finish()
    payloadBytes = built.payloadBytes
    await storage.put(packKey, built.bytes)
  }

  const swapped = await swapListing(db, storage, scope, kind, {
    run,
    packId,
    packKey,
    minSortValue,
    maxSortValue,
    coverage,
    kept: kept.map(({ entry }) => entry),
    payloadBytes,
    pendingKeys
  })
  if (!swapped) {
    // The one object-delete rule: this rollup's own row is absent.
    if (kept.length > 0) await deleteUnlisted(storage, packKey)
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
  /** The vault's pending purge rewrites the plan excluded. */
  pendingKeys: readonly string[]
}

/**
 * Statements that take the listed packs `ids` out of the listing for the pack
 * `replacedBy` (protocol 08 §8.12): record every object for deletion after the
 * grace period, only while every row is still listed and `guard` holds, then
 * delete the rows. Guard the replacement's insert on `recorded`, so the rows go
 * and the replacement lists together or not at all. Deleting first keeps the
 * listing from holding an old pack and its replacement at once, and the
 * `min_cursor` unique key from refusing the insert.
 */
export const replacePacks = (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName,
  ids: readonly string[],
  replacedBy: string,
  guard: Guard
): { statements: D1PreparedStatement[]; recorded: Guard } => {
  const list = JSON.stringify(ids)
  const inVault = 'user_id = ? AND vault_id = ? AND item_kind = ?'
  const vaultBind = [scope.userId, scope.vaultId, kind]
  const recorded = {
    sql: '(SELECT COUNT(*) FROM pack_replaced_objects WHERE replaced_by = ?) = ?',
    bind: [replacedBy, ids.length]
  }
  return {
    recorded,
    statements: [
      db
        .prepare(
          `INSERT INTO pack_replaced_objects (pack_key, user_id, vault_id, replaced_by, removed_at)
           SELECT pack_key, user_id, vault_id, ?, ? FROM pack_index
           WHERE ${inVault} AND id IN (SELECT value FROM json_each(?))
             AND (SELECT COUNT(*) FROM pack_index WHERE ${inVault} AND id IN (SELECT value FROM json_each(?))) = ?
             AND ${guard.sql}
           ON CONFLICT (pack_key) DO NOTHING`
        )
        .bind(
          replacedBy,
          Math.floor(Date.now() / 1000),
          ...vaultBind,
          list,
          ...vaultBind,
          list,
          ids.length,
          ...guard.bind
        ),
      db
        .prepare(
          `DELETE FROM pack_index WHERE ${inVault} AND id IN (SELECT value FROM json_each(?)) AND ${recorded.sql}`
        )
        .bind(...vaultBind, list, ...recorded.bind)
    ]
  }
}

/**
 * The index swap (protocol 08 §8.12), one D1 batch: replacePacks over the
 * inputs while no other row holds the merged `min_cursor`, every kept entry
 * is still current (the §7.15 recheck), and no purge rewrite is pending that
 * the plan did not exclude, then the merged row. A purge after the plan took
 * a pack out of the listing that the run may span, and its rewrite would list
 * that range a second time (VERIFY-5283 V1). An object the
 * batch did not list is recorded for deletion at once (recordUnlisted).
 */
const swapListing = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope,
  kind: PackKindName,
  swap: Swap
): Promise<boolean> => {
  const ids = swap.run.map((pack) => pack.id)
  const current =
    swap.kept.length > 0
      ? allLive(liveJoin(kind, scope, swap.kept), swap.kept.length)
      : { sql: '1', bind: [] }
  const { statements, recorded } = replacePacks(db, scope, kind, ids, swap.packId, {
    sql: `NOT EXISTS (SELECT 1 FROM pack_index WHERE user_id = ? AND vault_id = ? AND item_kind = ?
        AND min_cursor = ? AND id NOT IN (SELECT value FROM json_each(?)))
      AND NOT EXISTS (SELECT 1 FROM pack_replaced_objects WHERE user_id = ? AND vault_id = ?
        AND replaced_by = '${REWRITE_PENDING}' AND pack_key NOT IN (SELECT value FROM json_each(?)))
      AND ${current.sql}`,
    bind: [
      scope.userId,
      scope.vaultId,
      kind,
      swap.minSortValue,
      JSON.stringify(ids),
      scope.userId,
      scope.vaultId,
      JSON.stringify(swap.pendingKeys),
      ...current.bind
    ]
  })
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
          coverage: swap.coverage,
          documents: packDocuments(kind, swap.kept)
        },
        recorded
      ),
      recordUnlisted(db, scope, swap.packId, swap.packKey)
    )
  }
  statements.push(
    db
      .prepare(
        `SELECT ${recorded.sql} AS swapped, EXISTS (SELECT 1 FROM pack_index WHERE id = ?) AS listed`
      )
      .bind(...recorded.bind, swap.packId)
  )
  const results = await listingBatch<{ swapped: number; listed: number }>(
    db,
    scope,
    swap.kept.length > 0 ? { packId: swap.packId, packKey: swap.packKey } : null,
    statements
  )
  const check = results[results.length - 1].results?.[0]
  return Boolean(check?.swapped) && (swap.kept.length === 0 || Boolean(check?.listed))
}
