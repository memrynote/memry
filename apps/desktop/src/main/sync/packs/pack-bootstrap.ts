import path from 'node:path'
import { promises as fs } from 'node:fs'

import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type { InitialSyncProgressEvent } from '@memry/contracts/ipc-events'
import {
  CrdtUpdatePackEntryMetaSchema,
  PackListResponseSchema,
  type CrdtManifestDocument,
  type CrdtUpdatePackEntryMeta,
  type PackCoverage,
  type PackSummary
} from '@memry/contracts/sync-api'
import type { PackIndexEntry } from '@memry/contracts/pack-format'

import { createLogger } from '../../lib/logger'
import { recordBootstrapBytes } from '../bootstrap-metrics'
import type { PageApplyHandle } from '../bulk-apply'
import { SYNC_STATE_KEYS } from '../engine/sync-context'
import { getFromServer } from '../http-client'
import { readManifestPages } from '../manifest-check'
import { discardPackFile, downloadPackToFile } from './pack-download'
import { readBodyManifest } from './body-manifest'
import {
  planDocument,
  type BodyWatermark,
  type PackedSnapshot,
  type PackedUpdate,
  type PackSnapshotMeta
} from './body-plan'
import type { PackBodyApplier } from './pack-body-applier'
import { openPackFile, type PackFileHandle } from './pack-file-reader'
import { planRecordPacks, type PackedRecords, type RecordManifestRead } from './record-packs'

const log = createLogger('PackBootstrap')

/**
 * Fresh-device pack bootstrap (#1840) — the client half of the compaction
 * pipeline landed in #1839.
 *
 * The shape of the win: a cold vault used to spend two `crdt_pull` GETs per
 * note just to establish each note body's baseline, paced against a 600/min
 * bucket. A `crdt_snapshot` pack carries hundreds of those baselines in ONE
 * transfer, so the sweep that follows finds every packed note already seeded
 * and issues zero `/sync/crdt/snapshot/:noteId` GETs for them.
 *
 * RECORD PACKS ARE NOT APPLIED HERE. Their entries are rebuilt as pull items
 * and reconciled against `GET /sync/manifest` (`record-packs.ts`), and the
 * pull applies them through its own decrypt, signature and clock path before
 * it moves `SYNC_STATE_KEYS.LAST_CURSOR` (#5390). Nothing here touches it.
 *
 * FAILURE DISCIPLINE. Every path out of this module — an old server 404, a
 * deployment with no presign secrets, zero packs, an expired URL, a malformed
 * response, a checksum mismatch, a decrypt failure, a transfer that never
 * finished — falls back to the item-granular bootstrap with the cursor
 * untouched and nothing surfaced to the user. A bad pack is never fatal: packs
 * are a derived cache, the individual blobs remain the source of truth.
 */

/** Page size for the watermark commit. One page ≈ one SQLite transaction. */
export const PACK_APPLY_PAGE_ENTRIES = 100

/** Packs fetched per `GET /sync/packs` page (the server caps at 50). */
export const PACK_LIST_PAGE_LIMIT = 50

/** Hard ceiling on pages walked, so a pathological vault cannot loop forever. */
const MAX_PACK_LIST_PAGES = 20

/** Concurrent pack transfers. Matches the attachment queue's ceiling. */
export const MAX_PARALLEL_PACK_DOWNLOADS = 3

/** Clock-skew margin subtracted from a presigned URL's claimed expiry. */
const PRESIGN_EXPIRY_SAFETY_SECONDS = 30

/** Floor between two re-lists for fresh presigned URLs, shared by all workers. */
const PACK_RELIST_MIN_INTERVAL_SECONDS = 60

export interface PackBootstrapDeps {
  getAccessToken: () => Promise<string | null>
  /** Directory for pack temp files. Cleaned on success, failure and abort. */
  tempDir: string
  bodies: PackBodyApplier
  readManifest?: typeof readBodyManifest
  /** `GET /sync/manifest`, read only when record packs are in hand. */
  readRecordManifest?: (token: string, signal?: AbortSignal) => Promise<RecordManifestRead | null>
  /** Opens the #1831 page transaction the watermark is committed inside. */
  beginPage: () => PageApplyHandle
  getStateValue: (key: string) => string | null | undefined
  setStateValue: (key: string, value: string) => void
  emit: (channel: string, data: unknown) => void
  signal?: AbortSignal
  /** Pacing hook shared with the bootstrap session's elevated limits. */
  pace?: () => Promise<void>
  /** Seams — production defaults hit the network and the filesystem. */
  fetchPackPage?: (token: string, cursor: string | null) => Promise<unknown>
  download?: typeof downloadPackToFile
  openPack?: (filePath: string) => Promise<PackFileHandle>
  discard?: (filePath: string) => Promise<void>
  recordBytes?: (channel: 'records' | 'crdt' | 'attachments', byteCount: number) => void
  now?: () => number
  pageEntries?: number
  maxParallelDownloads?: number
}

export interface PackBootstrapResult {
  /** False when no pack was ever opened — the pure item-granular fallback. */
  usedPacks: boolean
  packsApplied: number
  entriesApplied: number
  entriesSkipped: number
  entriesFailed: number
  /** Packed updates applied across every document. */
  updatesApplied: number
  /** Highest contiguously-applied pack cursor, or null when none advanced. */
  appliedThroughCursor: number | null
  /** Reconciled record packs for the pull, null when they cannot be used. */
  records: PackedRecords | null
}

const emptyResult = (): PackBootstrapResult => ({
  usedPacks: false,
  packsApplied: 0,
  entriesApplied: 0,
  entriesSkipped: 0,
  entriesFailed: 0,
  updatesApplied: 0,
  appliedThroughCursor: null,
  records: null
})

const defaultReadRecordManifest = async (
  token: string,
  signal?: AbortSignal
): Promise<RecordManifestRead | null> => {
  try {
    return await readManifestPages(token, { isOnline: () => true, ...(signal ? { signal } : {}) })
  } catch (error) {
    log.info('Record manifest read failed — record packs unused', {
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

const defaultFetchPackPage = async (token: string, cursor: string | null): Promise<unknown> => {
  const query = new URLSearchParams({ limit: String(PACK_LIST_PAGE_LIMIT) })
  if (cursor) query.set('cursor', cursor)
  return getFromServer<unknown>(`/sync/packs?${query.toString()}`, token)
}

interface PackListing {
  packs: PackSummary[]
  /**
   * True when the page walk hit `MAX_PACK_LIST_PAGES` with a cursor still
   * pending, so packs OLDER than everything listed exist and were never seen.
   * Contiguity is meaningless across that hole — see `commitPage`.
   */
  truncated: boolean
  /** The first page's `record` coverage statement (§8.10), when it made one. */
  recordCoverage?: PackCoverage
}

/**
 * Walk `GET /sync/packs` newest-first and return the packs this client can
 * actually use. Resolves an EMPTY list for every "no packs here" answer — an
 * old server's 404, a non-2xx of any kind, a body that fails schema
 * validation, or a page of packs with no presigned URLs — so the caller has
 * exactly one fallback branch to take.
 */
const listUsablePacks = async (
  deps: PackBootstrapDeps,
  token: string,
  nowSeconds: number
): Promise<PackListing> => {
  const fetchPage = deps.fetchPackPage ?? defaultFetchPackPage
  const usable: PackSummary[] = []
  let cursor: string | null = null
  let truncated = false
  let recordCoverage: PackCoverage | undefined

  for (let page = 0; page < MAX_PACK_LIST_PAGES; page++) {
    let raw: unknown
    try {
      raw = await fetchPage(token, cursor)
    } catch (error) {
      // 404 (old server), 501, 429, 5xx, offline — all mean "no packs".
      log.debug('Pack list unavailable — using the item-granular bootstrap', {
        error: error instanceof Error ? error.message : String(error)
      })
      return { packs: [], truncated: false }
    }

    const parsed = PackListResponseSchema.safeParse(raw)
    if (!parsed.success) {
      log.info('Pack list failed validation — using the item-granular bootstrap')
      return { packs: [], truncated: false }
    }

    for (const pack of parsed.data.packs) {
      // No URL: a deployment without presign secrets. No expiry, or one
      // already past: a page that sat too long. Both mean item-granular.
      if (!pack.url) continue
      if (pack.expiresAt === undefined) continue
      if (pack.expiresAt - PRESIGN_EXPIRY_SAFETY_SECONDS <= nowSeconds) continue
      usable.push(pack)
    }
    if (page === 0) {
      recordCoverage = parsed.data.coverage?.find((entry) => entry.itemKind === 'record')
    }

    cursor = parsed.data.nextCursor ?? null
    if (!cursor) break
    truncated = page === MAX_PACK_LIST_PAGES - 1
  }

  return { packs: usable, truncated, ...(recordCoverage ? { recordCoverage } : {}) }
}

/**
 * Highest pack cursor covered by an unbroken run of fully-applied packs,
 * counting from the OLDEST pack upward.
 *
 * Contiguity is the whole point. Transfers run newest-first so recent notes
 * appear first, which means the completed set is normally a suffix, not a
 * prefix — and a watermark that recorded the highest completed pack would
 * claim coverage over ranges never applied. Advancing only across an unbroken
 * run from the bottom keeps the claim true, at the cost of re-opening at most
 * one interrupted pack on resume. Re-opening is cheap and idempotent: every
 * note that already landed fails its freshness gate and is skipped.
 *
 * TIES ARE ADVANCED AS A GROUP, never one pack at a time. `crdt_snapshot`
 * packs sort on `created_at` epoch seconds, which the compaction pipeline
 * documents as tying heavily, and a same-second group that exceeds the byte
 * target is split across packs — so two packs can share a `maxCursor`. The
 * resume filter is `maxCursor > watermark`, so recording a value another,
 * uncompleted pack also carries would exclude that pack from this run and from
 * every run after it, permanently. A tie group therefore advances the
 * watermark only when EVERY pack in it completed.
 */
export const contiguousAppliedCursor = (
  packs: PackSummary[],
  completed: ReadonlySet<string>
): number | null => {
  const ascending = [...packs].toSorted((a, b) => a.maxCursor - b.maxCursor)
  let watermark: number | null = null
  for (let i = 0; i < ascending.length;) {
    const cursor = ascending[i].maxCursor
    let groupComplete = true
    while (i < ascending.length && ascending[i].maxCursor === cursor) {
      if (!completed.has(ascending[i].id)) groupComplete = false
      i++
    }
    if (!groupComplete) break
    watermark = cursor
  }
  return watermark
}

interface ApplyCounters {
  applied: number
  skipped: number
  failed: number
  updates: number
}

/** One opened pack and the entries of its own kind. */
interface OpenedPack {
  pack: PackSummary
  handle: PackFileHandle
  filePath: string
}

const readUpdateMeta = (entry: PackIndexEntry): CrdtUpdatePackEntryMeta | null => {
  const parsed = CrdtUpdatePackEntryMetaSchema.safeParse(entry.meta)
  return parsed.success ? parsed.data : null
}

/**
 * Run the fresh-device pack bootstrap. Returns `usedPacks: false` whenever no
 * pack was opened, which is the caller's signal that nothing changed and the
 * item-granular path must run exactly as it always has.
 *
 * Every body pack is downloaded first, then the body manifest is read (after
 * the reader holds the pack bytes, protocol 08 §8.4.3), then each document is
 * opened once and takes its confirmed snapshot and its contiguous packed
 * updates in one pass (#5390).
 */
export const runPackBootstrap = async (deps: PackBootstrapDeps): Promise<PackBootstrapResult> => {
  const now = deps.now ?? (() => Date.now())
  const recordBytes = deps.recordBytes ?? recordBootstrapBytes
  const download = deps.download ?? downloadPackToFile
  const open = deps.openPack ?? ((filePath: string) => openPackFile(filePath))
  const discard = deps.discard ?? discardPackFile
  const readManifest = deps.readManifest ?? readBodyManifest
  const readRecordManifest = deps.readRecordManifest ?? defaultReadRecordManifest
  const pageEntries = Math.max(1, deps.pageEntries ?? PACK_APPLY_PAGE_ENTRIES)
  const parallel = Math.max(1, deps.maxParallelDownloads ?? MAX_PARALLEL_PACK_DOWNLOADS)

  const accessToken = await deps.getAccessToken().catch(() => null)
  if (!accessToken) return emptyResult()

  const listing = await listUsablePacks(deps, accessToken, Math.floor(now() / 1000))
  if (listing.packs.length === 0) return emptyResult()

  const resumeFrom = Number(deps.getStateValue(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR) ?? '')
  const alreadyCovered = Number.isFinite(resumeFrom) ? resumeFrom : 0
  // Newest-first: the response is already max_cursor DESC, and re-sorting keeps
  // that true across pages. Snapshot packs fully below a previous run's
  // watermark are already applied — skip them rather than re-reading their
  // bytes. The watermark is on the snapshot axis (epoch seconds), so it says
  // nothing about update packs, which are always read again: a document that
  // already holds an update skips it on its own watermark.
  const snapshotPacks = listing.packs
    .filter((pack) => pack.itemKind === 'crdt_snapshot' && pack.maxCursor > alreadyCovered)
    .toSorted((a, b) => b.maxCursor - a.maxCursor)
  const updatePacks = listing.packs.filter((pack) => pack.itemKind === 'crdt_update')
  // Records only before the first cursor: a device that has one already holds
  // every record below it, and its tail must not move back (#5390).
  const recordPacks =
    deps.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) == null
      ? listing.packs.filter((pack) => pack.itemKind === 'record')
      : []
  const packs = [...snapshotPacks, ...updatePacks, ...recordPacks]
  if (packs.length === 0) return emptyResult()

  log.info('Pack bootstrap starting', {
    packCount: packs.length,
    snapshotPacks: snapshotPacks.length,
    updatePacks: updatePacks.length,
    recordPacks: recordPacks.length,
    resumeAboveCursor: alreadyCovered
  })

  const counters: ApplyCounters = { applied: 0, skipped: 0, failed: 0, updates: 0 }
  const completed = new Set<string>()
  let relist: { at: number; pending: Promise<Map<string, PackSummary>> } | null = null
  let packsApplied = 0
  let appliedThroughCursor: number | null = null
  // The listed item count until the packs are indexed, then the document count.
  let totalDocuments = packs.reduce((sum, pack) => sum + pack.itemCount, 0)
  let processedDocuments = 0

  const emitProgress = (): void => {
    deps.emit(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
      phase: 'packs',
      processedItems: processedDocuments,
      totalItems: totalDocuments
    } satisfies InitialSyncProgressEvent)
  }

  /**
   * Persist the watermark INSIDE the page transaction, never after it: an
   * interrupted bootstrap must never find a committed page whose watermark did
   * not commit with it, nor the reverse.
   */
  const commitPage = async (): Promise<void> => {
    // begin -> setStateValue -> commit runs without an await, so no other
    // writer can open a second page session inside this window.
    const handle = deps.beginPage()
    let committed = false
    try {
      // A truncated listing means older packs exist that were never listed, so
      // the oldest pack in hand is not the bottom of the run and "contiguous
      // from the oldest" claims coverage of a range nothing walked. Apply the
      // packs, record nothing: the next run re-lists from the top.
      const watermark = listing.truncated ? null : contiguousAppliedCursor(snapshotPacks, completed)
      if (watermark !== null && watermark !== appliedThroughCursor) {
        deps.setStateValue(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR, String(watermark))
        appliedThroughCursor = watermark
      }
      handle.commit()
      committed = true
    } finally {
      if (!committed) handle.rollback()
    }
    await handle.flushFiles()
  }

  /**
   * The presigned URL for a pack that is ABOUT to transfer, re-minted when the
   * one from the list has aged out.
   *
   * Every URL in a `GET /sync/packs` page is signed once, at list time, with a
   * TTL measured in minutes. A vault big enough to need packs routinely
   * out-runs it: 24MiB packs, three in flight, on a slow or suspended link, and
   * every pack still queued when the TTL lapses gets a 403 from R2 and drops
   * out of the run. Re-listing mints fresh signatures for the remainder. One
   * re-list is shared by all workers and reused for a minute, so a whole queue
   * of aged-out packs costs one extra request, not one per pack.
   */
  const freshUrl = async (pack: PackSummary): Promise<string | null> => {
    const nowSeconds = Math.floor(now() / 1000)
    const live = (candidate: PackSummary): boolean =>
      candidate.url !== undefined &&
      candidate.expiresAt !== undefined &&
      candidate.expiresAt - PRESIGN_EXPIRY_SAFETY_SECONDS > nowSeconds
    if (live(pack)) return pack.url!

    if (!relist || nowSeconds - relist.at >= PACK_RELIST_MIN_INTERVAL_SECONDS) {
      relist = {
        at: nowSeconds,
        pending: listUsablePacks(deps, accessToken, nowSeconds).then(
          (result) => new Map(result.packs.map((entry) => [entry.id, entry]))
        )
      }
    }
    const refreshed = (await relist.pending).get(pack.id)
    if (refreshed && live(refreshed)) return refreshed.url!

    log.info('Pack URL expired and could not be re-signed — items fall back to item GETs', {
      packId: pack.id
    })
    return null
  }

  const fetchOne = async (pack: PackSummary): Promise<OpenedPack | null> => {
    const filePath = path.join(deps.tempDir, `${sanitizeId(pack.id)}.pack`)
    const url = await freshUrl(pack)
    if (!url) return null
    try {
      await download({
        url,
        destPath: filePath,
        ...(deps.signal ? { signal: deps.signal } : {}),
        ...(deps.pace ? { pace: deps.pace } : {})
      })
    } catch (error) {
      log.info('Pack transfer failed — items fall back to the item-granular path', {
        packId: pack.id,
        error: error instanceof Error ? error.message : String(error)
      })
      await discard(filePath)
      return null
    }
    try {
      return { pack, handle: await open(filePath), filePath }
    } catch (error) {
      // Corrupt footer magic, wrong version, bad payload digest, truncated
      // file: the whole pack is discarded and every item in it stays on the
      // item-granular path. Never fatal.
      log.warn('Discarding an unreadable pack — items fall back to item GETs', {
        packId: pack.id,
        error: error instanceof Error ? error.message : String(error)
      })
      await discard(filePath)
      return null
    }
  }

  try {
    await fs.mkdir(deps.tempDir, { recursive: true })
  } catch (error) {
    log.info('Could not create the pack temp directory — item-granular bootstrap', { error })
    return emptyResult()
  }

  emitProgress()

  // Newest range first, bounded parallelism: workers pull from one shared
  // cursor so the ordering survives concurrency.
  const opened: Array<OpenedPack | null> = Array.from({ length: packs.length }, () => null)
  let next = 0
  const workers = Array.from({ length: Math.min(parallel, packs.length) }, async () => {
    for (;;) {
      if (deps.signal?.aborted) return
      const index = next++
      if (index >= packs.length) return
      opened[index] = await fetchOne(packs[index])
    }
  })
  await Promise.all(workers)

  const held = opened.filter((entry): entry is OpenedPack => entry !== null)
  try {
    if (held.length === 0 || deps.signal?.aborted) {
      return { ...emptyResult(), usedPacks: held.length > 0 }
    }

    // Read after the pack bytes are held, in this run (protocol 08 §8.4.3).
    const manifest = await readManifest(accessToken, deps.signal ? { signal: deps.signal } : {})
    const recordHeld = held.filter(({ pack }) => pack.itemKind === 'record')
    const records =
      recordHeld.length > 0
        ? await planRecordPacks(
            recordHeld,
            listing.recordCoverage,
            () => readRecordManifest(accessToken, deps.signal),
            (byteCount) => recordBytes('records', byteCount)
          )
        : null
    const settledBodies = new Set<string>()

    const readOf = (handle: PackFileHandle, entry: PackIndexEntry) => async () => {
      const bytes = await handle.readEntry(entry)
      recordBytes('crdt', bytes.byteLength)
      return bytes
    }

    // Per document, every packed snapshot and update it has. A document is
    // processed once, in the order its first snapshot pack came (newest
    // first), then the update-only documents.
    const snapshotsOf = new Map<string, PackedSnapshot[]>()
    const updatesOf = new Map<string, PackedUpdate[]>()
    const order: string[] = []
    const lastDocOf = new Map<string, string>()
    const seen = new Set<string>()
    for (const { pack, handle } of held) {
      if (pack.itemKind === 'record') continue
      for (const entry of handle.entries) {
        if (entry.kind !== pack.itemKind) {
          counters.skipped++
          continue
        }
        if (entry.kind === 'crdt_snapshot') {
          const meta = readSnapshotMeta(entry)
          if (!meta) {
            // The server could not resolve this snapshot's freshness token, so
            // its bytes cannot be shown to be current. Item-granular.
            counters.skipped++
            continue
          }
          const list = snapshotsOf.get(entry.id) ?? []
          list.push({ entry, meta, read: readOf(handle, entry) })
          snapshotsOf.set(entry.id, list)
        } else if (entry.kind === 'crdt_update' && manifest !== null) {
          const meta = readUpdateMeta(entry)
          if (!meta) {
            counters.skipped++
            continue
          }
          const list = updatesOf.get(entry.id) ?? []
          list.push({
            entry,
            sequenceNum: meta.sequenceNum,
            signerDeviceId: meta.signerDeviceId,
            createdAt: meta.createdAt,
            read: readOf(handle, entry)
          })
          updatesOf.set(entry.id, list)
        } else {
          counters.skipped++
          continue
        }
        if (!seen.has(entry.id)) {
          seen.add(entry.id)
          order.push(entry.id)
        }
        if (pack.itemKind === 'crdt_snapshot') lastDocOf.set(pack.id, entry.id)
      }
    }
    totalDocuments = order.length
    emitProgress()

    // A snapshot pack is complete once its last document is processed: the
    // documents run in pack order, so every one of its documents came before.
    const packEndingAt = new Map<string, string[]>()
    for (const [packId, noteId] of lastDocOf) {
      packEndingAt.set(noteId, [...(packEndingAt.get(noteId) ?? []), packId])
    }

    let sinceCommit = 0
    let aborted = false
    for (const noteId of order) {
      if (deps.signal?.aborted) {
        aborted = true
        break
      }
      try {
        const candidates = snapshotsOf.get(noteId) ?? []
        const wanted = manifest?.get(noteId)?.snapshot?.revision
        const snapshot =
          (manifest
            ? candidates.find((candidate) => candidate.meta.revision === wanted)
            : candidates.toSorted((a, b) => b.meta.sequenceNum - a.meta.sequenceNum)[0]) ?? null
        const local = await deps.bodies.localWatermark(noteId)
        let watermark = local
        const plan = planDocument(noteId, local, snapshot, updatesOf.get(noteId) ?? [], manifest)
        if (!plan) {
          counters.skipped++
        } else {
          const reached = await deps.bodies.applyDocument(noteId, plan)
          if (reached) {
            watermark = reached
            counters.applied++
            counters.updates += plan.updates.filter(
              (update) => update.sequenceNum <= reached.appliedSequence
            ).length
            sinceCommit++
          } else {
            counters.failed++
          }
        }
        if (isSettled(watermark, manifest?.get(noteId))) settledBodies.add(noteId)
      } catch (error) {
        // A per-entry checksum failure, an undecryptable blob, an
        // unresolvable signer: discard THAT document only.
        counters.failed++
        log.debug('Discarding packed bodies of a document — it falls back to its item routes', {
          noteId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      processedDocuments++
      const ending = packEndingAt.get(noteId)
      if (ending) {
        for (const packId of ending) completed.add(packId)
        packsApplied += ending.length
      }
      if (sinceCommit >= pageEntries || ending) {
        await commitPage()
        sinceCommit = 0
        emitProgress()
      }
    }
    if (!aborted) {
      for (const { pack } of held) {
        if (pack.itemKind === 'crdt_update') packsApplied++
      }
    }
    await commitPage()
    emitProgress()

    log.info('Pack bootstrap finished', {
      packsApplied,
      ...counters,
      manifestRead: manifest !== null,
      appliedThroughCursor
    })

    return {
      usedPacks: true,
      packsApplied,
      entriesApplied: counters.applied,
      entriesSkipped: counters.skipped,
      entriesFailed: counters.failed,
      updatesApplied: counters.updates,
      appliedThroughCursor,
      records: records && { ...records, settledBodies }
    }
  } finally {
    for (const { handle, filePath } of held) {
      await handle.close().catch(() => {
        /* the pack is done with either way */
      })
      // Success, failure and abort alike: the temp file never survives.
      await discard(filePath)
    }
  }
}

/**
 * The document holds its body manifest's head: its last stored update under
 * the manifest's snapshot revision, so a body pull would bring nothing.
 */
const isSettled = (
  held: BodyWatermark | null,
  document: CrdtManifestDocument | undefined
): boolean =>
  held !== null &&
  document !== undefined &&
  held.appliedSequence === document.maxSequenceNum &&
  held.snapshotRevision === document.snapshot?.revision

/** Only `{sequenceNum, revision}` both present makes a snapshot trustworthy. */
const readSnapshotMeta = (entry: PackIndexEntry): PackSnapshotMeta | null => {
  const meta = entry.meta as { sequenceNum?: unknown; revision?: unknown } | undefined
  if (!meta) return null
  const { sequenceNum, revision } = meta
  if (typeof sequenceNum !== 'number' || !Number.isFinite(sequenceNum)) return null
  if (typeof revision !== 'string' || revision.length === 0) return null
  return { sequenceNum, revision }
}

/** Pack ids are server-generated, but a temp path must never escape its dir. */
const sanitizeId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)
