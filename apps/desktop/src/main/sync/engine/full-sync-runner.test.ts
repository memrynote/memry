import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import { FullSyncRunner, type FullSyncActions } from './full-sync-runner'
import { CRDT_FULL_SWEEP_MIN_INTERVAL_MS, SYNC_STATE_KEYS, type SyncContext } from './sync-context'
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
  pullCrdtForNote = vi.fn(async () => {})

  addPendingPull(noteId: string): void {
    this.pending.add(noteId)
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

  const ctx = {
    deps: {
      db: { __db: 'data' },
      queue: { getPendingCount, purgeOldErrors },
      network: { online: options.online ?? true },
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
    scheduleSync: vi.fn((fn: () => Promise<void>) => {
      calls.push('scheduleSync')
      void fn
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
    crdtSync
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
      const h = createHarness()
      h.crdtSync.addPendingPull('note-1')
      h.crdtSync.addPendingPull('note-2')
      h.actions.pull.mockRejectedValue(new Error('boom'))

      await expect(h.runner.run()).rejects.toThrow('boom')

      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(2)
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
      const h = createHarness({ crdtProvider: {} })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).toHaveBeenCalledWith({ __db: 'index' })
      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(2)
      expect(h.crdtSync.pendingPullCount).toBe(0)
    })

    it('#then the scheduled work pulls the specific note', async () => {
      const h = createHarness({ crdtProvider: {} })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-7'])
      const scheduled: Array<() => Promise<void>> = []
      h.actions.scheduleSync.mockImplementation((fn: () => Promise<void>) => {
        scheduled.push(fn)
      })

      await h.runner.run()
      await scheduled[0]()

      expect(h.crdtSync.pullCrdtForNote).toHaveBeenCalledWith('note-7')
    })

    it('#then the index DB is not touched while it is uninitialized', async () => {
      // Vault switch / teardown: reading an unopened index DB throws inside a
      // finally block, which would replace the real sync error.
      const h = createHarness({ crdtProvider: {} })
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
      const h = createHarness({ crdtProvider: {} })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1'])

      await h.runner.run()

      expect(h.calls).toContain(`setState:${SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT}`)
    })
  })

  describe('#given a vault-wide CRDT sweep that just ran #when another full sync starts', () => {
    it('#then the sweep is skipped instead of re-pulling every note in the vault', async () => {
      // fullSync runs on every reconnect, resume, rate-limit release and auth
      // refresh. Re-queueing every note in the vault each time costs two HTTP
      // requests, a Y.Doc load and a keychain read PER NOTE, so a single Wi-Fi
      // blip on a 1,000-note vault cost ~2,000 requests.
      const h = createHarness({ crdtProvider: {} })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT ? String(Date.now() - 1000) : undefined
      )

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()
      expect(h.actions.scheduleSync).not.toHaveBeenCalled()
    })

    it('#then notes the server announced over the websocket are still pulled', async () => {
      // The throttle only covers the blanket safety-net sweep. A `crdt_updated`
      // broadcast is a positive signal that THIS note changed remotely and must
      // never be swallowed.
      const h = createHarness({ crdtProvider: {} })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT ? String(Date.now() - 1000) : undefined
      )
      h.crdtSync.addPendingPull('note-9')

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()
      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(1)
      expect(h.crdtSync.pendingPullCount).toBe(0)
    })

    it('#then a sweep older than the interval runs again', async () => {
      // A device that was offline for weeks discovers body-only remote edits
      // (which never enter the record change feed) only through this sweep.
      const h = createHarness({ crdtProvider: {} })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT
          ? String(Date.now() - CRDT_FULL_SWEEP_MIN_INTERVAL_MS - 1)
          : undefined
      )

      await h.runner.run()

      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(2)
    })

    it('#then a future-dated stamp does not park the sweep until the clock catches up', async () => {
      // Clock skew or a machine migration can leave a stamp 30 days ahead.
      // Trusting it would disable the only discovery path for body-only remote
      // edits for a month.
      const h = createHarness({ crdtProvider: {} })
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
      const h = createHarness({ crdtProvider: {} })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1'])
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT ? 'not-a-number' : undefined
      )

      await h.runner.run()

      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(1)
    })

    it('#then a manifest re-pull forces the sweep regardless of the throttle', async () => {
      // Server rows this device has never seen (fresh install, restored vault,
      // index rebuild) mean the local CRDT watermarks cannot be trusted.
      const h = createHarness({ crdtProvider: {} })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])
      h.getStateValue.mockImplementation((key: string) =>
        key === SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT ? String(Date.now()) : undefined
      )
      mocks.checkManifestIntegrity.mockResolvedValue(
        manifestResult({ rePullNeeded: true, serverOnlyCount: 3 })
      )

      await h.runner.run()

      expect(h.actions.scheduleSync).toHaveBeenCalledTimes(2)
    })

    it('#then an offline cycle neither sweeps nor burns the throttle window', async () => {
      // Pulls scheduled while offline are guaranteed to fail; stamping the
      // sweep there would hide real remote edits for a whole interval.
      const h = createHarness({ crdtProvider: {}, online: false })
      mocks.isIndexDatabaseInitialized.mockReturnValue(true)
      mocks.getAllCrdtNoteIds.mockReturnValue(['note-1', 'note-2'])

      await h.runner.run()

      expect(mocks.getAllCrdtNoteIds).not.toHaveBeenCalled()
      expect(h.calls).not.toContain(`setState:${SYNC_STATE_KEYS.LAST_CRDT_SWEEP_AT}`)
    })
  })
})
