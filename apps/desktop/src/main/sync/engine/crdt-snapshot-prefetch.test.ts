/**
 * Snapshot baselines in a CRDT batch pass: the GETs run ahead in a bounded
 * window while the baselines still apply one note at a time, in chunk order.
 * Driven through a real `CrdtSyncCoordinator` against a scripted server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Retry from '@memry/sync-client/retry'
import type { SyncContext } from './sync-context'
import { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import { clearBootstrapSessionState, setBootstrapSessionState } from '../bootstrap-session-state'

const fetchCrdtSnapshotMock = vi.fn()
const postToServerMock = vi.fn()

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

vi.mock('../http-client', () => ({
  fetchCrdtSnapshot: (...args: unknown[]) => fetchCrdtSnapshotMock(...args),
  getFromServer: vi.fn(),
  postToServer: (...args: unknown[]) => postToServerMock(...args)
}))

vi.mock('../../crypto/index', () => ({ secureCleanup: vi.fn() }))

vi.mock('@memry/sync-client/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof Retry>()),
  withRetry: async (fn: () => Promise<unknown>) => ({ value: await fn() })
}))

vi.mock('../crdt-encrypt', () => ({ decryptCrdtUpdate: () => new Uint8Array([9, 9, 9]) }))

vi.mock('../../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))

const noteIds = (count: number): string[] => Array.from({ length: count }, (_, i) => `note-${i}`)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('CRDT batch pass: snapshot GET prefetch', () => {
  let latencyMs: number
  let failing: Set<string>
  let snapshotGets: string[]
  let inFlight: number
  let maxInFlight: number
  let baselinesApplied: string[]
  let openDocs: Set<string>

  const coordinator = (): CrdtSyncCoordinator => {
    const crdtProvider = {
      inactiveDocCapacity: 128,
      isNoteLocalOnly: () => false,
      getDoc: (noteId: string) => (openDocs.has(noteId) ? {} : undefined),
      open: async (noteId: string) => {
        openDocs.add(noteId)
        return {}
      },
      closeIfInactive: async (noteId: string) => {
        openDocs.delete(noteId)
        return true
      },
      applyRemoteUpdate: (noteId: string) => {
        baselinesApplied.push(noteId)
      },
      getStateVector: () => new Uint8Array([1, 2, 3, 4]),
      seedFromMarkdownPublic: vi.fn(),
      recordWholeBodyMerged: vi.fn()
    }
    const ctx = {
      deps: {
        crdtProvider,
        getAccessToken: async () => 'token-1',
        getVaultKey: async () => new Uint8Array([1, 2, 3])
      },
      abortController: new AbortController()
    } as unknown as SyncContext
    return new CrdtSyncCoordinator(ctx, async () => new Uint8Array([4, 5, 6]))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    latencyMs = 5
    failing = new Set()
    snapshotGets = []
    inFlight = 0
    maxInFlight = 0
    baselinesApplied = []
    openDocs = new Set()

    fetchCrdtSnapshotMock.mockImplementation(async (noteId: string) => {
      snapshotGets.push(noteId)
      maxInFlight = Math.max(maxInFlight, ++inFlight)
      // Later notes answer first, so an apply that followed arrival order would show.
      await sleep(latencyMs + (noteId.endsWith('0') ? latencyMs : 0))
      inFlight--
      if (failing.has(noteId)) throw new Error('Rate limit exceeded')
      return {
        snapshot: new Uint8Array([1, 2]),
        sequenceNum: 7,
        signerDeviceId: 'device-a',
        revision: `rev-${noteId}`
      }
    })
    postToServerMock.mockImplementation(async (_path: string, body: unknown) => {
      const notes: Record<string, { updates: never[]; hasMore: boolean }> = {}
      for (const { noteId } of (body as { notes: Array<{ noteId: string }> }).notes) {
        notes[noteId] = { updates: [], hasMore: false }
      }
      return { notes }
    })
  })

  afterEach(() => {
    clearBootstrapSessionState()
  })

  it('keeps 2 GETs in flight without a bootstrap session and applies in note order', async () => {
    const cost = await coordinator().pullCrdtForNotes(noteIds(12))

    expect(maxInFlight).toBe(2)
    expect(snapshotGets).toEqual(noteIds(12))
    expect(baselinesApplied).toEqual(noteIds(12))
    expect(cost).toEqual({ snapshotGets: 12, batchPosts: 1 })
  })

  it('keeps 6 GETs in flight under an elevated bootstrap session', async () => {
    setBootstrapSessionState('bootstrap-token', Date.now() + 60_000, 5)

    await coordinator().pullCrdtForNotes(noteIds(12))

    expect(maxInFlight).toBe(6)
    expect(baselinesApplied).toEqual(noteIds(12))
  })

  it('a failed GET skips only its note and leaves the rest in order', async () => {
    setBootstrapSessionState('bootstrap-token', Date.now() + 60_000, 5)
    failing.add('note-3')
    const crdt = coordinator()

    await crdt.pullCrdtForNotes(noteIds(8))

    expect(baselinesApplied).toEqual([
      'note-0',
      'note-1',
      'note-2',
      'note-4',
      'note-5',
      'note-6',
      'note-7'
    ])
    expect(crdt.drainPendingPulls()).toEqual(['note-3'])
  })

  // The harness behind the PR's numbers: MEMRY_CRDT_PERF=1 prints the wall time
  // of one cold 80-note batch pass (MEMRY_CRDT_PERF_LATENCY_MS per GET,
  // default 230, the staging figure) with and without a bootstrap session.
  it.runIf(process.env.MEMRY_CRDT_PERF === '1')(
    'perf: a cold 80-note batch pass against a fixed-latency server',
    { timeout: 120_000 },
    async () => {
      latencyMs = Number(process.env.MEMRY_CRDT_PERF_LATENCY_MS ?? 230)
      fetchCrdtSnapshotMock.mockImplementation(async () => {
        await sleep(latencyMs)
        return {
          snapshot: new Uint8Array([1, 2]),
          sequenceNum: 7,
          signerDeviceId: 'device-a',
          revision: 'rev'
        }
      })
      for (const factor of [1, 5]) {
        setBootstrapSessionState('bootstrap-token', Date.now() + 60_000, factor)
        const started = performance.now()
        await coordinator().pullCrdtForNotes(noteIds(80))
        const ms = Math.round(performance.now() - started)
        process.stdout.write(
          `CRDT_PERF notes=80 latencyMs=${latencyMs} elevation=${factor} wallMs=${ms}\n`
        )
      }
    }
  )
})
