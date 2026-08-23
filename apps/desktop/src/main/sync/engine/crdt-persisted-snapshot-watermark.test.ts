/**
 * The persisted snapshot watermark, driven through a real `CrdtSyncCoordinator`
 * (#1613).
 *
 * `crdt-snapshot-watermark.test.ts` holds up the durable half against a real
 * LevelDB: a quarantined, rebuilt or re-pathed store takes its watermarks with
 * it. This file holds up the half that runs in this process — the working copy
 * the sweep keeps in memory, which the store's lifetime does NOT bound on its
 * own, because the app keeps running across a vault switch and a
 * quarantine-and-reopen.
 *
 * Same discipline as the sibling file: nothing mocks the coordinator or its
 * decision, the HTTP layer is a scripted server, and every assertion is about
 * which requests were actually issued.
 *
 * The mutations this file has to catch:
 *   1. remove the watermark drop from the store-teardown path — the in-memory
 *      copy then survives a store swap and skips a baseline against documents
 *      the new store never had (FM2, the merge gate);
 *   2. read a store with no record as `{ appliedSequence: 0 }` instead of as
 *      unknown — a build that predates this key then skips every baseline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncContext } from './sync-context'
import { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import type { CrdtSnapshotWatermark } from '@memry/sync-client/crdt-snapshot-watermark'
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
vi.mock('../retry', () => ({
  withRetry: async (fn: () => Promise<unknown>) => ({ value: await fn() })
}))
vi.mock('../crdt-encrypt', () => ({ decryptCrdtUpdate: () => new Uint8Array([9, 9, 9]) }))
vi.mock('../../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))

const SIGNER = 'device-a'

interface ServerNote {
  /** The R2 blob. `null` models a D1 row whose blob is gone (FM5). */
  snapshot: { sequenceNum: number; revision: string | null } | null
  /** The D1 row. Absent means the server holds no snapshot for the note at all. */
  meta?: { sequenceNum: number; revision: string }
  updates: Array<{ sequenceNum: number; data: string; signerDeviceId: string; createdAt: number }>
}

interface BatchRequest {
  notes: Array<{ noteId: string; since: number }>
  limit: number
}

/**
 * One per-vault CRDT store: an identity and the watermarks it holds.
 *
 * A store is only ever *replaced*, never edited from outside — quarantine,
 * rebuild and re-path all produce a new `FakeStore`, which is precisely the
 * shape the real thing has (a new directory, or the same directory reopened
 * under a fresh handle).
 */
class FakeStore {
  constructor(
    readonly id: string,
    readonly watermarks = new Map<string, CrdtSnapshotWatermark>()
  ) {}
}

describe('CRDT sweep: the persisted snapshot watermark', () => {
  let server: Record<string, ServerNote>
  let snapshotGets: string[]
  let batchRequests: BatchRequest[]
  let openedNotes: string[]
  let openDocs: Set<string>
  /** Swapped, not mutated, when the store underneath the provider changes. */
  let store: FakeStore | null

  /**
   * A provider over whatever `store` currently is.
   *
   * `storeId` and the watermark accessors both read `store` at call time, so a
   * test can replace the store mid-session exactly as `doInitPersistence` does
   * after a quarantine, and `null` is in-memory mode.
   */
  const makeProvider = (): Record<string, unknown> => ({
    inactiveDocCapacity: 32,
    isNoteLocalOnly: () => false,
    getDoc: (noteId: string) => (openDocs.has(noteId) ? {} : undefined),
    open: async (noteId: string) => {
      openedNotes.push(noteId)
      openDocs.add(noteId)
      return {}
    },
    closeIfInactive: async (noteId: string) => {
      openDocs.delete(noteId)
      return true
    },
    applyRemoteUpdate: () => {},
    getStateVector: () => new Uint8Array([1, 2, 3, 4]),
    seedFromMarkdownPublic: vi.fn(),
    get storeId(): string | null {
      return store?.id ?? null
    },
    getSnapshotWatermark: async (noteId: string): Promise<CrdtSnapshotWatermark | null> =>
      store?.watermarks.get(noteId) ?? null,
    putSnapshotWatermark: async (
      noteId: string,
      watermark: CrdtSnapshotWatermark
    ): Promise<void> => {
      store?.watermarks.set(noteId, watermark)
    }
  })

  /** A coordinator over the current store. A second one models a relaunch. */
  const newSession = (): CrdtSyncCoordinator => {
    const ctx = {
      deps: {
        crdtProvider: makeProvider(),
        getAccessToken: async () => 'token-1',
        getVaultKey: async () => new Uint8Array([1, 2, 3])
      },
      abortController: new AbortController()
    } as unknown as SyncContext
    return new CrdtSyncCoordinator(ctx, async () => new Uint8Array([4, 5, 6]))
  }

  const resetTraffic = (): void => {
    snapshotGets = []
    batchRequests = []
    openedNotes = []
  }

  beforeEach(() => {
    vi.clearAllMocks()
    server = {}
    openDocs = new Set()
    store = new FakeStore('store-vault-a')
    resetTraffic()

    fetchCrdtSnapshotMock.mockImplementation(async (noteId: string) => {
      snapshotGets.push(noteId)
      const snapshot = server[noteId]?.snapshot
      if (!snapshot) return null
      return {
        snapshot: new Uint8Array([1, 2]),
        sequenceNum: snapshot.sequenceNum,
        signerDeviceId: SIGNER,
        revision: snapshot.revision
      }
    })

    getFromServerMock.mockImplementation(async (path: string) => {
      const noteId = decodeURIComponent(/note_id=([^&]+)/.exec(path)?.[1] ?? '')
      const since = Number(/since=(\d+)/.exec(path)?.[1] ?? '0')
      const above = (server[noteId]?.updates ?? []).filter((u) => u.sequenceNum > since)
      return { updates: above, hasMore: false }
    })

    postToServerMock.mockImplementation(async (_path: string, body: unknown) => {
      const request = body as BatchRequest
      batchRequests.push(request)
      const notes: Record<string, { updates: ServerNote['updates']; hasMore: boolean }> = {}
      const snapshotMeta: Record<string, CrdtSnapshotMeta> = {}
      for (const { noteId, since } of request.notes) {
        const above = (server[noteId]?.updates ?? []).filter((u) => u.sequenceNum > since)
        notes[noteId] = {
          updates: above.slice(0, request.limit),
          hasMore: above.length > request.limit
        }
        const meta = server[noteId]?.meta
        if (meta) {
          snapshotMeta[noteId] = {
            sequenceNum: meta.sequenceNum,
            revision: meta.revision,
            signerDeviceId: SIGNER
          }
        }
      }
      return { notes, snapshotMeta }
    })
  })

  const probeRequests = (): BatchRequest[] => batchRequests.filter((r) => r.limit === 1)

  const twoSettledNotes = (): void => {
    server = {
      'note-1': {
        snapshot: { sequenceNum: 90, revision: 'rev-1' },
        meta: { sequenceNum: 90, revision: 'rev-1' },
        updates: []
      },
      'note-2': {
        snapshot: { sequenceNum: 12, revision: 'rev-2' },
        meta: { sequenceNum: 12, revision: 'rev-2' },
        updates: []
      }
    }
  }

  it('carries the watermark across a relaunch: the first sweep of the next session issues zero snapshot GETs', async () => {
    twoSettledNotes()

    // Session 1 — cold. No watermarks anywhere, so no probe is even sent and
    // both baselines are downloaded.
    await newSession().pullCrdtForNotes(['note-1', 'note-2'])
    expect(snapshotGets).toEqual(['note-1', 'note-2'])
    expect(probeRequests()).toHaveLength(0)

    resetTraffic()

    // Session 2 — a different coordinator over the SAME store, which is what an
    // app restart and a fresh sign-in both are. This is the ten minutes the
    // issue is about.
    await newSession().pullCrdtForNotes(['note-1', 'note-2'])

    expect(snapshotGets).toEqual([])
    expect(probeRequests()).toHaveLength(1)
    expect(openedNotes).toEqual([])
  })

  it('records the sequence and the revision it actually merged, not the ones advertised', async () => {
    twoSettledNotes()
    await newSession().pullCrdtForNotes(['note-1'])

    expect(store?.watermarks.get('note-1')).toEqual({
      appliedSequence: 90,
      snapshotRevision: 'rev-1'
    })
  })

  // THE MERGE GATE, in-process half. Removing the drop from `watermarkStore()`
  // has to redden this.
  it('drops the in-memory watermarks when the store underneath them is replaced', async () => {
    twoSettledNotes()

    const coordinator = newSession()
    await coordinator.pullCrdtForNotes(['note-1', 'note-2'])
    expect(snapshotGets).toEqual(['note-1', 'note-2'])

    resetTraffic()
    // Warm against its own store, so the swap below is the only thing that can
    // explain the cold sweep that follows.
    await coordinator.pullCrdtForNotes(['note-1', 'note-2'])
    expect(snapshotGets).toEqual([])

    resetTraffic()
    // The store is replaced under the running process: a vault switch, a store
    // quarantined and reopened, a store re-pathed after device linking. The new
    // store has never seen these notes. The watermarks the coordinator is still
    // holding describe documents it does not have, and acting on one would skip
    // the baseline that is the only thing that could fill them.
    store = new FakeStore('store-vault-b')

    await coordinator.pullCrdtForNotes(['note-1', 'note-2'])

    expect(snapshotGets).toEqual(['note-1', 'note-2'])
    expect(probeRequests()).toHaveLength(0)
    // And nothing from the old store leaked into the new one's records.
    expect(store.watermarks.get('note-1')).toEqual({
      appliedSequence: 90,
      snapshotRevision: 'rev-1'
    })
  })

  it('goes cold when a rebuilt store comes back empty, even across a relaunch', async () => {
    twoSettledNotes()
    await newSession().pullCrdtForNotes(['note-1', 'note-2'])
    expect(store?.watermarks.size).toBe(2)

    resetTraffic()
    // Quarantine: the directory is moved aside and LevelDB recreates an empty
    // one. Documents and watermarks went together.
    store = new FakeStore('store-vault-a-rebuilt')

    await newSession().pullCrdtForNotes(['note-1', 'note-2'])

    expect(snapshotGets).toEqual(['note-1', 'note-2'])
    expect(probeRequests()).toHaveLength(0)
  })

  // Mutation 2. Defaulting a missing record to sequence 0 has to redden this.
  it('reads a store with no records as unknown, so an older build sweeps exactly as it did', async () => {
    twoSettledNotes()
    // A store written by a build that predates the meta key: the documents are
    // there, no watermark ever was.
    expect(store?.watermarks.size).toBe(0)

    await newSession().pullCrdtForNotes(['note-1', 'note-2'])

    expect(snapshotGets).toEqual(['note-1', 'note-2'])
    // Not even a probe: unknown is unknown, never "sequence 0, therefore skip".
    expect(probeRequests()).toHaveLength(0)
  })

  it('FM5: never persists a watermark for a snapshot blob that never arrived', async () => {
    server = {
      // The D1 row advertises revision `rev-1`; the R2 blob is gone, so
      // `getSnapshot` answers null and nothing is applied to the document.
      'note-1': { snapshot: null, meta: { sequenceNum: 90, revision: 'rev-1' }, updates: [] }
    }

    await newSession().pullCrdtForNotes(['note-1'])
    expect(store?.watermarks.has('note-1')).toBe(false)

    resetTraffic()
    // So the next session is still cold for it, which is the point: a watermark
    // here would skip the baseline forever against a body that never arrived.
    await newSession().pullCrdtForNotes(['note-1'])
    expect(snapshotGets).toEqual(['note-1'])
  })

  it('persists nothing at all when the provider is running in memory', async () => {
    twoSettledNotes()
    // `openCrdtPersistence` returned null — a broken native binding, a store
    // that could not be trusted. Documents are seeded from vault markdown rather
    // than restored from CRDT history, so there is no merge state a watermark
    // could truthfully describe.
    store = null

    await newSession().pullCrdtForNotes(['note-1', 'note-2'])
    expect(snapshotGets).toEqual(['note-1', 'note-2'])

    resetTraffic()
    store = null
    await newSession().pullCrdtForNotes(['note-1', 'note-2'])

    // Still cold, every session, forever. That is the correct price for a device
    // with no store.
    expect(snapshotGets).toEqual(['note-1', 'note-2'])
    expect(probeRequests()).toHaveLength(0)
  })

  it('carries a watermark the single-note path moved, without ever consulting one (FM4)', async () => {
    server = {
      'note-1': {
        snapshot: { sequenceNum: 90, revision: 'rev-1' },
        meta: { sequenceNum: 90, revision: 'rev-1' },
        updates: [{ sequenceNum: 91, data: 'eA==', signerDeviceId: SIGNER, createdAt: 1 }]
      }
    }

    const coordinator = newSession()
    await coordinator.pullCrdtForNote('note-1')

    // The incremental above the baseline is in the record, so the next sweep
    // resumes from 91 rather than re-walking from 90.
    expect(store?.watermarks.get('note-1')).toEqual({
      appliedSequence: 91,
      snapshotRevision: 'rev-1'
    })

    resetTraffic()
    // And the single-note path itself is still unconditional: a second pull
    // downloads the baseline again however warm the watermark is.
    await coordinator.pullCrdtForNote('note-1')
    expect(snapshotGets).toEqual(['note-1'])
  })

  it('a watermark below the server prune watermark still fetches, persisted or not (FM3)', async () => {
    server = {
      'note-1': {
        snapshot: { sequenceNum: 90, revision: 'rev-1' },
        meta: { sequenceNum: 90, revision: 'rev-1' },
        updates: []
      }
    }
    // A record whose revision matches but whose sequence sits under the server's
    // prune line: everything at or below 90 has been deleted, so resuming from
    // 40 would be answered with silence and the note would go quietly stale.
    store = new FakeStore(
      'store-vault-a',
      new Map([['note-1', { appliedSequence: 40, snapshotRevision: 'rev-1' }]])
    )

    await newSession().pullCrdtForNotes(['note-1'])

    expect(snapshotGets).toEqual(['note-1'])
  })
})
