/**
 * The conditional snapshot skip, driven through a real `CrdtSyncCoordinator`.
 *
 * This subsystem's documented failure mode is green tests over broken
 * behaviour: two mocked halves agreeing with each other while the seam between
 * them is wrong (#1499). So nothing here mocks the coordinator or its decision.
 * The HTTP layer is a scripted server — a note has updates, a snapshot blob and
 * a snapshot metadata row, independently — and every assertion is about which
 * requests the coordinator actually issued.
 *
 * The two mutations this file has to catch:
 *   1. deleting `appliedSequence >= meta.sequenceNum` from the skip rule (FM3);
 *   2. giving `applyCrdtIncrementals` the same shortcut (FM4).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncContext } from './sync-context'
import { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import type { CrdtSnapshotMeta } from '../http-client'

const fetchCrdtSnapshotMock = vi.fn()
const getFromServerMock = vi.fn()
const postToServerMock = vi.fn()

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../http-client', () => ({
  fetchCrdtSnapshot: (...args: unknown[]) => fetchCrdtSnapshotMock(...args),
  getFromServer: (...args: unknown[]) => getFromServerMock(...args),
  postToServer: (...args: unknown[]) => postToServerMock(...args)
}))

vi.mock('../../crypto/index', () => ({
  secureCleanup: vi.fn()
}))

vi.mock('../retry', () => ({
  withRetry: async (fn: () => Promise<unknown>) => ({ value: await fn() })
}))

vi.mock('../crdt-encrypt', () => ({
  decryptCrdtUpdate: () => new Uint8Array([9, 9, 9])
}))

vi.mock('../../telemetry/diagnostics', () => ({
  trackMainError: vi.fn()
}))

const SIGNER = 'device-a'

interface ServerUpdate {
  sequenceNum: number
  data: string
  signerDeviceId: string
  createdAt: number
}

interface ServerNote {
  /** The R2 blob. `null` models a D1 row whose blob is gone (FM5). */
  snapshot: { sequenceNum: number; revision: string | null } | null
  /** The D1 row. Absent means the server holds no snapshot for the note at all. */
  meta?: { sequenceNum: number; revision: string }
  updates: ServerUpdate[]
}

interface BatchRequest {
  notes: Array<{ noteId: string; since: number }>
  limit: number
}

const update = (sequenceNum: number): ServerUpdate => ({
  sequenceNum,
  data: 'eA==',
  signerDeviceId: SIGNER,
  createdAt: 1
})

describe('CRDT sweep: conditional snapshot baseline', () => {
  let server: Record<string, ServerNote>
  let sendSnapshotMeta: boolean
  let snapshotGets: string[]
  let batchRequests: BatchRequest[]
  let openedNotes: string[]
  let appliedUpdates: string[]
  let openDocs: Set<string>

  const setup = (): {
    coordinator: CrdtSyncCoordinator
    seedFromMarkdownPublic: ReturnType<typeof vi.fn>
  } => {
    const seedFromMarkdownPublic = vi.fn()
    const crdtProvider = {
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
      applyRemoteUpdate: (noteId: string) => {
        appliedUpdates.push(noteId)
      },
      // Non-empty for every note, so the markdown seed fallback never fires and
      // cannot mask a missing baseline.
      getStateVector: () => new Uint8Array([1, 2, 3, 4]),
      seedFromMarkdownPublic
    }

    const ctx = {
      deps: {
        crdtProvider,
        getAccessToken: async () => 'token-1',
        getVaultKey: async () => new Uint8Array([1, 2, 3])
      },
      abortController: new AbortController()
    } as unknown as SyncContext

    const coordinator = new CrdtSyncCoordinator(ctx, async () => new Uint8Array([4, 5, 6]))
    return { coordinator, seedFromMarkdownPublic }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    server = {}
    sendSnapshotMeta = true
    snapshotGets = []
    batchRequests = []
    openedNotes = []
    appliedUpdates = []
    openDocs = new Set()

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

      const notes: Record<string, { updates: ServerUpdate[]; hasMore: boolean }> = {}
      for (const { noteId, since } of request.notes) {
        const above = (server[noteId]?.updates ?? []).filter((u) => u.sequenceNum > since)
        notes[noteId] = {
          updates: above.slice(0, request.limit),
          hasMore: above.length > request.limit
        }
      }

      // An old server omits the key entirely. Built by omission rather than by
      // assigning `undefined`, because that is what arrives over the wire and
      // this response is read through an unvalidated cast.
      if (!sendSnapshotMeta) return { notes }

      const snapshotMeta: Record<string, CrdtSnapshotMeta> = {}
      for (const { noteId } of request.notes) {
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
  const applyRequests = (): BatchRequest[] => batchRequests.filter((r) => r.limit !== 1)

  it('warm sweep: a second pass costs one probe POST and zero snapshot GETs', async () => {
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
    const { coordinator, seedFromMarkdownPublic } = setup()

    // Cold pass: no watermarks yet, so no probe is even sent and the cost is
    // exactly what it was before this feature existed.
    await coordinator.pullCrdtForNotes(['note-1', 'note-2'])
    expect(snapshotGets).toEqual(['note-1', 'note-2'])
    expect(probeRequests()).toHaveLength(0)

    batchRequests = []
    snapshotGets = []
    openedNotes = []

    await coordinator.pullCrdtForNotes(['note-1', 'note-2'])

    expect(snapshotGets).toEqual([])
    expect(probeRequests()).toHaveLength(1)
    expect(applyRequests()).toHaveLength(0)
    // A note settled at the probe is never opened, which is what makes the
    // probe unbound by the 32-doc LRU.
    expect(openedNotes).toEqual([])
    expect(seedFromMarkdownPublic).not.toHaveBeenCalled()
  })

  it('the sweep stays exhaustive: every note is probed, and a body-only remote edit is still applied', async () => {
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
      },
      'note-3': {
        snapshot: { sequenceNum: 5, revision: 'rev-3' },
        meta: { sequenceNum: 5, revision: 'rev-3' },
        updates: []
      }
    }
    const { coordinator } = setup()
    await coordinator.pullCrdtForNotes(['note-1', 'note-2', 'note-3'])

    // A peer edits note-2's body only. Nothing about that reaches this device
    // through the record change feed — the sweep is the only channel.
    server['note-2'].updates = [update(13)]

    batchRequests = []
    snapshotGets = []
    appliedUpdates = []
    openedNotes = []

    await coordinator.pullCrdtForNotes(['note-1', 'note-2', 'note-3'])

    // Visited: every note in the chunk is named in the probe. This is the
    // invariant that keeps "cheaper" from turning into "filtered".
    expect(probeRequests()).toHaveLength(1)
    expect(
      probeRequests()[0]
        .notes.map((n) => n.noteId)
        .sort()
    ).toEqual(['note-1', 'note-2', 'note-3'])
    // Cheap: only the changed note costs anything beyond the probe, and even it
    // does not re-download its unchanged baseline.
    expect(snapshotGets).toEqual([])
    expect(openedNotes).toEqual(['note-2'])
    expect(appliedUpdates).toEqual(['note-2'])
  })

  it('FM3: a matching revision does NOT license a `since` below the server prune watermark', async () => {
    // The device merged snapshot rev-1 when the note sat at sequence 40, so its
    // watermark is 40 with revision rev-1. The server now reports the SAME
    // revision against prune watermark 90 — everything at or below 90 has been
    // deleted, so a pull from 40 would be answered with silence and the note
    // would go quietly stale. Only condition (2) forbids that.
    server = {
      'note-1': {
        snapshot: { sequenceNum: 40, revision: 'rev-1' },
        meta: { sequenceNum: 40, revision: 'rev-1' },
        updates: []
      }
    }
    const { coordinator } = setup()
    await coordinator.pullCrdtForNotes(['note-1'])
    expect(snapshotGets).toEqual(['note-1'])

    server['note-1'].meta = { sequenceNum: 90, revision: 'rev-1' }
    server['note-1'].snapshot = { sequenceNum: 90, revision: 'rev-1' }

    batchRequests = []
    snapshotGets = []

    await coordinator.pullCrdtForNotes(['note-1'])

    expect(snapshotGets).toEqual(['note-1'])
    // And nothing was ever asked for from below the watermark the server pruned
    // to, other than the probe itself, which is what discovered the gap.
    expect(applyRequests().every((r) => r.notes.every((n) => n.since >= 90))).toBe(true)
  })

  it('FM4: the single-note path never takes the shortcut, whatever the watermark says', async () => {
    server = {
      'note-1': {
        snapshot: { sequenceNum: 90, revision: 'rev-1' },
        meta: { sequenceNum: 90, revision: 'rev-1' },
        updates: []
      }
    }
    const { coordinator } = setup()

    // Two sweeps, so the watermark is not just present but has already proved
    // itself good enough for the batch path to skip on.
    await coordinator.pullCrdtForNotes(['note-1'])
    snapshotGets = []
    await coordinator.pullCrdtForNotes(['note-1'])
    expect(snapshotGets).toEqual([])

    // `applyCrdtIncrementals` returns whether the server's state was fully
    // merged, and the pending-note replay turns a `true` into a SNAPSHOT push,
    // which makes the server delete every peer's incrementals. A `true` reached
    // by a shortcut destroys another device's edits, so this path must earn its
    // answer by actually downloading the baseline every time.
    const merged = await coordinator.pullCrdtForNote('note-1')

    expect(merged).toBe(true)
    expect(snapshotGets).toEqual(['note-1'])
  })

  it('FM5: a snapshot whose blob never arrived leaves no watermark behind', async () => {
    server = {
      // Anchor note, so the chunk has a watermark and the probe is sent at all.
      'note-1': {
        snapshot: { sequenceNum: 10, revision: 'rev-1' },
        meta: { sequenceNum: 10, revision: 'rev-1' },
        updates: []
      },
      // D1 row present and advertised, R2 blob gone: `getSnapshot` returns null.
      'note-2': {
        snapshot: null,
        meta: { sequenceNum: 90, revision: 'rev-2' },
        updates: [update(95)]
      }
    }
    const { coordinator } = setup()
    await coordinator.pullCrdtForNotes(['note-1', 'note-2'])
    // note-2 reached sequence 95 from its incrementals, which clears condition
    // (2) on its own — only the missing revision keeps it honest.
    expect(snapshotGets).toEqual(['note-1', 'note-2'])

    batchRequests = []
    snapshotGets = []

    await coordinator.pullCrdtForNotes(['note-1', 'note-2'])

    expect(snapshotGets).toEqual(['note-2'])
  })

  it('FM6: a note with no local watermark is fetched even when everything else matches', async () => {
    server = {
      'note-1': {
        snapshot: { sequenceNum: 10, revision: 'rev-1' },
        meta: { sequenceNum: 10, revision: 'rev-1' },
        updates: []
      },
      'note-3': {
        snapshot: { sequenceNum: 7, revision: 'rev-3' },
        meta: { sequenceNum: 7, revision: 'rev-3' },
        updates: []
      }
    }
    const { coordinator } = setup()
    await coordinator.pullCrdtForNotes(['note-1'])

    batchRequests = []
    snapshotGets = []
    openedNotes = []

    // note-3 has never been merged on this device — a note absent from the
    // local CRDT store. The default is fetch.
    await coordinator.pullCrdtForNotes(['note-1', 'note-3'])

    expect(snapshotGets).toEqual(['note-3'])
    expect(openedNotes).toEqual(['note-3'])
  })

  it('a note the server holds no snapshot for is settled from the watermark, not from a GET', async () => {
    // No `meta`: the note is absent from `snapshotMeta` while the map itself is
    // present, which means "no server snapshot", not "old server".
    server = {
      'note-1': { snapshot: null, meta: undefined, updates: [update(3)] }
    }
    const { coordinator } = setup()
    await coordinator.pullCrdtForNotes(['note-1'])
    expect(snapshotGets).toEqual(['note-1'])

    batchRequests = []
    snapshotGets = []

    await coordinator.pullCrdtForNotes(['note-1'])

    expect(snapshotGets).toEqual([])
    expect(probeRequests()).toHaveLength(1)
    expect(probeRequests()[0].notes).toEqual([{ noteId: 'note-1', since: 3 }])
  })

  it('old server: a response without snapshotMeta never skips, and stops costing a probe', async () => {
    server = {
      'note-1': {
        snapshot: { sequenceNum: 90, revision: 'rev-1' },
        meta: { sequenceNum: 90, revision: 'rev-1' },
        updates: []
      }
    }
    const { coordinator } = setup()

    // Warm the watermark against a server that does publish the token, so the
    // only thing under test afterwards is the rollback itself.
    await coordinator.pullCrdtForNotes(['note-1'])

    // Server rolled back — staging, self-hosted, or a reverted deploy.
    sendSnapshotMeta = false
    batchRequests = []
    snapshotGets = []

    await coordinator.pullCrdtForNotes(['note-1'])

    expect(snapshotGets).toEqual(['note-1'])
    expect(probeRequests()).toHaveLength(1)

    batchRequests = []
    snapshotGets = []

    // From here on the requests are exactly the ones this code issued before
    // the feature existed: one baseline GET per note, one apply POST, no probe.
    await coordinator.pullCrdtForNotes(['note-1'])

    expect(snapshotGets).toEqual(['note-1'])
    expect(probeRequests()).toHaveLength(0)
    expect(applyRequests()).toHaveLength(1)
  })

  it('clearing caches drops both halves of the watermark, so the next sweep fetches again', async () => {
    server = {
      'note-1': {
        snapshot: { sequenceNum: 90, revision: 'rev-1' },
        meta: { sequenceNum: 90, revision: 'rev-1' },
        updates: []
      }
    }
    const { coordinator } = setup()
    await coordinator.pullCrdtForNotes(['note-1'])

    coordinator.clearCaches()
    batchRequests = []
    snapshotGets = []

    await coordinator.pullCrdtForNotes(['note-1'])

    expect(snapshotGets).toEqual(['note-1'])
    expect(probeRequests()).toHaveLength(0)
  })
})
