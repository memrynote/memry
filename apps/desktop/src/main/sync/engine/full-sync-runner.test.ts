import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import { FullSyncRunner, type FullSyncActions } from './full-sync-runner'
import {
  CRDT_FULL_SWEEP_MIN_INTERVAL_MS,
  CRDT_RECONNECT_SWEEP_FLOOR_MS,
  CRDT_SWEEP_CHUNK_INTERVAL_MS,
  CRDT_SWEEP_CHUNK_NOTES,
  CRDT_SWEEP_MS_PER_BATCH_POST,
  CRDT_SWEEP_MS_PER_SNAPSHOT_GET,
  crdtSweepChunkDelayMs,
  SYNC_STATE_KEYS,
  type CrdtPullCost,
  type SyncContext
} from './sync-context'
import type { SyncStateManager } from './sync-state-manager'
import type { PushCoordinator } from './push-coordinator'
import type { CrdtSyncCoordinator } from './crdt-sync-coordinator'

// FullSyncRunner is the choreography of a complete sync cycle:
// pull -> seed -> push -> manifest check -> (conditional re-pull) -> follow-up
// push -> cleanup, with a finally block that must always release the
// fullSyncActive flag and flush queued CRDT pulls. Ordering matters (a push
// before the pull uploads a stale snapshot), and so does the throttle
// bookkeeping for the manifest check, which is what re-pulls a vault whose
// server rows went missing.

const mocks = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  checkManifestIntegrity: vi.fn(),
  runInitialSeed: vi.fn(),
  getAllCrdtNoteIds: vi.fn(),
  isIndexDatabaseInitialized: vi.fn(),
  getIndexDatabase: vi.fn()
}))

vi.mock('../../lib/logger', () => ({
  createLogger: () => mocks.log
}))

vi.mock('../manifest-check', () => ({
  checkManifestIntegrity: (...args: unknown[]) => mocks.checkManifestIntegrity(...args)
}))

vi.mock('../initial-seed', () => ({
  runInitialSeed: (...args: unknown[]) => mocks.runInitialSeed(...args)
}))

vi.mock('../../database/queries/notes', () => ({
  getAllCrdtNoteIds: (...args: unknown[]) => mocks.getAllCrdtNoteIds(...args)
}))

vi.mock('../../database/client', () => ({
  getIndexDatabase: (...args: unknown[]) => mocks.getIndexDatabase(...args),
  isIndexDatabaseInitialized: (...args: unknown[]) => mocks.isIndexDatabaseInitialized(...args)
}))

class FakeCrdtSync {
  private pending = new Set<string>()
  /**
   * Mirrors the real coordinator: a note queued for a pull is by definition one
   * whose server state is not in the local doc yet, so it is flagged too. The
   * runner reads this back after a sweep to re-state the persisted debt.
   */
  unmerged = new Set<string>()
  pullCrdtForNote = vi.fn(async () => {})
  /**
   * The real coordinator reports what the chunk spent, per rate-limit bucket,
   * and the runner charges its next interval against it. A warm chunk — one
   * probe POST, no snapshot GETs — is the default here, which lands exactly on
   * CRDT_SWEEP_CHUNK_INTERVAL_MS. Regime-by-regime rates are pinned in
   * crdt-sweep-pacing.test.ts against a real coordinator.
   */
  pullCrdtForNotes = vi.fn(
    async (_noteIds: string[], _signal?: AbortSignal): Promise<CrdtPullCost> => ({
      snapshotGets: 0,
      batchPosts: 1
    })
  )

  get hasUnmergedNotes(): boolean {
    return this.unmerged.size > 0
  }

  addPendingPull(noteId: string): void {
    this.pending.add(noteId)
    this.unmerged.add(noteId)
  }

  get pendingPullCount(): number {
    return this.pending.size
  }

  drainPendingPulls(): string[] {
    const ids = [...this.pending]
    this.pending.clear()
    return ids
  }
}

/**
 * The runner asks the provider three things: which notes still have a live
 * editor (those skip the paced queue, because that is the note the user is
 * looking at), every doc it is holding at all (the LRU keeps up to 32 after
 * their editors closed — those lead the paced queue), and how many docs it can
 * hold open at once (so a paced chunk never outgrows the LRU and gets its docs
 * closed underneath it).
 *
 * `openNoteIds` defaults to the active set because the real `getOpenNoteIds()`
 * returns a superset of `getOpenNoteIds({ active: true })`.
 */
function fakeCrdtProvider({
  activeNoteIds = [] as string[],
  openNoteIds,
  inactiveDocCapacity = 32
}: {
  activeNoteIds?: string[]
  openNoteIds?: string[]
  inactiveDocCapacity?: number
} = {}): {
  getOpenNoteIds: ReturnType<typeof vi.fn>
  inactiveDocCapacity: number
} {
  const open = openNoteIds ?? activeNoteIds
  return {
    getOpenNoteIds: vi.fn(({ active = false } = {}) => (active ? activeNoteIds : open)),
    inactiveDocCapacity
  }
}

interface Harness {
  runner: FullSyncRunner
  ctx: SyncContext
  calls: string[]
  actions: {
    pull: ReturnType<typeof vi.fn>
    push: ReturnType<typeof vi.fn>
    scheduleSync: ReturnType<typeof vi.fn>
  }
  emitToRenderer: ReturnType<typeof vi.fn>
  setStateValue: ReturnType<typeof vi.fn>
  getStateValue: ReturnType<typeof vi.fn>
  isPaused: ReturnType<typeof vi.fn>
  clearPendingAfterFullSync: ReturnType<typeof vi.fn>
  purgeOldErrors: ReturnType<typeof vi.fn>
  getPendingCount: ReturnType<typeof vi.fn>
  crdtSync: FakeCrdtSync
  ws: FakeWebSocket
}

/**
 * `connectionGeneration` advances once per successful socket open, so an
 * unchanged generation on a still-connected socket proves no `crdt_updated`
 * broadcast could have been missed since it was last read.
 */
interface FakeWebSocket {
  connected: boolean
  connectionGeneration: number
}

/**
 * `pendingCounts` feeds successive getPendingCount() calls, which run() makes
 * in this order: before the seed, again to compute the seeded delta, again for
 * the progress total, and finally after the manifest check. The last entry is
 * reused once the list runs out.
 */
function createHarness(
  options: {
    pendingCounts?: number[]
    signingKeys?: { deviceId: string } | null
    crdtProvider?: unknown
    isQuarantined?: (itemId: string, itemType: string) => boolean
    online?: boolean
    ws?: FakeWebSocket | null
  } = {}
): Harness {
  const calls: string[] = []
  const pendingCounts = options.pendingCounts ?? [0]
  let pendingIndex = 0
  const getPendingCount = vi.fn(() => {
    const value = pendingCounts[Math.min(pendingIndex, pendingCounts.length - 1)]
    pendingIndex++
    return value
  })
  const purgeOldErrors = vi.fn(() => {
    calls.push('purgeOldErrors')
  })
  const emitToRenderer = vi.fn((channel: string, data: unknown) => {
    if (channel === EVENT_CHANNELS.INITIAL_SYNC_PROGRESS) {
      calls.push(`progress:${(data as { phase: string }).phase}`)
    }
  })

  const ws: FakeWebSocket =
    options.ws === undefined
      ? { connected: true, connectionGeneration: 1 }
      : (options.ws ?? {
          connected: false,
          connectionGeneration: 0
        })

  const ctx = {
    deps: {
      db: { __db: 'data' },
      queue: { getPendingCount, purgeOldErrors },
      network: { online: options.online ?? true },
      ...(options.ws !== null && { ws }),
      getAccessToken: vi.fn(async () => 'token-1'),
      getSigningKeys: vi.fn(async () =>
        options.signingKeys === undefined ? { deviceId: 'dev-a' } : options.signingKeys
      ),
      emitToRenderer,
      ...(options.crdtProvider !== undefined && { crdtProvider: options.crdtProvider })
    },
    fullSyncActive: false
  } as unknown as SyncContext

  const setStateValue = vi.fn((key: string) => {
    calls.push(`setState:${key}`)
  })
  const getStateValue = vi.fn((_key: string) => undefined as string | undefined)
  const isPaused = vi.fn(() => false)
  const stateManager = { setStateValue, getStateValue, isPaused } as unknown as SyncStateManager

  const clearPendingAfterFullSync = vi.fn(() => {
    calls.push('clearPendingAfterFullSync')
  })
  const pushCoordinator = { clearPendingAfterFullSync } as unknown as PushCoordinator

  const crdtSync = new FakeCrdtSync()

  const actions = {
    pull: vi.fn(async () => {
      calls.push('pull')
    }),
    push: vi.fn(async () => {
      calls.push('push')
    }),
    // The real SyncEngine.scheduleSync runs the callback (chained onto any
    // in-flight sync). The paced CRDT drain arms its next chunk from the
    // previous one's completion, so a harness that only recorded the call would
    // wedge the pump after the first chunk and hide every later one.
    scheduleSync: vi.fn((fn: () => Promise<void>) => {
      calls.push('scheduleSync')
      void fn().catch(() => {})
    })
  }

  const runner = new FullSyncRunner(
    ctx,
    stateManager,
    pushCoordinator,
    crdtSync as unknown as CrdtSyncCoordinator,
    actions as unknown as FullSyncActions,
    options.isQuarantined
  )

  return {
    runner,
    ctx,
    calls,
    actions,
    emitToRenderer,
    setStateValue,
    getStateValue,
    isPaused,
    clearPendingAfterFullSync,
    purgeOldErrors,
    getPendingCount,
    crdtSync,
    ws
  }
}

function manifestResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    checkedAt: Date.now(),
    rePullNeeded: false,
    serverOnlyCount: 0,
    performed: true,
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkManifestIntegrity.mockResolvedValue(manifestResult())
  mocks.isIndexDatabaseInitialized.mockReturnValue(false)
  mocks.getAllCrdtNoteIds.mockReturnValue([])
  mocks.getIndexDatabase.mockReturnValue({ __db: 'index' })
})

describe('FullSyncRunner', () => {
  describe('#given a healthy cycle #when run', () => {
    it('#then the stages execute in pull -> seed -> push -> manifest order', async () => {
      // A push before the pull uploads a snapshot that has not yet seen the
      // other device's changes, which is exactly how a remote edit gets
      // clobbered.
      const h = createHarness()
      mocks.runInitialSeed.mockImplementation(() => h.calls.push('seed'))
      mocks.checkManifestIntegrity.mockImplementation(async () => {
        h.calls.push('manifest')
        return manifestResult()
      })

      await h.runner.run()

      expect(h.calls).toEqual([
        'pull',
        'seed',
        'push',
        'progress:manifest',
        'manifest',
        `setState:${SYNC_STATE_KEYS.LAST_MANIFEST_CHECK_AT}`,
        'clearPendingAfterFullSync',
        'purgeOldErrors',
        'progress:complete'
      ])
    })

    it('#then the seed runs with the signing device id and the shared db/queue', async () => {
      const h = createHarness()

      await h.runner.run()

      expect(mocks.runInitialSeed).toHaveBeenCalledWith({
        db: h.ctx.deps.db,
        queue: h.ctx.deps.queue,
        deviceId: 'dev-a'
      })
    })

    it('#then fullSyncActive is set during the run and cleared afterwards', async () => {
      const h = createHarness()
      let activeDuringPull: boolean | undefined
      h.actions.pull.mockImplementation(async () => {
        activeDuringPull = h.ctx.fullSyncActive
      })

      await h.runner.run()

      expect(activeDuringPull).toBe(true)
      expect(h.ctx.fullSyncActive).toBe(false)
    })

    it('#then old queue errors are purged with a 7-day cutoff', async () => {
      const h = createHarness()
      const before = Date.now()

      await h.runner.run()

      const cutoff = h.purgeOldErrors.mock.calls[0][0] as Date
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - sevenDaysMs - 5_000)
      expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - sevenDaysMs + 5_000)
    })
  })

  describe('#given no signing keys yet #when run', () => {
    it('#then the seed is skipped but the cycle still completes', async () => {
      // Sync can be running for a pull before device registration finishes;
      // skipping the seed must not abort the rest of the cycle.
      const h = createHarness({ signingKeys: null })

      await h.runner.run()

      expect(mocks.runInitialSeed).not.toHaveBeenCalled()
      expect(h.calls).toContain('pull')
      expect(h.calls).toContain('push')
      expect(h.calls).toContain('progress:complete')
    })
  })

  describe('#given the seed queues work #when run', () => {
    it('#then a tasks-phase progress event reports the queued total', async () => {
      const h = createHarness({ pendingCounts: [0, 12, 12, 0] })

      await h.runner.run()

      expect(h.emitToRenderer).toHaveBeenCalledWith(EVENT_CHANNELS.INITIAL_SYNC_PROGRESS, {
        phase: 'tasks',
        processedItems: 0,
        totalItems: 12
      })
    })

    it('#then an empty queue emits no tasks-phase event', async () => {
      const h = createHarness({ pendingCounts: [0, 0, 0, 0] })

      await h.runner.run()

      expect(h.calls).not.toContain('progress:tasks')
    })
  })

  describe('#given the manifest throttle timestamp #when the check runs', () => {
    it('#then a future-dated persisted value is clamped to now', async () => {
      // Clock skew or a machine migration can leave a timestamp in the future.
      // Without the clamp the manifest check is throttled until the wall clock
      // catches up — potentially never.
      const h = createHarness()
      h.getStateValue.mockReturnValue(String(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000))

      await h.runner.run()

      const arg = mocks.checkManifestIntegrity.mock.calls[0][0] as { lastCheckAt: number }
      expect(arg.lastCheckAt).toBeLessThanOrEqual(Date.now())
    })

    it('#then a non-numeric persisted value falls back to zero', async () => {
      const h = createHarness()
      h.getStateValue.mockReturnValue('not-a-number')

      await h.runner.run()

      const arg = mocks.checkManifestIntegrity.mock.calls[0][0] as { lastCheckAt: number }
      expect(arg.lastCheckAt).toBe(0)
    })

    it('#then the check is handed the quarantine predicate and the live online flag', async () => {
      const isQuarantined = vi.fn(() => false)
      const h = createHarness({ isQuarantined })

      await h.runner.run()

      const arg = mocks.checkManifestIntegrity.mock.calls[0][0] as {
        isQuarantined?: unknown
        isOnline: () => boolean
        getAccessToken: unknown
      }
      expect(arg.isQuarantined).toBe(isQuarantined)
      expect(arg.isOnline()).toBe(true)
      expect(arg.getAccessToken).toBe(h.ctx.deps.getAccessToken)
    })

    it('#then only a performed check stamps the persisted timestamp', async () => {
      const h = createHarness()
      mocks.checkManifestIntegrity.mockResolvedValue(
        manifestResult({ performed: false, checkedAt: 123 })
      )

      await h.runner.run()

      // Stamping a no-token / fetch-failure path would defer the next REAL
      // check by the full throttle window.
      expect(h.setStateValue).not.toHaveBeenCalledWith(
        SYNC_STATE_KEYS.LAST_MANIFEST_CHECK_AT,
        expect.anything()
      )
    })

    it('#then a performed check persists its checkedAt', async () => {
      const h = createHarness()
      mocks.checkManifestIntegrity.mockResolvedValue(
        manifestResult({ performed: true, checkedAt: 456 })
      )

      await h.runner.run()

      expect(h.setStateValue).toHaveBeenCalledWith(SYNC_STATE_KEYS.LAST_MANIFEST_CHECK_AT, '456')
    })

    it('#then an unperformed check still advances the in-memory throttle', async () => {
      // Current behaviour: the in-memory field is stamped from checkedAt even
      // when nothing was fetched, so a token-less cycle also throttles the
      // next check for this process — the persisted value deliberately does
      // not. Recorded so the divergence is visible if it is ever revisited.
      const h = createHarness()
      mocks.checkManifestIntegrity.mockResolvedValue(
        manifestResult({ performed: false, checkedAt: 777 })
      )

      await h.runner.run()

      expect(h.runner.lastManifestCheckAt).toBe(777)
    })
  })

  describe('#given the manifest finds server-only items #when run', () => {
    it('#then the cursor is reset and a second pull runs', async () => {
      const h = createHarness()
      mocks.checkManifestIntegrity.mockResolvedValue(
        manifestResult({ rePullNeeded: true, serverOnlyCount: 3 })
      )

      await h.runner.run()

      expect(h.setStateValue).toHaveBeenCalledWith(SYNC_STATE_KEYS.LAST_CURSOR, '0')
      expect(h.actions.pull).toHaveBeenCalledTimes(2)
      // The cursor reset must precede the re-pull, or the re-pull uses the old
      // cursor and the missing items stay missing.
      expect(h.calls.indexOf(`setState:${SYNC_STATE_KEYS.LAST_CURSOR}`)).toBeLessThan(
        h.calls.lastIndexOf('pull')
      )
    })

    it('#then no re-pull happens when the manifest agrees', async () => {
      const h = createHarness()

      await h.runner.run()

      expect(h.actions.pull).toHaveBeenCalledTimes(1)
      expect(h.setStateValue).not.toHaveBeenCalledWith(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    })
  })

  describe('#given the manifest re-queued items #when the cycle finishes', () => {
    it('#then a follow-up push drains them', async () => {
      const h = createHarness({ pendingCounts: [0, 0, 0, 5] })

      await h.runner.run()

      expect(h.actions.push).toHaveBeenCalledTimes(2)
    })

    it('#then a paused vault skips the follow-up push', async () => {
      const h = createHarness({ pendingCounts: [0, 0, 0, 5] })
      h.isPaused.mockReturnValue(true)

      await h.runner.run()

      expect(h.actions.push).toHaveBeenCalledTimes(1)
    })
  })

  describe('#given a stage throws #when run', () => {
    it('#then a failing pull aborts the remaining stages and surfaces the error', async () => {
      // No per-stage catch by design: the caller (SyncEngine) decides whether
      // to retry. What must NOT happen is a swallowed failure that reports a
      // completed sync.
      const h = createHarness()
      h.actions.pull.mockRejectedValue(new Error('network down'))

      await expect(h.runner.run()).rejects.toThrow('network down')

      expect(mocks.runInitialSeed).not.toHaveBeenCalled()
      expect(h.actions.push).not.toHaveBeenCalled()
      expect(mocks.checkManifestIntegrity).not.toHaveBeenCalled()
      expect(h.calls).not.toContain('progress:complete')
    })

    it('#then fullSyncActive is released even when a stage throws', async () => {
      // A stuck fullSyncActive flag blocks every later sync attempt for the
      // lifetime of the process.
      const h = createHarness()
      h.actions.push.mockRejectedValue(new Error('push exploded'))

      await expect(h.runner.run()).rejects.toThrow('push exploded')

      expect(h.ctx.fullSyncActive).toBe(false)
    })

    it('#then CRDT pulls queued before the failure are still flushed', async () => {
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      h.crdtSync.addPendingPull('note-1')
      h.crdtSync.addPendingPull('note-2')
      h.actions.pull.mockRejectedValue(new Error('boom'))

      await expect(h.runner.run()).rejects.toThrow('boom')

      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledWith(
        ['note-1', 'note-2'],
        expect.any(AbortSignal)
      )
      expect(h.crdtSync.pendingPullCount).toBe(0)
    })

    it('#then a failing manifest check does not strand the run mid-cycle', async () => {
      const h = createHarness()
      mocks.checkManifestIntegrity.mockRejectedValue(new Error('manifest fetch failed'))

      await expect(h.runner.run()).rejects.toThrow('manifest fetch failed')

      expect(h.ctx.fullSyncActive).toBe(false)
      // Pull and push already happened, so the device is not left with a
      // silently empty queue.
      expect(h.actions.pull).toHaveBeenCalled()
      expect(h.actions.push).toHaveBeenCalled()
    })
  })

  describe('#given CRDT-backed notes #when the cycle ends', () => {
    it('#then every CRDT note is re-queued and scheduled for a pull', async () => {
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).toHaveBeenCalledWith({ __db: 'index' })
      // One scheduled chunk for both notes, not one per note: the single-note
      // path costs two GETs each, which is what put 242 requests on the wire in
      // four seconds for a 121-note vault.
      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(1)
      expect(h.crdtSync.pendingPullCount).toBe(0)
    })

    it('#then the scheduled work pulls the specific note', async () => {
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-7'])
      const scheduled: Array<() => Promise<void>> = []
      h.actions.scheduleSync.mockImplementation((fn: () => Promise<void>) => {
        scheduled.push(fn)
      })

      await h.runner.run()
      await scheduled[0]()

      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledWith(['note-7'], expect.any(AbortSignal))
    })

    it('#then the index DB is not touched while it is uninitialized', async () => {
      // Vault switch / teardown: reading an unopened index DB throws inside a
      // finally block, which would replace the real sync error.
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(false)

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()
    })

    it('#then no CRDT provider means no CRDT bookkeeping at all', async () => {
      const h = createHarness()
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()
      expect(h.actions.scheduleSync).not.toHaveBeenCalled()
    })

    it('#then a completed sweep is stamped so the next cycle can throttle it', async () => {
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1'])

      await h.runner.run()

      expect(h.calls).toContain(`setState:${SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT}`)
    })
  })

  // The per-note unmerged set is in-memory and per session, so a note left
  // unmerged at quit came back on the next launch looking merged — and a launch
  // inside the sweep interval queues nothing that would re-raise it. One edit
  // 30 s later then pushed a snapshot, and the server prunes every `crdt_updates`
  // row at or below the new watermark, including the peer rows this device never
  // read. Only the fact that debt existed is persisted; the ids are re-derived.
  describe('#given the previous session ended holding unmerged notes', () => {
    it('#then every note reads as unmerged until a sweep rebuilds the flags', () => {
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT ? '1' : undefined
      )

      expect(h.runner.crdtUnmergedStateUnknown).toBe(true)
    })

    it('#then a clean set cannot clear the persisted debt before that sweep', () => {
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT ? '1' : undefined
      )

      // An empty set here is the emptiness this session started with, not an
      // answer about what the last one left behind.
      h.runner.recordCrdtUnmergedDebt(false)

      expect(h.setStateValue).not.toHaveBeenCalledWith(SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT, '0')
      expect(h.runner.crdtUnmergedStateUnknown).toBe(true)
    })

    it('#then the sweep drops the blanket only once every note carries its own flag', async () => {
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT ? '1' : undefined
      )
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])

      await h.runner.run()

      expect(h.runner.crdtUnmergedStateUnknown).toBe(false)
      expect(h.crdtSync.unmerged).toEqual(new Set(['note-1', 'note-2']))
      // The vault's own set is authoritative from here, so the key is re-stated
      // from it rather than left holding the previous session's answer.
      expect(h.setStateValue).toHaveBeenCalledWith(SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT, '1')
    })

    it('#then a sweep that finds nothing to flag clears the carried-over debt', async () => {
      // Otherwise an empty vault — or one whose notes all cleared before the key
      // was written — blankets every launch from here on, forever.
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT ? '1' : undefined
      )
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue([])

      await h.runner.run()

      expect(h.setStateValue).toHaveBeenCalledWith(SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT, '0')
      expect(h.runner.crdtUnmergedStateUnknown).toBe(false)
    })
  })

  describe('#given no carried-over debt #when the coordinator reports a transition', () => {
    it('#then it is persisted as it happens, not at teardown', () => {
      // A session that is killed rather than stopped never runs a teardown, and
      // that is exactly the session whose debt has to survive.
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })

      h.runner.recordCrdtUnmergedDebt(true)
      h.runner.recordCrdtUnmergedDebt(false)

      expect(h.setStateValue).toHaveBeenNthCalledWith(1, SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT, '1')
      expect(h.setStateValue).toHaveBeenNthCalledWith(2, SYNC_STATE_KEYS.CRDT_UNMERGED_DEBT, '0')
    })
  })

  describe('#given the socket stayed live since the last sweep #when another full sync starts', () => {
    it('#then the sweep never runs again, however long has passed', async () => {
      // fullSync also fires on auth refresh and rate-limit release. While the
      // socket is up, every remote body edit already arrived as a
      // `crdt_updated` broadcast and was pulled per note, so a sweep can only
      // re-discover what this device already has. A clock cannot see that: the
      // liveness signal must win over the interval, not the other way round.
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])

      await h.runner.run()
      expect(mocks.getAllCrdtNoteIds).toHaveBeenCalledTimes(1)

      mocks.getAllCrdtNoteIds.mockClear()
      h.actions.scheduleSync.mockClear()
      // Well past the fallback interval, and the socket never dropped.
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT
          ? String(Date.now() - CRDT_FULL_SWEEP_MIN_INTERVAL_MS * 10)
          : undefined
      )

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()
      expect(h.actions.scheduleSync).not.toHaveBeenCalled()
    })

    it('#then notes the server announced over the websocket are still pulled', async () => {
      // The gate only covers the blanket safety-net sweep. A `crdt_updated`
      // broadcast is a positive signal that THIS note changed remotely and must
      // never be swallowed.
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])

      await h.runner.run()
      mocks.getAllCrdtNoteIds.mockClear()
      h.actions.scheduleSync.mockClear()
      h.crdtSync.addPendingPull('note-9')

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()
      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(1)
      expect(h.crdtSync.pendingPullCount).toBe(0)
    })

    it('#then a sync the user asked for by name sweeps anyway', async () => {
      // "Sync now" is the escape hatch for a note that looks stale, and note
      // bodies are invisible to the record change feed — so a live socket that
      // provably missed nothing is still the wrong answer to give the person
      // who just pressed the button. The throttle is there to stop an automatic
      // reconnect loop buying one O(vault) pass per flap; a hand-pressed button
      // cannot flap.
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])

      await h.runner.run()
      mocks.getAllCrdtNoteIds.mockClear()
      h.actions.scheduleSync.mockClear()

      await h.runner.run({ forceCrdtSweep: true })

      expect(mocks.getAllCrdtNoteIds).toHaveBeenCalledTimes(1)
      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(1)
    })
  })

  describe('#given the socket dropped and came back #when another full sync starts', () => {
    it('#then the sweep runs immediately rather than waiting out the interval', async () => {
      // This is the one case where broadcasts were provably missed, and the
      // case where the user is most likely staring at a stale note. Deferring
      // it by the fallback interval would be exactly backwards.
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])

      await h.runner.run()
      mocks.getAllCrdtNoteIds.mockClear()
      h.actions.scheduleSync.mockClear()
      // Past the reconnect floor but far inside the fallback interval.
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT
          ? String(Date.now() - CRDT_RECONNECT_SWEEP_FLOOR_MS - 1)
          : undefined
      )
      h.ws.connectionGeneration += 1

      await h.runner.run()

      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(1)
    })

    it('#then a sweep that ran moments ago for another reason does not hold it back', async () => {
      // Regression: the reconnect floor used to be measured against
      // LAST_CRDT_SWEEP_AT, which is also stamped by the startup, forced and
      // interval sweeps. An app that had just started and then lost its
      // connection once therefore sat on stale note bodies for a whole floor,
      // even though this was its first reconnect and nothing needed collapsing.
      // The two-device body-CRDT E2E specs caught it as "the other device's
      // edit never arrives".
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])

      await h.runner.run()
      mocks.getAllCrdtNoteIds.mockClear()
      h.actions.scheduleSync.mockClear()
      // That startup sweep landed a second ago — deep inside the floor.
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT ? String(Date.now() - 1_000) : undefined
      )
      h.ws.connectionGeneration += 1

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).toHaveBeenCalledTimes(1)
      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(1)
    })

    it('#then a socket that is still down falls back to the interval', async () => {
      // Down-and-not-yet-back is not a completed reconnect. Sweeping on every
      // cycle here would reinstate the storm for anyone whose socket is blocked
      // outright, so the interval bounds it instead.
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])

      await h.runner.run()
      mocks.getAllCrdtNoteIds.mockClear()
      h.actions.scheduleSync.mockClear()
      h.ws.connected = false
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT ? String(Date.now() - 1000) : undefined
      )

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()

      // ...but it does run once the interval elapses.
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT
          ? String(Date.now() - CRDT_FULL_SWEEP_MIN_INTERVAL_MS - 1)
          : undefined
      )

      await h.runner.run()

      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(1)
    })
  })

  describe('#given a connection flapping faster than the floor #when it reconnects', () => {
    // A drop/reconnect is a real gap, so the sweep is owed — but one full
    // O(vault) pass per flap is the exact "single Wi-Fi blip = ~2,000 requests"
    // storm #998 was filed about. The floor collapses a burst of flaps into one
    // sweep; the debt must survive it.
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    async function reconnectInsideFloor(): Promise<Harness> {
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])

      await h.runner.run()
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT ? String(Date.now() - 1_000) : undefined
      )
      // The first drop is owed a sweep at once — that is what starts the floor.
      h.ws.connectionGeneration += 1
      await h.runner.run()

      mocks.getAllCrdtNoteIds.mockClear()
      h.actions.scheduleSync.mockClear()
      // The flap: a second reconnect inside the floor of the sweep above.
      h.ws.connectionGeneration += 1
      await h.runner.run()
      return h
    }

    it('#then the sweep is held back instead of running per flap', async () => {
      const h = await reconnectInsideFloor()

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()
      expect(h.actions.scheduleSync).not.toHaveBeenCalled()
    })

    it('#then the owed sweep still runs once the floor expires', async () => {
      // The debt cannot be silently swallowed: after a flap the device is
      // missing whatever changed during the gap, and no further fullSync is
      // guaranteed once the connection settles.
      const h = await reconnectInsideFloor()

      await vi.advanceTimersByTimeAsync(CRDT_RECONNECT_SWEEP_FLOOR_MS)

      expect(mocks.getAllCrdtNoteIds).toHaveBeenCalledTimes(1)
      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(1)
    })

    it('#then repeated flaps inside the floor still cost exactly one sweep', async () => {
      const h = await reconnectInsideFloor()

      for (let i = 0; i < 5; i++) {
        h.ws.connectionGeneration += 1
        await h.runner.run()
      }
      await vi.advanceTimersByTimeAsync(CRDT_RECONNECT_SWEEP_FLOOR_MS)

      expect(mocks.getAllCrdtNoteIds).toHaveBeenCalledTimes(1)
    })

    it('#then a full sync arriving past the floor pays the debt without double-sweeping', async () => {
      // The deferred timer is still armed at this point. If it did not check
      // whether the debt was already settled, the vault would be swept twice
      // for one gap — the storm this floor exists to prevent, half-restored.
      const h = await reconnectInsideFloor()

      // Walk the wall clock past the floor without letting the armed timer fire,
      // so the next fullSync is the one that settles the debt.
      vi.setSystemTime(Date.now() + CRDT_RECONNECT_SWEEP_FLOOR_MS + 1)
      await h.runner.run()
      expect(mocks.getAllCrdtNoteIds).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(CRDT_RECONNECT_SWEEP_FLOOR_MS * 2)

      expect(mocks.getAllCrdtNoteIds).toHaveBeenCalledTimes(1)
    })

    it('#then the debt is cleared once paid, so a live socket never re-arms it', async () => {
      const h = await reconnectInsideFloor()
      await vi.advanceTimersByTimeAsync(CRDT_RECONNECT_SWEEP_FLOOR_MS)
      mocks.getAllCrdtNoteIds.mockClear()

      await h.runner.run()
      // A leaked debt would have deferred here and armed a fresh timer.
      await vi.advanceTimersByTimeAsync(CRDT_RECONNECT_SWEEP_FLOOR_MS * 2)

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()
    })

    it('#then disposing the runner cancels every pending owed sweep', async () => {
      // Engine teardown (vault switch, sign-out): a timer left armed fires
      // against a dead engine and drains the pending pulls into a no-op. Each
      // flap must therefore re-use the one armed timer rather than stacking a
      // new one — dispose() can only clear the handle it still holds.
      const h = await reconnectInsideFloor()
      for (let i = 0; i < 3; i++) {
        h.ws.connectionGeneration += 1
        await h.runner.run()
      }

      h.runner.dispose()
      await vi.advanceTimersByTimeAsync(CRDT_RECONNECT_SWEEP_FLOOR_MS * 2)

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()
    })
  })

  describe('#given no liveness signal yet #when a full sync starts', () => {
    it('#then a fresh runner does not sweep unconditionally', async () => {
      // FullSyncRunner is rebuilt with every engine (vault switch, restart,
      // retry). An instance-only signal that re-armed an immediate sweep would
      // repeat the lastManifestCheckAt bug: a retry loop would sweep the whole
      // vault on every single cycle. The persisted stamp is the authority here.
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT ? String(Date.now() - 1000) : undefined
      )

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()
    })

    it('#then a stamp older than the interval sweeps', async () => {
      // A device that was offline for weeks discovers body-only remote edits
      // (which never enter the record change feed) only through this sweep.
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT
          ? String(Date.now() - CRDT_FULL_SWEEP_MIN_INTERVAL_MS - 1)
          : undefined
      )

      await h.runner.run()

      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(1)
    })

    it('#then a missing websocket manager falls back to the interval', async () => {
      const h = createHarness({ crdtProvider: fakeCrdtProvider(), ws: null })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1'])

      await h.runner.run()
      mocks.getAllCrdtNoteIds.mockClear()
      h.actions.scheduleSync.mockClear()
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT ? String(Date.now() - 1000) : undefined
      )

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()
    })

    it('#then a future-dated stamp does not park the sweep until the clock catches up', async () => {
      // Clock skew or a machine migration can leave a stamp 30 days ahead.
      // Trusting it would disable the only discovery path for body-only remote
      // edits for a month.
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1'])
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT
          ? String(Date.now() + 30 * 24 * 60 * 60 * 1000)
          : undefined
      )

      await h.runner.run()

      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(1)
    })

    it('#then a non-numeric stamp is treated as never swept', async () => {
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1'])
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT ? 'not-a-number' : undefined
      )

      await h.runner.run()

      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(1)
    })
  })

  describe('#given the gate would otherwise skip #when the cycle demands a sweep', () => {
    it('#then a manifest re-pull forces the sweep even on a live socket', async () => {
      // Server rows this device has never seen (fresh install, restored vault,
      // index rebuild) mean local CRDT state cannot be trusted, whatever the
      // socket did.
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])

      await h.runner.run()
      mocks.getAllCrdtNoteIds.mockClear()
      h.actions.scheduleSync.mockClear()
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT ? String(Date.now()) : undefined
      )
      mocks.checkManifestIntegrity.mockResolvedValue(
        manifestResult({ rePullNeeded: true, serverOnlyCount: 3 })
      )

      await h.runner.run()

      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(1)
    })

    it('#then an offline cycle neither sweeps nor burns the throttle window', async () => {
      // Pulls scheduled while offline are guaranteed to fail; stamping the
      // sweep there would hide real remote edits for a whole interval.
      const h = createHarness({ crdtProvider: fakeCrdtProvider(), online: false })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()
      expect(h.calls).not.toContain(`setState:${SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT}`)
    })
  })

  describe('#given a vault bigger than one chunk #when the sweep runs', () => {
    // The sweep is a catch-up, not a race. Fired all at once down the
    // single-note path it cost two GETs per note — 242 requests in about four
    // seconds for a 121-note vault, against what was then a limit of 300 per 60s
    // shared with the account's other devices — and 92 of those 121 notes came
    // back "Too many requests" and silently kept their stale bodies. That bucket
    // is now 600 per 60s and per device, but the pacing still has to hold for
    // vaults large enough to blow the wider ceiling.
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    const noteIds = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `note-${index}`)

    function sweepingHarness(count: number, provider = fakeCrdtProvider()): Harness {
      const h = createHarness({ crdtProvider: provider })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(noteIds(count))
      return h
    }

    function pulledNoteIds(h: Harness): string[] {
      return h.crdtSync.pullCrdtForNotes.mock.calls.flatMap(([ids]) => ids)
    }

    // The server meters the two phases of a chunk in separate buckets, both
    // keyed by deviceId rather than by account (sync-server routes/sync.ts):
    //   GET  /sync/crdt/snapshot/:noteId + /sync/crdt/updates -> 600 / 60s
    //   POST /sync/crdt/updates/batch                         ->  30 / 60s
    // The margin is 50% of each, leaving the rest for editor traffic, the
    // un-paced priority batch, broadcast-driven single-note pulls and a second
    // sweep a flapping socket may start.
    const GET_BUDGET_PER_MIN = 600
    const POST_BUDGET_PER_MIN = 30
    const MARGIN = 0.5

    const ratesFor = (cost: CrdtPullCost): { gets: number; posts: number } => {
      const chunksPerMinute = 60_000 / crdtSweepChunkDelayMs(cost)
      return {
        gets: cost.snapshotGets * chunksPerMinute,
        posts: cost.batchPosts * chunksPerMinute
      }
    }

    it.each([
      // Warm: the probe settles every note. One POST, no GET, no doc opened.
      ['warm', { snapshotGets: 0, batchPosts: 1 }],
      // Cold: no watermark anywhere, so no probe is sent at all — 100 baselines
      // and ceil(100/32) = 4 apply rounds.
      ['cold', { snapshotGets: CRDT_SWEEP_CHUNK_NOTES, batchPosts: 4 }],
      // Old server: one wasted probe on the first chunk, then the flag latches
      // and the cost is the cold one exactly.
      ['old server, first chunk', { snapshotGets: CRDT_SWEEP_CHUNK_NOTES, batchPosts: 5 }],
      // A cold chunk whose notes have a real backlog: applyCrdtBatchChunk loops
      // while any note reports `hasMore`, so the POST count is a floor. Four
      // rounds per sub-chunk is the case a fixed interval would have blown the
      // batch bucket on.
      ['cold, R = 4 batch rounds', { snapshotGets: CRDT_SWEEP_CHUNK_NOTES, batchPosts: 16 }]
    ])('#then the %s regime stays inside BOTH buckets', (_name, cost: CrdtPullCost) => {
      const { gets, posts } = ratesFor(cost)

      expect(gets).toBeLessThanOrEqual(GET_BUDGET_PER_MIN * MARGIN)
      expect(posts).toBeLessThanOrEqual(POST_BUDGET_PER_MIN * MARGIN)
    })

    it('#then the two phases are paced by their own bucket, not a shared one', () => {
      // The point of the split. A warm chunk spends only `crdt_batch_pull`, so
      // it must not be held back by the GET pace; a cold chunk of the same 100
      // notes spends `crdt_pull` a hundred times over and must be.
      const warm = crdtSweepChunkDelayMs({ snapshotGets: 0, batchPosts: 1 })
      const cold = crdtSweepChunkDelayMs({ snapshotGets: CRDT_SWEEP_CHUNK_NOTES, batchPosts: 4 })

      expect(warm).toBe(CRDT_SWEEP_MS_PER_BATCH_POST)
      expect(cold).toBe(CRDT_SWEEP_CHUNK_NOTES * CRDT_SWEEP_MS_PER_SNAPSHOT_GET)
      expect(cold).toBeGreaterThan(warm)

      // 1,000 notes: ten chunks either way, but ~40 s warm against ~3 min 20 s
      // cold — and ten minutes before this pacing existed.
      const chunks = Math.ceil(1000 / CRDT_SWEEP_CHUNK_NOTES)
      expect(chunks * warm).toBeLessThanOrEqual(60_000)
      expect(chunks * cold).toBeLessThanOrEqual(4 * 60_000)
    })

    it('#then a chunk that spends more POSTs waits longer instead of bursting', () => {
      // The R > 1 floor. Every extra `hasMore` round is another POST on the
      // batch bucket, so the count is measured rather than assumed: the sweep
      // slows down, it does not overrun.
      const one = crdtSweepChunkDelayMs({ snapshotGets: 0, batchPosts: 1 })
      const eight = crdtSweepChunkDelayMs({ snapshotGets: 0, batchPosts: 8 })

      expect(eight).toBe(one * 8)
      expect((8 * 60_000) / eight).toBeLessThanOrEqual(POST_BUDGET_PER_MIN * MARGIN)
    })

    it('#then the whole sweep leaves through the batch path, never one pull per note', async () => {
      const h = sweepingHarness(3)

      await h.runner.run()

      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledWith(
        ['note-0', 'note-1', 'note-2'],
        expect.any(AbortSignal)
      )
      // The single-note path is two GETs per note (snapshot, then incrementals).
      // The batch path shares one incrementals POST across the group — the
      // snapshot baselines are still one GET each, so this halves the traffic
      // rather than collapsing it.
      expect(h.crdtSync.pullCrdtForNote).not.toHaveBeenCalled()
    })

    it('#then only one chunk goes out per interval, whatever the vault size', async () => {
      const h = sweepingHarness(250)

      await h.runner.run()

      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledTimes(1)
      expect(h.crdtSync.pullCrdtForNotes.mock.calls[0][0]).toHaveLength(CRDT_SWEEP_CHUNK_NOTES)

      // Nothing more may go out before the charged interval elapses. The fake
      // reports a warm chunk — one probe POST, no snapshot GETs — which charges
      // exactly CRDT_SWEEP_CHUNK_INTERVAL_MS.
      await vi.advanceTimersByTimeAsync(CRDT_SWEEP_CHUNK_INTERVAL_MS - 1)
      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(CRDT_SWEEP_CHUNK_INTERVAL_MS)
      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledTimes(3)

      // Paced, not sampled: every note is still covered, exactly once.
      const pulled = pulledNoteIds(h)
      expect(pulled).toHaveLength(250)
      expect(new Set(pulled)).toEqual(new Set(noteIds(250)))
    })

    it('#then the paced chunk is the probe size, NOT the doc cache size', async () => {
      // The split. The probe opens no document, so the doc cache cannot bound
      // it — the server's 100-note cap on the batch endpoint is the only
      // ceiling. Clamping here would spend one probe POST per 32 notes instead
      // of per 100, and the probe POST is the whole cost of a warm sweep.
      // The doc-cache bound still exists; it moved to the apply phase inside
      // applyCrdtBatch, and is pinned in crdt-sweep-pacing.test.ts.
      const h = sweepingHarness(250, fakeCrdtProvider({ inactiveDocCapacity: 4 }))

      await h.runner.run()

      expect(h.crdtSync.pullCrdtForNotes.mock.calls[0][0]).toHaveLength(CRDT_SWEEP_CHUNK_NOTES)
    })

    it('#then a chunk that spent GETs pushes the next chunk out', async () => {
      // A cold chunk is charged against `crdt_pull` rather than the floor, so
      // the next one waits the GET pace, not the probe pace.
      const h = sweepingHarness(250)
      h.crdtSync.pullCrdtForNotes.mockResolvedValue({
        snapshotGets: CRDT_SWEEP_CHUNK_NOTES,
        batchPosts: 4
      })

      await h.runner.run()
      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledTimes(1)

      // The warm pace would have fired a second chunk by now.
      await vi.advanceTimersByTimeAsync(CRDT_SWEEP_CHUNK_INTERVAL_MS)
      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(
        CRDT_SWEEP_CHUNK_NOTES * CRDT_SWEEP_MS_PER_SNAPSHOT_GET - CRDT_SWEEP_CHUNK_INTERVAL_MS
      )
      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledTimes(2)
    })

    it('#then a note with a live editor is pulled before the paced queue', async () => {
      const h = sweepingHarness(60, fakeCrdtProvider({ activeNoteIds: ['note-40'] }))

      await h.runner.run()

      // The note the user is looking at is the one whose stale body is the bug.
      // It must not queue behind a catch-up that takes minutes on a large vault,
      // so it leaves in its own batch first; the cost is bounded by the number
      // of open editors.
      expect(h.crdtSync.pullCrdtForNotes.mock.calls[0][0]).toEqual(['note-40'])
      expect(h.crdtSync.pullCrdtForNotes.mock.calls[1][0]).not.toContain('note-40')
    })

    // #1614: three tiers, not two. Live editors bypass the pace (above), the
    // provider's LRU leads the paced queue, and the vault tail arrives from
    // getAllCrdtNoteIds in modifiedAt DESC. All of it is ordering: the sweep is
    // the only channel a body-only remote edit reaches this device through, so
    // nothing may ever be dropped to make room for a higher tier.
    it('#then open-but-inactive docs lead the paced queue', async () => {
      // The 32-doc LRU is a recently-opened list, already in memory. Those notes
      // are one click away and today they get no priority at all — note-150 would
      // wait out a whole chunk purely because of where it sits in the vault.
      // The vault must outrun one chunk and the open notes must sit past the
      // first one, or the tier buys nothing here and the test passes for free.
      const h = sweepingHarness(250, fakeCrdtProvider({ openNoteIds: ['note-150', 'note-200'] }))

      await h.runner.run()

      const firstChunk = h.crdtSync.pullCrdtForNotes.mock.calls[0][0]
      expect(firstChunk.slice(0, 2)).toEqual(['note-150', 'note-200'])
      expect(firstChunk).toHaveLength(CRDT_SWEEP_CHUNK_NOTES)
    })

    it('#then a live editor still outranks an open-but-inactive doc', async () => {
      const h = sweepingHarness(
        60,
        fakeCrdtProvider({ activeNoteIds: ['note-40'], openNoteIds: ['note-40', 'note-50'] })
      )

      await h.runner.run()

      // The active note leaves un-paced in its own batch; the cached-but-closed
      // one only leads the paced queue.
      expect(h.crdtSync.pullCrdtForNotes.mock.calls[0][0]).toEqual(['note-40'])
      expect(h.crdtSync.pullCrdtForNotes.mock.calls[1][0][0]).toBe('note-50')
    })

    it('#then the order the sweep supplies is the order the queue drains', async () => {
      // getAllCrdtNoteIds now returns modifiedAt DESC, and nothing between it
      // and the wire may re-sort: pendingPulls is a Set drained with Array.from
      // and the paced queue is a Set read by iteration, so insertion order IS
      // the priority. If that ever stops holding, the ORDER BY buys nothing.
      const h = createHarness({ crdtProvider: fakeCrdtProvider() })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['newest', 'middle', 'oldest'])

      await h.runner.run()

      expect(h.crdtSync.pullCrdtForNotes.mock.calls[0][0]).toEqual(['newest', 'middle', 'oldest'])
    })

    it('#then open docs jump ahead of a drain already in progress', async () => {
      // A sweep landing mid-catch-up is the case that matters: appending would
      // put a note the user just opened behind everything the previous pass has
      // left waiting, which on a large vault is minutes.
      const open: string[] = []
      const h = sweepingHarness(60, fakeCrdtProvider({ openNoteIds: open }))

      await h.runner.run()
      expect(h.crdtSync.pullCrdtForNotes.mock.calls[0][0][0]).toBe('note-0')

      open.push('note-59')
      h.ws.connectionGeneration += 1
      await h.runner.run()

      await vi.advanceTimersByTimeAsync(CRDT_SWEEP_CHUNK_INTERVAL_MS)
      expect(h.crdtSync.pullCrdtForNotes.mock.calls[1][0][0]).toBe('note-59')
    })

    it('#then prioritising never drops a note from the sweep', async () => {
      // The invariant the whole ordering change is subordinate to. Note bodies
      // never travel in the record change feed, so a note the sweep skips keeps
      // a stale body until some later sweep happens to include it — a slow
      // catch-up turned into a silent one. Priority, never filtering.
      const h = sweepingHarness(
        60,
        fakeCrdtProvider({ activeNoteIds: ['note-3'], openNoteIds: ['note-3', 'note-50'] })
      )

      await h.runner.run()
      await vi.advanceTimersByTimeAsync(CRDT_SWEEP_CHUNK_INTERVAL_MS * 5)

      const pulled = pulledNoteIds(h)
      expect(new Set(pulled)).toEqual(new Set(noteIds(60)))
      // Exactly once, too: re-ordering must not duplicate work either.
      expect(pulled).toHaveLength(60)
    })

    it('#then a second sweep joins the running drain instead of starting its own', async () => {
      const h = sweepingHarness(250)

      await h.runner.run()
      // A reconnect past the floor, so the gate sweeps the vault again while the
      // first drain is still working through it.
      h.ws.connectionGeneration += 1
      await h.runner.run()

      // Two drains in parallel double the request rate and put the arithmetic
      // straight back over the server's limit.
      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(CRDT_SWEEP_CHUNK_INTERVAL_MS)
      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledTimes(2)

      // ...and the second sweep re-queues the vault once, not once per copy
      // already waiting. 100 pulled by the first chunk, then the 250 the second
      // sweep queued — the 150 still waiting were deduped into it. An array
      // queue would have carried those 150 twice and pulled 500.
      await vi.advanceTimersByTimeAsync(CRDT_SWEEP_CHUNK_INTERVAL_MS * 5)
      expect(pulledNoteIds(h)).toHaveLength(CRDT_SWEEP_CHUNK_NOTES + 250)
    })

    it('#then disposing the runner cancels the rest of the paced sweep', async () => {
      // Engine teardown (vault switch, sign-out): a timer left armed keeps
      // pulling against a vault this engine no longer owns.
      const h = sweepingHarness(250)

      await h.runner.run()
      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledTimes(1)

      h.runner.dispose()
      await vi.advanceTimersByTimeAsync(CRDT_SWEEP_CHUNK_INTERVAL_MS * 10)

      expect(h.crdtSync.pullCrdtForNotes).toHaveBeenCalledTimes(1)
    })

    it('#then disposing the runner aborts the chunk already in flight', async () => {
      // Clearing the queue and the timer only stops the NEXT chunk. A paced
      // sweep spans minutes, so at teardown there is almost always one in
      // flight, and it would otherwise keep pulling into a provider and vault
      // this engine no longer owns.
      const h = sweepingHarness(60)

      await h.runner.run()
      const [, signal] = h.crdtSync.pullCrdtForNotes.mock.calls[0] as [string[], AbortSignal]
      expect(signal.aborted).toBe(false)

      h.runner.dispose()

      expect(signal.aborted).toBe(true)
    })

    it('#then a later sweep does not inherit the aborted signal', async () => {
      // An aborted controller stays aborted, so reusing it would leave every
      // pull of the next engine cancelled before it started.
      const h = sweepingHarness(60)

      await h.runner.run()
      const [, first] = h.crdtSync.pullCrdtForNotes.mock.calls[0] as [string[], AbortSignal]
      h.runner.dispose()
      expect(first.aborted).toBe(true)

      h.crdtSync.addPendingPull('note-later')
      await h.runner.run()

      const [, latest] = h.crdtSync.pullCrdtForNotes.mock.calls.at(-1) as [string[], AbortSignal]
      expect(latest.aborted).toBe(false)
    })
  })
})
