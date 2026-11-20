import { PACK_LIST_MAX_PACKS_PER_VAULT } from '@memry/contracts/sync-api'

import { createLogger } from '../lib/logger'
import {
  openPack,
  type PackEntryPlan,
  type PackEntryPlanMeta,
  type PackKindName
} from './pack-format'
import {
  ALWAYS,
  advanceWatermark,
  allLive,
  packDocuments,
  packIndexInsert,
  packObjectKey,
  watermarkUnchanged,
  watermarkUpsert,
  type Coverage,
  type VaultScope
} from './pack-index-write'
import { roomForPack, roomGuard } from './pack-list'
import { isSelectedRecordVersion, recordRowShedInPlace } from './pack-record-selection'
import { loadSnapshotMeta, snapshotsLive, snapshotTieEnd } from './pack-snapshot-selection'
import { fitBeside, readCollidingPack, replacePacks, rollupKind } from './pack-rollup'
import {
  deleteReplacedPackObjects,
  deleteUnlisted,
  listingBatch,
  recordUnlisted
} from './pack-replaced-objects'
import { rewritePurgedPacks } from './pack-purge-rewrite'
import { selectCandidates } from './pack-selection'
import { updateEntrySource, updatesLive, type EntrySource } from './pack-update-selection'

const logger = createLogger('PackCompaction')

/**
 * Compaction core for the pack pipeline (#1839): select un-packed source
 * blobs for one user+vault+kind, fetch their EXACT bytes, concat into one
 * immutable pack, record it in D1, advance the watermark.
 *
 * DERIVED CACHE semantics — individual blobs stay the source of truth. A
 * build deletes nothing but its own unlisted object and never touches quota:
 * replaced/deleted items remain as dead bytes inside old packs until a rollup
 * (pack-rollup.ts) rewrites them.
 * Every step tolerates a retry (at-least-once queue delivery):
 *
 *   1. selection reads the watermark  -> same range re-selected after a crash
 *   2. the pack key carries the build's pack id -> no build ever writes a
 *      key another build wrote, so a purge deleting a dropped pack's object
 *      can never delete a rebuild of the same range (REVIEW-5260)
 *   3. the pack_index row carries UNIQUE (user_id, vault_id, item_kind,
 *      min_cursor), so a range whose first row shares a listed pack's
 *      min_cursor rolls that pack in (readCollidingPack)
 *   4. order is pack PUT first, then one D1 batch with the row and the
 *      watermark, which moves only with the row -> an object the batch did not
 *      list is recorded and deleted (recordUnlisted); a crash before the batch
 *      leaves invisible bytes for the orphan sweep
 *
 * ORPHAN DOCTRINE, hole-only windows: a window whose every source blob
 * vanished mid-flight still advances its watermark WITHOUT writing a
 * pack_index row. If an earlier attempt of that same range crashed after its
 * PUT but before its D1 row, the object it left at the deterministic key now
 * has no row pointing at it and can never be listed — permanent dead bytes.
 * Harmless today (derived cache; the key gets rewritten if the range is ever
 * rebuilt), but it is the concrete case a future cleanup sweep should cover:
 * list packs/<kind>/ objects with no matching pack_index row and delete them.
 */

// ---------------------------------------------------------------------------
// Tuning constants — see the subrequest arithmetic below before touching
// ---------------------------------------------------------------------------

// Absolute ceiling on one pack's payload bytes. Selection stops BEFORE
// crossing PACK_TARGET_BYTES, which is structurally far below this bound;
// PACK_HARD_MAX_BYTES remains as a documented tuning guard so nobody can
// raise the target back into isolate-unsafe territory without confronting it.
// A single oversized item cannot push past either because such items are
// excluded from packs entirely (MAX_PACKED_ITEM_BYTES, pack-selection.ts).
export const PACK_HARD_MAX_BYTES = 32 * 1024 * 1024

// Simultaneous source-blob GETs while building one pack. Mirrors the pull
// path's R2_CONCURRENCY reasoning: bounded windows keep connection pressure
// flat without meaningfully stretching wall time. Subrequest COUNT is
// unaffected — this only shapes concurrency, not budget.
export const PACK_FETCH_CONCURRENCY = 16

/**
 * Kinds the vault sweep and the cron backfill build packs for. A `record`
 * entry carries the pull item's signature, signer, clock, operation and
 * deletion state as its meta (protocol 08 §8.4.2), so a client verifies it
 * exactly as a pulled item. Released readers drop record packs before
 * download (§8.11). A `crdt_update` entry is one update row with
 * `{sequenceNum, signerDeviceId, createdAt}` as its meta (§8.4.3), read from
 * D1 with no R2 GET, so an update build is not bound by PACK_MAX_ITEMS (pack-selection.ts).
 */
export const PACKED_KINDS: readonly PackKindName[] = ['crdt_snapshot', 'record', 'crdt_update']

export interface PackBuildResult {
  built: boolean
  packKey: string | null
  itemCount: number
  byteSize: number
  minSortValue: number
  maxSortValue: number
  /** Entries skipped because their source blob vanished mid-flight. */
  holes: string[]
}

/**
 * Compact ONE range for one scope+kind end-to-end. Idempotent: a committed
 * range moved the watermark in the batch that listed it, so a rerun selects
 * above it and never rewrites R2 bytes (packs are immutable once written).
 */
export const compactOneRange = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope,
  kind: PackKindName
): Promise<PackBuildResult> => {
  // §8.14: a released reader's listing walk truncates past 1,000 packs.
  if (!(await roomForPack(db, scope))) {
    logger.warn('vault lists the maximum number of packs; build skipped', {
      userId: scope.userId,
      vaultId: scope.vaultId,
      kind,
      max: PACK_LIST_MAX_PACKS_PER_VAULT
    })
    return {
      built: false,
      packKey: null,
      itemCount: 0,
      byteSize: 0,
      minSortValue: 0,
      maxSortValue: 0,
      holes: []
    }
  }
  const selection = await selectCandidates(db, scope, kind)
  const noop: PackBuildResult = {
    built: false,
    packKey: null,
    itemCount: 0,
    byteSize: 0,
    minSortValue: selection.nextSortValue,
    maxSortValue: selection.nextSortValue,
    holes: []
  }
  if (!selection.ready) return noop
  // Compare-and-swap: a cron build and a queue build of one scope may select
  // the same window. Only the first to commit moves the watermark; the other
  // lists nothing and deletes its own object, so ranges never overlap and
  // covered_through never moves back (REVIEW-5267 P10).
  const unchanged = watermarkUnchanged(scope, kind, selection.watermark)
  if (selection.candidates.length === 0) {
    // Still persist watermark advancement so oversized-only windows progress.
    await advanceWatermark(
      db,
      scope,
      kind,
      selection.nextSortValue,
      selection.nextTiebreak,
      unchanged
    )
    return noop
  }

  const minSortValue = selection.candidates[0].sortKey
  // The watermark moves only with an applied pack_index insert (protocol 08
  // §8.10). A listed pack holding this min_cursor would refuse it, so the build
  // rolls that pack in, its rows first, and takes only the new rows that fit
  // beside them. When none fit or the pack cannot be read, record and update
  // builds hold the watermark: they sort on the unique server_cursor, so only
  // a foreign row collides, and rows passed unpacked would be in no pack and
  // in no gap (#5229 P6). Snapshot packs are a cache only and readers trust
  // the manifest, not their coverage, so a snapshot build leaves the rest of
  // the tie item by item and moves past it, once: later seconds still pack
  // and the colliding pack is not downloaded again (D-P6-EXIT).
  const prior = await readCollidingPack(db, storage, scope, kind, minSortValue)
  const candidates =
    prior === null || typeof prior === 'string'
      ? selection.candidates
      : fitBeside(prior, selection.candidates)
  if (typeof prior === 'string' || candidates.length === 0) {
    const context = {
      userId: scope.userId,
      vaultId: scope.vaultId,
      kind,
      minSortValue,
      reason: typeof prior === 'string' ? prior : 'listed pack full'
    }
    if (kind !== 'crdt_snapshot') {
      logger.error(
        'pack range collides with a listed pack it cannot roll in; watermark held',
        context
      )
      return noop
    }
    logger.warn(
      'snapshot tie collides with a listed pack it cannot roll in; left item by item',
      context
    )
    const tieEnd = await snapshotTieEnd(db, scope, minSortValue)
    await advanceWatermark(
      db,
      scope,
      kind,
      minSortValue,
      tieEnd ?? selection.candidates[selection.candidates.length - 1].tiebreak,
      unchanged
    )
    return noop
  }
  const last = candidates[candidates.length - 1]
  const maxSortValue = last.sortKey
  const coverage: Coverage = selection.coverage && {
    from: prior?.pack.cover_from ?? selection.coverage.from,
    through: last.sortKey
  }
  const packId = crypto.randomUUID()
  const packKey = packObjectKey(scope, kind, minSortValue, maxSortValue, packId)

  // Snapshot freshness metadata is read BEFORE any byte fetch. Order matters:
  // if a push lands mid-build it can now only make the fetched BYTES newer
  // than the advertised meta — a client comparing revisions under-trusts the
  // pack and falls back to the item GET (safe direction). The old bytes-first
  // order could advertise NEWER meta than the packed bytes, defeating the
  // client's freshness check entirely. Looked up in one batched pass,
  // best-effort: a missed lookup leaves meta empty and the client falls back
  // to the item GET.
  let metaBySourceKey: Map<string, PackEntryPlanMeta> | null = null
  if (kind === 'crdt_snapshot') {
    metaBySourceKey = await loadSnapshotMeta(
      db,
      scope,
      candidates.map((candidate) => candidate.sourceKey)
    )
  }

  // Plans carry everything known pre-fetch. Declared sizes come from D1 rows,
  // so openPack sizes its ONE buffer exactly here — before a single byte is
  // fetched — making peak memory knowable: buffer + one transient entry.
  const plans: PackEntryPlan[] = candidates.map((candidate) => {
    const plan: PackEntryPlan = {
      kind,
      id: candidate.id,
      sourceKey: candidate.sourceKey,
      sortKey: candidate.sortKey,
      sizeBytes: candidate.sizeBytes
    }
    const meta =
      candidate.record?.meta ?? candidate.update ?? metaBySourceKey?.get(candidate.sourceKey)
    if (meta) plan.meta = meta
    return plan
  })

  const pack = openPack([...(prior?.kept.map((entry) => entry.plan) ?? []), ...plans])
  for (const entry of prior?.kept ?? []) await pack.writeEntry(entry.plan, entry.bytes)

  // Fetch source bytes verbatim, bounded concurrency, preserving order, and
  // stream each straight into the pack buffer. Every iteration releases its
  // source references (`body`, `bytes` go out of scope) after the copy —
  // payload bytes are never retained twice, so peak stays at the pack buffer
  // plus ONE transient blob rather than payload + assembled copy.
  const holeLog = (plan: PackEntryPlan) => ({
    userId: scope.userId,
    vaultId: scope.vaultId,
    kind,
    id: plan.id
  })
  const holes: string[] = []
  const missingRecords: PackEntryPlan[] = []
  let writtenCount = 0
  const source =
    kind === 'crdt_update' ? updateEntrySource(db, scope, plans) : r2EntrySource(storage, plans)
  let offset = 0
  for (const window of source.windows) {
    const bodies = await source.read(window)
    const first = offset
    offset += window.length
    for (let j = 0; j < window.length; j++) {
      const plan = window[j]
      const record = candidates[first + j].record
      const body = bodies[j]
      // A null body is a HOLE, not a failure: the blob was replaced/deleted
      // between selection and fetch (or is a dangling row). Membership is
      // verified against the index block client-side; dead ranges fall back
      // to item GETs.
      if (!body) {
        // skipEntry, not a bare `continue`: the writer claims slots in strict
        // plan order, so an unclaimed slot makes the NEXT writeEntry throw and
        // abort the whole range before the watermark moves.
        logger.warn('pack entry source is missing; hole', { ...holeLog(plan), reason: 'not found' })
        pack.skipEntry(plan)
        holes.push(plan.id)
        if (record) missingRecords.push(plan)
        continue
      }
      const bytes = await body()
      // A zero-length blob is a hole for the same reason a vanished one is:
      // openPack rejects an empty entry, and that throw would escape before
      // the watermark moves, so the range re-selects and re-throws forever.
      // Real ciphertext is never empty (XChaCha20 always carries a MAC), but
      // an aborted or truncated write can leave a 0-byte object behind, and a
      // row declaring size_bytes 0 slips past the drift guard below (0 === 0).
      if (bytes.byteLength === 0) {
        logger.warn('pack entry source is empty; hole', { ...holeLog(plan), reason: 'empty' })
        pack.skipEntry(plan)
        holes.push(plan.id)
        continue
      }
      if (bytes.byteLength !== plan.sizeBytes) {
        // Declared-vs-actual drift: the blob was replaced under a stable key
        // after selection sized this pack's buffer. Copying it would overrun
        // or misalign the layout, so treat it exactly like a vanished blob —
        // skip, let the client fall back to the item GET (individual blobs
        // remain the source of truth). Nothing has been persisted yet, so
        // skipping is side-effect-free.
        logger.warn('pack entry drifted from declared size; skipping', {
          userId: scope.userId,
          vaultId: scope.vaultId,
          kind,
          id: plan.id,
          declared: plan.sizeBytes,
          actual: bytes.byteLength
        })
        pack.skipEntry(plan)
        holes.push(plan.id)
        continue
      }
      // A record's meta and payload must be one version (protocol 08 §8.4.2).
      // The meta and content_hash came from one row read, and the payload is
      // that version only when it hashes to that content_hash (the push stores
      // exactly the bytes it hashed). A push that replaced the row after
      // selection fails here or 404s above, and its new row sits at a higher
      // cursor, so the tail serves it.
      if (record && !(await isSelectedRecordVersion(bytes, record))) {
        logger.warn('record payload is not the selected version; hole', {
          ...holeLog(plan),
          reason: 'content hash mismatch'
        })
        pack.skipEntry(plan)
        holes.push(plan.id)
        continue
      }
      await pack.writeEntry(plan, bytes)
      writtenCount++
    }
  }

  // Invariant: the watermark never passes a row the shed would empty under the
  // current retention. The shed empties a tombstone in place at its cursor, so
  // a hole for it would never be revisited; abandon the range and let the next
  // run read the row as it then is (REVIEW-5253, VERIFY-5253). A row whose
  // retention grows meanwhile is not emptied: the shed rechecks expiry in the
  // write (cleanup.ts).
  if (await recordRowShedInPlace(db, scope, missingRecords)) {
    logger.info('record row shed during a build; range abandoned', {
      userId: scope.userId,
      vaultId: scope.vaultId,
      kind
    })
    return { ...noop, holes }
  }

  if (writtenCount === 0) {
    await advanceWatermark(db, scope, kind, last.sortKey, last.tiebreak, unchanged)
    return { ...noop, holes }
  }

  const built = await pack.finish()

  // Order matters: OBJECT FIRST, then D1 row, then watermark (module doc).
  // built.bytes is the single assembly buffer trimmed to file length — there
  // is no second full-size allocation anywhere in this flow.
  await storage.put(packKey, built.bytes)

  // A note delete purges its body rows and rewrites each body pack that
  // holds the note (#2986, protocol 07 §7.15, 08 §8.13). One that commits after this run
  // selected would not find this pack and would leave the deleted body in it,
  // so the row (with the documents it holds) and the watermark commit
  // together and only while every packed body row still exists with the packed
  // version. Otherwise the next run reselects.
  const current =
    kind === 'crdt_snapshot'
      ? allLive(snapshotsLive(scope, built.entries), built.entries.length)
      : kind === 'crdt_update'
        ? allLive(updatesLive(scope, built.entries), built.entries.length)
        : ALWAYS
  // The listing cap is rechecked in the insert, against the rows before it:
  // another kind's build or a concurrent run may have taken the last slot.
  const room = roomGuard(scope)
  const guard = {
    sql: `(${current.sql}) AND (${room.sql}) AND (${unchanged.sql})`,
    bind: [...current.bind, ...room.bind, ...unchanged.bind]
  }
  const replacing =
    prior &&
    replacePacks(db, scope, kind, [prior.pack.id], packId, {
      sql: `(${guard.sql}) AND (${prior.current.sql})`,
      bind: [...guard.bind, ...prior.current.bind]
    })
  // The one object-delete rule (VERIFY-5260): the object goes only when this
  // build's own row is absent after the batch, whether the guard refused it
  // or a concurrent build of the range won. A listed row always has its object.
  const listed = { sql: 'EXISTS (SELECT 1 FROM pack_index WHERE id = ?)', bind: [packId] }
  // The watermark and its coverage anchor move only with this row (§8.10).
  const results = await listingBatch<{ listed: number }>(db, scope, { packId, packKey }, [
    ...(replacing?.statements ?? []),
    packIndexInsert(
      db,
      scope,
      {
        id: packId,
        kind,
        packKey,
        minSortValue,
        maxSortValue,
        itemCount: built.entries.length,
        byteSize: built.payloadBytes,
        coverage,
        documents: packDocuments(kind, built.entries)
      },
      replacing?.recorded ?? guard
    ),
    watermarkUpsert(
      db,
      scope,
      kind,
      last.sortKey,
      last.tiebreak,
      listed,
      coverage?.through ?? null
    ),
    recordUnlisted(db, scope, packId, packKey),
    db.prepare(`SELECT ${listed.sql} AS listed`).bind(...listed.bind)
  ])
  if (!results[results.length - 1].results?.[0]?.listed) {
    await deleteUnlisted(storage, packKey)
    logger.warn(
      'pack not listed (body purge or prune, listing cap, or a build that moved the watermark); discarded',
      {
        userId: scope.userId,
        vaultId: scope.vaultId,
        kind
      }
    )
    return { ...noop, holes }
  }

  logger.info('pack built', {
    userId: scope.userId,
    vaultId: scope.vaultId,
    kind,
    items: built.entries.length,
    holes: holes.length,
    payloadBytes: built.payloadBytes
  })

  return {
    built: true,
    packKey,
    itemCount: built.entries.length,
    byteSize: built.payloadBytes,
    minSortValue,
    maxSortValue,
    holes
  }
}

/** Source blobs from R2, PACK_FETCH_CONCURRENCY GETs at a time, read one by one. */
const r2EntrySource = (storage: R2Bucket, plans: PackEntryPlan[]): EntrySource => {
  const windows: PackEntryPlan[][] = []
  for (let i = 0; i < plans.length; i += PACK_FETCH_CONCURRENCY) {
    windows.push(plans.slice(i, i + PACK_FETCH_CONCURRENCY))
  }
  return {
    windows,
    read: async (window) =>
      (await Promise.all(window.map((plan) => storage.get(plan.sourceKey)))).map((body) =>
        body ? async () => new Uint8Array(await body.arrayBuffer()) : null
      )
  }
}

/**
 * Compact every supported kind for one vault. Called by the queue consumer
 * (push-triggered) and the cron-paced backfill alike. A failure mid-kind
 * propagates so the caller can retry; completed kinds keep their watermarks.
 */
export const compactVault = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope
): Promise<PackBuildResult[]> => {
  const results: PackBuildResult[] = []
  // A purge's pending rewrites run first: a deletion pass that meets an object
  // whose rewrite is still pending past its grace resets the kind (protocol 08
  // §8.13). The deletion runs next and again after the builds, so a build that
  // throws cannot keep a purged body past its deadline: this message may be
  // the purge's delayed retry.
  let failure: { error: unknown } | null = null
  let rewritesPending = true
  try {
    rewritesPending = (await rewritePurgedPacks(db, storage, scope)).pending
  } catch (error) {
    failure = { error }
  }
  await deleteReplacedPackObjects(db, storage, scope)
  try {
    // Rollup first: at the listing cap it is what makes room for the build
    // (protocol 08 §8.14). One rollup per kind per message, only above the bound.
    for (const kind of PACKED_KINDS) await rollupLogged(db, storage, scope, kind)
    // A push nudge never builds `crdt_update`: only the backfill tick does, under
    // the minimum fill (pack-sizing.ts), so pushes cannot list tiny packs. A kind
    // whose build listed a pack rolls up once more, so the message ends with the
    // kind at or under its bound (§8.14). Budget, of 1000 subrequests: three
    // rollups 3 x 72 = 216, two builds ~269 + ~262, two more rollups 2 x 72 = 144,
    // two replaced-object deletions 2 x 4 = 8, four purge rewrites at worst
    // 4 x 10 + 1 = 41 (a GET, two attempts of a live read, PUT, batch and
    // unlisted delete, and a kind reset): ~940.
    for (const kind of PACKED_KINDS.filter((k) => k !== 'crdt_update')) {
      const result = await compactOneRange(db, storage, scope, kind)
      results.push(result)
      if (result.built) await rollupLogged(db, storage, scope, kind)
    }
  } catch (error) {
    failure = { error }
  }
  // Objects still due fail the message, so Queues redelivers it (max_retries 3,
  // no retry delay) inside the purge deadline instead of acking it. Builds this
  // message committed stay committed: a redelivery finds their watermarks moved
  // and lists nothing twice. A build error is logged and kept as the cause,
  // also when the pass itself throws (VERIFY-5267).
  let passFailure: { error: unknown } | null = null
  let pending = true
  try {
    pending = (await deleteReplacedPackObjects(db, storage, scope)).pending
  } catch (error) {
    passFailure = { error }
  }
  if (pending || rewritesPending) {
    logger.error('replaced pack objects still due after the compaction message; redelivered', {
      userId: scope.userId,
      vaultId: scope.vaultId,
      ...(passFailure ? { passError: errorMessage(passFailure.error) } : {}),
      ...(failure ? { buildError: errorMessage(failure.error) } : {})
    })
    const cause = failure ?? passFailure
    throw new Error('replaced pack objects still due', cause ? { cause: cause.error } : {})
  }
  if (failure) throw failure.error
  return results
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** A rollup failure leaves the listing as it was; the build still runs. */
const rollupLogged = async (
  db: D1Database,
  storage: R2Bucket,
  scope: VaultScope,
  kind: PackKindName
): Promise<void> => {
  try {
    await rollupKind(db, storage, scope, kind)
  } catch (error) {
    logger.error('pack rollup failed', {
      userId: scope.userId,
      vaultId: scope.vaultId,
      kind,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
