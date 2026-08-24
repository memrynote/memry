/**
 * The sweep's pacing, measured rather than restated.
 *
 * A test that asserts `CRDT_SWEEP_CHUNK_NOTES === 100` is worthless: it passes
 * for any pair of constants someone later writes down. So every number here is
 * counted off a scripted HTTP layer driven by a REAL `CrdtSyncCoordinator` —
 * how many `GET /sync/crdt/snapshot/:noteId` and how many
 * `POST /sync/crdt/updates/batch` a chunk actually put on the wire — and then
 * divided by the interval the pacer charges for that chunk. What is asserted is
 * REQUESTS PER MINUTE against each server bucket, so any future edit to either
 * constant that busts a budget fails here.
 *
 * The two mutations this file has to catch:
 *   1. sizing the apply phase above `crdtProvider.inactiveDocCapacity` — the
 *      32-doc LRU closes the docs the pass opened first and their updates are
 *      dropped as "unopened doc";
 *   2. shortening the GET pace so the cold sweep exceeds 50% of `crdt_pull` —
 *      the 242-requests-in-4-seconds regime of #1466.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncContext } from './sync-context'
import { CRDT_SWEEP_CHUNK_NOTES, crdtSweepChunkDelayMs, type CrdtPullCost } from './sync-context'
import { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import type { CrdtSnapshotMeta } from '../http-client'

const fetchCrdtSnapshotMock = vi.fn()
const getFromServerMock = vi.fn()
const postToServerMock = vi.fn()

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../http-client', () => ({
  fetchCrdtSnapshot: (...args: unknown[]) => fetchCrdtSnapshotMock(...args),
  getFromServer: (...args: unknown[]) => getFromServerMock(...args),
  postToServer: (...args: unknown[]) => postToServerMock(...args)
}))

vi.mock('../../crypto/index', () => ({ secureCleanup: vi.fn() }))
vi.mock('@memry/sync-client/retry', () => ({
  withRetry: async (fn: () => Promise<unknown>) => ({ value: await fn() })
}))
vi.mock('../crdt-encrypt', () => ({ decryptCrdtUpdate: () => new Uint8Array([9, 9, 9]) }))
vi.mock('../../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))

// sync-server routes/sync.ts: both keyed by deviceIdentifier, not by account.
const CRDT_PULL_BUDGET_PER_MIN = 600
const CRDT_BATCH_PULL_BUDGET_PER_MIN = 30
/** §2.2's margin: the other half pays for editors, the priority batch and a second sweep. */
const MARGIN = 0.5
const DOC_CACHE = 32
const SIGNER = 'device-a'

interface BatchRequest {
  notes: Array<{ noteId: string; since: number }>
  limit: number
}

interface Wire {
  /** One entry per `GET /sync/crdt/snapshot/:noteId` that reached the scripted server. */
  snapshotGets: string[]
  /** One entry per `POST /sync/crdt/updates/batch`, probe and apply rounds alike. */
  batchRequests: BatchRequest[]
  opened: string[]
  maxConcurrentOpenDocs: number
}

/** What one paced chunk cost, and what that buys per minute at the charged pace. */
interface ChunkRates {
  cost: CrdtPullCost
  delayMs: number
  getsPerMinute: number
  postsPerMinute: number
}

const rates = (cost: CrdtPullCost): ChunkRates => {
  const delayMs = crdtSweepChunkDelayMs(cost)
  return {
    cost,
    delayMs,
    getsPerMinute: (cost.snapshotGets * 60_000) / delayMs,
    postsPerMinute: (cost.batchPosts * 60_000) / delayMs
  }
}

describe('CRDT sweep pacing', () => {
  let wire: Wire
  let openDocs: Set<string>
  let watermarkStore: Map<string, unknown>
  let sendSnapshotMeta: boolean
  let coordinator: CrdtSyncCoordinator

  /**
   * A vault where every note's body is fully described by its snapshot: the
   * server holds a snapshot blob and its metadata row, and nothing above it.
   * That is the steady state a sweep spends almost all of its life in — the
   * regime the old pacing paid 1,000 snapshot GETs to re-confirm.
   */
  const vault = (count: number): string[] => Array.from({ length: count }, (_, i) => `note-${i}`)

  beforeEach(() => {
    vi.clearAllMocks()
    wire = { snapshotGets: [], batchRequests: [], opened: [], maxConcurrentOpenDocs: 0 }
    openDocs = new Set()
    watermarkStore = new Map()
    sendSnapshotMeta = true

    fetchCrdtSnapshotMock.mockImplementation(async (noteId: string) => {
      wire.snapshotGets.push(noteId)
      return {
        snapshot: new Uint8Array([1]),
        sequenceNum: 5,
        signerDeviceId: SIGNER,
        revision: 'rev-1'
      }
    })

    postToServerMock.mockImplementation(async (_path: string, body: BatchRequest) => {
      wire.batchRequests.push(body)
      const notes: Record<
        string,
        {
          updates: Array<{
            sequenceNum: number
            data: string
            signerDeviceId: string
            createdAt: number
          }>
          hasMore: boolean
        }
      > = {}
      const snapshotMeta: Record<string, CrdtSnapshotMeta> = {}
      for (const { noteId } of body.notes) {
        notes[noteId] = { updates: [], hasMore: false }
        snapshotMeta[noteId] = { sequenceNum: 5, revision: 'rev-1', signerDeviceId: SIGNER }
      }
      return sendSnapshotMeta ? { notes, snapshotMeta } : { notes }
    })

    const crdtProvider = {
      inactiveDocCapacity: DOC_CACHE,
      storeId: 'store-1',
      isNoteLocalOnly: () => false,
      getDoc: (noteId: string) => (openDocs.has(noteId) ? {} : undefined),
      open: async (noteId: string) => {
        wire.opened.push(noteId)
        openDocs.add(noteId)
        wire.maxConcurrentOpenDocs = Math.max(wire.maxConcurrentOpenDocs, openDocs.size)
        return {}
      },
      closeIfInactive: async (noteId: string) => {
        openDocs.delete(noteId)
        return true
      },
      applyRemoteUpdate: () => {},
      // Non-empty, so the markdown seed fallback never fires and cannot mask a
      // baseline that was never fetched.
      getStateVector: () => new Uint8Array([1, 2, 3, 4]),
      seedFromMarkdownPublic: vi.fn(),
      getSnapshotWatermark: async (noteId: string) => watermarkStore.get(noteId) ?? null,
      putSnapshotWatermark: async (noteId: string, value: unknown) => {
        watermarkStore.set(noteId, value)
      }
    }

    const ctx = {
      deps: {
        crdtProvider,
        getAccessToken: async () => 'token-1',
        getVaultKey: async () => new Uint8Array([1, 2, 3])
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    coordinator = new CrdtSyncCoordinator(ctx, async () => new Uint8Array([4, 5, 6]))
  })

  /**
   * The drain `FullSyncRunner.pumpPacedCrdtPulls` performs: hand the coordinator
   * one chunk of `CRDT_SWEEP_CHUNK_NOTES`, charge the interval against what that
   * chunk actually spent, repeat. Returns one `ChunkRates` per chunk.
   */
  const sweep = async (noteIds: string[]): Promise<ChunkRates[]> => {
    const out: ChunkRates[] = []
    for (let i = 0; i < noteIds.length; i += CRDT_SWEEP_CHUNK_NOTES) {
      const cost = await coordinator.pullCrdtForNotes(
        noteIds.slice(i, i + CRDT_SWEEP_CHUNK_NOTES),
        new AbortController().signal
      )
      out.push(rates(cost))
    }
    return out
  }

  const wallClockMs = (chunks: ChunkRates[]): number =>
    chunks.slice(0, -1).reduce((ms, c) => ms + c.delayMs, 0)

  const resetWire = (): void => {
    wire.snapshotGets = []
    wire.batchRequests = []
    wire.opened = []
    wire.maxConcurrentOpenDocs = 0
  }

  describe('#given a 1,000-note vault #when the sweep drains it', () => {
    it('#then the cold pass stays inside BOTH buckets and finishes in ~3 min 20 s', async () => {
      const chunks = await sweep(vault(1000))

      // No note has a watermark yet, so no probe is sent at all — the cold path
      // costs exactly what it cost before the probe existed. The POSTs here are
      // the apply rounds: ceil(100 / 32) = 4 sub-chunks per chunk.
      expect(wire.snapshotGets).toHaveLength(1000)
      expect(wire.batchRequests).toHaveLength(4 * 10)
      expect(wire.batchRequests.every((r) => r.limit === 100)).toBe(true)

      for (const chunk of chunks) {
        // What the pacer charged is what the wire saw, not a number the
        // coordinator decided on its own.
        expect(chunk.cost).toEqual({ snapshotGets: 100, batchPosts: 4 })
        expect(chunk.getsPerMinute).toBeLessThanOrEqual(CRDT_PULL_BUDGET_PER_MIN * MARGIN)
        expect(chunk.postsPerMinute).toBeLessThanOrEqual(CRDT_BATCH_PULL_BUDGET_PER_MIN * MARGIN)
      }

      // 100 GETs x 200 ms = 20 s per chunk, nine waits between ten chunks.
      expect(wallClockMs(chunks)).toBe(9 * 20_000)
      expect(wallClockMs(chunks)).toBeLessThan(4 * 60_000)
    })

    it('#then the warm pass costs one POST per 100 notes and finishes in ~40 s', async () => {
      const notes = vault(1000)
      await sweep(notes)
      resetWire()

      const chunks = await sweep(notes)

      // The whole point of the split: the probe is not bound by the doc cache,
      // so 100 notes are confirmed unchanged for ONE request and no document is
      // opened at all.
      expect(wire.snapshotGets).toHaveLength(0)
      expect(wire.opened).toHaveLength(0)
      expect(wire.batchRequests).toHaveLength(10)
      expect(wire.batchRequests.every((r) => r.notes.length === 100 && r.limit === 1)).toBe(true)

      for (const chunk of chunks) {
        expect(chunk.cost).toEqual({ snapshotGets: 0, batchPosts: 1 })
        expect(chunk.getsPerMinute).toBe(0)
        expect(chunk.postsPerMinute).toBeLessThanOrEqual(CRDT_BATCH_PULL_BUDGET_PER_MIN * MARGIN)
      }

      expect(wallClockMs(chunks)).toBe(9 * 4_000)
      expect(wallClockMs(chunks)).toBeLessThanOrEqual(60_000)
    })

    it('#then an old server pays one probe, latches, and costs exactly the cold pass', async () => {
      const notes = vault(1000)
      await sweep(notes)
      // The server rolls back to a build with no `snapshotMeta`. The response is
      // read through a cast with no runtime validation, so this is the key being
      // absent on the wire, not assigned `undefined`.
      sendSnapshotMeta = false
      resetWire()

      const chunks = await sweep(notes)

      // One probe on the first chunk, then `snapshotMetaUnsupported` latches.
      expect(wire.batchRequests.filter((r) => r.limit === 1)).toHaveLength(1)
      expect(wire.snapshotGets).toHaveLength(1000)
      expect(chunks[0].cost).toEqual({ snapshotGets: 100, batchPosts: 5 })
      expect(chunks.slice(1).map((c) => c.cost)).toEqual(
        Array.from({ length: 9 }, () => ({ snapshotGets: 100, batchPosts: 4 }))
      )

      for (const chunk of chunks) {
        expect(chunk.getsPerMinute).toBeLessThanOrEqual(CRDT_PULL_BUDGET_PER_MIN * MARGIN)
        expect(chunk.postsPerMinute).toBeLessThanOrEqual(CRDT_BATCH_PULL_BUDGET_PER_MIN * MARGIN)
      }
    })

    it('#then the apply phase never opens more docs than the cache holds', async () => {
      // MUTATION TARGET 1. The apply phase holds every one of its notes open
      // from before the request is sent until that note's updates are applied,
      // so past `inactiveDocCapacity` the LRU closes the ones it opened first
      // and `applyRemoteUpdate` drops their updates as "unopened doc". The
      // probe chunk is deliberately three times the cache; the apply sub-chunk
      // must not be.
      await sweep(vault(1000))

      expect(wire.maxConcurrentOpenDocs).toBeLessThanOrEqual(DOC_CACHE)
      // ...and it is the cache that bounds it, not the chunk being small.
      expect(CRDT_SWEEP_CHUNK_NOTES).toBeGreaterThan(DOC_CACHE)
    })

    it('#then the sweep is exhaustive: every note is named in every pass', async () => {
      const notes = vault(1000)

      await sweep(notes)
      // Cold: every note was opened and had its baseline fetched.
      expect(new Set(wire.snapshotGets)).toEqual(new Set(notes))
      resetWire()

      await sweep(notes)
      // Warm: no note is FILTERED OUT, only made cheap. The sweep is the sole
      // channel by which a body-only remote edit reaches a device that missed
      // the broadcast — note bodies never travel in the record change feed — so
      // a note dropped here would go stale with no second chance.
      const probed = new Set(wire.batchRequests.flatMap((r) => r.notes.map((n) => n.noteId)))
      expect(probed).toEqual(new Set(notes))
    })
  })

  describe('#given a chunk that needs more than one batch round', () => {
    it('#then the extra POSTs are charged, so the batch bucket still holds', async () => {
      // MUTATION TARGET 2's sibling, and the reason the counts are measured
      // rather than predicted: `applyProbedNotes` loops while any note reports
      // `hasMore`, so "one POST per chunk" is a FLOOR. A fixed interval would
      // have multiplied the POST rate by the round count; charging the measured
      // cost slows the sweep down instead.
      let round = 0
      postToServerMock.mockImplementation(async (_path: string, body: BatchRequest) => {
        wire.batchRequests.push(body)
        const notes: Record<string, { updates: never[]; hasMore: boolean }> = {}
        const snapshotMeta: Record<string, CrdtSnapshotMeta> = {}
        // Three rounds per apply sub-chunk, then done.
        const hasMore = body.limit === 100 && ++round % 3 !== 0
        for (const { noteId } of body.notes) {
          notes[noteId] = { updates: [], hasMore }
          snapshotMeta[noteId] = { sequenceNum: 5, revision: 'rev-1', signerDeviceId: SIGNER }
        }
        return { notes, snapshotMeta }
      })

      const chunks = await sweep(vault(100))

      expect(chunks[0].cost.batchPosts).toBeGreaterThan(4)
      expect(chunks[0].postsPerMinute).toBeLessThanOrEqual(CRDT_BATCH_PULL_BUDGET_PER_MIN * MARGIN)
      expect(chunks[0].getsPerMinute).toBeLessThanOrEqual(CRDT_PULL_BUDGET_PER_MIN * MARGIN)
    })
  })
})
