import path from 'node:path'
import { promises as fs } from 'node:fs'

import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import type { InitialSyncProgressEvent } from '@memry/contracts/ipc-events'
import { PackListResponseSchema, type PackSummary } from '@memry/contracts/sync-api'
import type { PackIndexEntry } from '@memry/contracts/pack-format'

import { createLogger } from '../../lib/logger'
import { recordBootstrapBytes } from '../bootstrap-metrics'
import type { PageApplyHandle } from '../bulk-apply'
import { SYNC_STATE_KEYS } from '../engine/sync-context'
import { getFromServer } from '../http-client'
import { discardPackFile, downloadPackToFile } from './pack-download'
import { openPackFile, type PackFileHandle } from './pack-file-reader'

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
 * WHAT IS DELIBERATELY NOT APPLIED FROM PACKS: `record` packs.
 * A record pack entry is the exact R2 payload blob — `{dataNonce,
 * encryptedData, encryptedKey, keyNonce}` and nothing else. The Ed25519
 * signature, the signer device id, the vector clock and the operation live in
 * D1 rows and travel only on `POST /sync/pull`; the pack index carries none of
 * them. Applying those bytes would mean applying unverified content into an
 * end-to-end encrypted vault, so record packs are skipped and their items keep
 * arriving through the item-granular pull, byte-for-byte as they do today.
 * Nothing here touches `SYNC_STATE_KEYS.LAST_CURSOR`.
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

/** Freshness token a packed snapshot must carry before its bytes are trusted. */
export interface PackSnapshotMeta {
  sequenceNum: number
  revision: string
}

export interface PackSnapshotApplier {
  /**
   * Should this note's packed snapshot be applied? `false` means the local doc
   * is already at or beyond these bytes (or already holds this exact blob), so
   * the packed bytes are stale — skip them and leave the note to the ordinary
   * item-granular sweep.
   */
  shouldApply(noteId: string, meta: PackSnapshotMeta): Promise<boolean>
  /**
   * Decrypt, verify and seed the Y.Doc, then record the note's snapshot
   * watermark so the sweep that follows skips its baseline GET. `false` means
   * the bytes could not be trusted — that one note falls back to its GET.
   */
  apply(noteId: string, bytes: Uint8Array, meta: PackSnapshotMeta): Promise<boolean>
}

export interface PackBootstrapDeps {
  getAccessToken: () => Promise<string | null>
  /** Directory for pack temp files. Cleaned on success, failure and abort. */
  tempDir: string
  snapshots: PackSnapshotApplier
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
  /** Highest contiguously-applied pack cursor, or null when none advanced. */
  appliedThroughCursor: number | null
}

const emptyResult = (): PackBootstrapResult => ({
  usedPacks: false,
  packsApplied: 0,
  entriesApplied: 0,
  entriesSkipped: 0,
  entriesFailed: 0,
  appliedThroughCursor: null
})

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
      // Only `crdt_snapshot` is applicable client-side — see the module doc.
      if (pack.itemKind !== 'crdt_snapshot') continue
      usable.push(pack)
    }

    cursor = parsed.data.nextCursor ?? null
    if (!cursor) break
    truncated = page === MAX_PACK_LIST_PAGES - 1
  }

  return { packs: usable, truncated }
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
  const ascending = [...packs].sort((a, b) => a.maxCursor - b.maxCursor)
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
}

/**
 * Run the fresh-device pack bootstrap. Returns `usedPacks: false` whenever no
 * pack was opened, which is the caller's signal that nothing changed and the
 * item-granular path must run exactly as it always has.
 */
export const runPackBootstrap = async (deps: PackBootstrapDeps): Promise<PackBootstrapResult> => {
  const now = deps.now ?? (() => Date.now())
  const recordBytes = deps.recordBytes ?? recordBootstrapBytes
  const download = deps.download ?? downloadPackToFile
  const open = deps.openPack ?? ((filePath: string) => openPackFile(filePath))
  const discard = deps.discard ?? discardPackFile
  const pageEntries = Math.max(1, deps.pageEntries ?? PACK_APPLY_PAGE_ENTRIES)
  const parallel = Math.max(1, deps.maxParallelDownloads ?? MAX_PARALLEL_PACK_DOWNLOADS)

  const accessToken = await deps.getAccessToken().catch(() => null)
  if (!accessToken) return emptyResult()

  const listing = await listUsablePacks(deps, accessToken, Math.floor(now() / 1000))
  const allPacks = listing.packs
  if (allPacks.length === 0) return emptyResult()

  const resumeFrom = Number(deps.getStateValue(SYNC_STATE_KEYS.PACKS_APPLIED_THROUGH_CURSOR) ?? '')
  const alreadyCovered = Number.isFinite(resumeFrom) ? resumeFrom : 0
  // Newest-first: the response is already max_cursor DESC, and re-sorting keeps
  // that true across pages. Packs fully below a previous run's watermark are
  // already applied — skip them rather than re-reading their bytes.
  const packs = allPacks
    .filter((pack) => pack.maxCursor > alreadyCovered)
    .sort((a, b) => b.maxCursor - a.maxCursor)
  if (packs.length === 0) return emptyResult()

  log.info('Pack bootstrap starting', {
    packCount: packs.length,
    resumeAboveCursor: alreadyCovered
  })

  const totalEntries = packs.reduce((sum, pack) => sum + pack.itemCount, 0)
  const counters: ApplyCounters = { applied: 0, skipped: 0, failed: 0 }
  const completed = new Set<string>()
  let relist: { at: number; pending: Promise<Map<string, PackSummary>> } | null = null
  let packsApplied = 0
  let openedAnyPack = false
  let appliedThroughCursor: number | null = null

  const emitProgress = (): void => {
    deps.emit(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
      phase: 'packs',
      processedItems: counters.applied + counters.skipped + counters.failed,
      totalItems: totalEntries
    } satisfies InitialSyncProgressEvent)
  }

  /**
   * Persist the watermark INSIDE the page transaction, never after it: an
   * interrupted bootstrap must never find a committed page whose watermark did
   * not commit with it, nor the reverse.
   */
  const commitPage = async (): Promise<void> => {
    // begin -> setStateValue -> commit runs without an await, so a concurrent
    // pack worker can never open a second page session inside this window.
    const handle = deps.beginPage()
    let committed = false
    try {
      // A truncated listing means older packs exist that were never listed, so
      // the oldest pack in hand is not the bottom of the run and "contiguous
      // from the oldest" claims coverage of a range nothing walked. Apply the
      // packs, record nothing: the next run re-lists from the top.
      const watermark = listing.truncated ? null : contiguousAppliedCursor(packs, completed)
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

  const applyPack = async (pack: PackSummary, filePath: string): Promise<void> => {
    let handle: PackFileHandle
    try {
      handle = await open(filePath)
    } catch (error) {
      // Corrupt footer magic, wrong version, bad payload digest, truncated
      // file: the whole pack is discarded and every item in it stays on the
      // item-granular path. Never fatal.
      log.warn('Discarding an unreadable pack — items fall back to item GETs', {
        packId: pack.id,
        error: error instanceof Error ? error.message : String(error)
      })
      return
    }

    openedAnyPack = true
    let sinceCommit = 0
    try {
      for (const entry of handle.entries) {
        if (deps.signal?.aborted) break
        if (entry.kind !== 'crdt_snapshot') {
          counters.skipped++
          continue
        }
        const meta = readSnapshotMeta(entry)
        if (!meta) {
          // The server could not resolve this snapshot's freshness token, so
          // its bytes cannot be shown to be current. Item-granular.
          counters.skipped++
          continue
        }
        try {
          if (!(await deps.snapshots.shouldApply(entry.id, meta))) {
            counters.skipped++
            continue
          }
          const bytes = await handle.readEntry(entry)
          recordBytes('crdt', bytes.byteLength)
          const applied = await deps.snapshots.apply(entry.id, bytes, meta)
          if (applied) {
            counters.applied++
            sinceCommit++
          } else {
            counters.failed++
          }
        } catch (error) {
          // A per-entry checksum failure, an undecryptable blob, an
          // unresolvable signer: discard THAT entry only.
          counters.failed++
          log.debug('Discarding a pack entry — falling back to its item GET', {
            packId: pack.id,
            error: error instanceof Error ? error.message : String(error)
          })
        }
        if (sinceCommit >= pageEntries) {
          await commitPage()
          sinceCommit = 0
          emitProgress()
        }
      }
      if (!deps.signal?.aborted) {
        completed.add(pack.id)
        packsApplied++
      }
    } finally {
      await handle.close().catch(() => {
        /* the pack is done with either way */
      })
    }
    await commitPage()
    emitProgress()
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

  const runOne = async (pack: PackSummary): Promise<void> => {
    const filePath = path.join(deps.tempDir, `${sanitizeId(pack.id)}.pack`)
    const url = await freshUrl(pack)
    if (!url) return
    try {
      await download({
        url,
        destPath: filePath,
        ...(deps.signal ? { signal: deps.signal } : {}),
        ...(deps.pace ? { pace: deps.pace } : {})
      })
      await applyPack(pack, filePath)
    } catch (error) {
      log.info('Pack transfer failed — items fall back to the item-granular path', {
        packId: pack.id,
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      // Success, failure and abort alike: the temp file never survives.
      await discard(filePath)
    }
  }

  try {
    await fs.mkdir(deps.tempDir, { recursive: true })
  } catch (error) {
    log.info('Could not create the pack temp directory — item-granular bootstrap', { error })
    return emptyResult()
  }

  emitProgress()

  // Newest cursor range first, bounded parallelism: workers pull from one
  // shared cursor so the ordering survives concurrency.
  let next = 0
  const workers = Array.from({ length: Math.min(parallel, packs.length) }, async () => {
    for (;;) {
      if (deps.signal?.aborted) return
      const index = next++
      if (index >= packs.length) return
      await runOne(packs[index])
    }
  })
  await Promise.all(workers)

  log.info('Pack bootstrap finished', {
    packsApplied,
    ...counters,
    appliedThroughCursor
  })

  return {
    usedPacks: openedAnyPack,
    packsApplied,
    entriesApplied: counters.applied,
    entriesSkipped: counters.skipped,
    entriesFailed: counters.failed,
    appliedThroughCursor
  }
}

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
