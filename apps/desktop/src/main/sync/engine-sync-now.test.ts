import { afterEach, describe, expect, it, vi } from 'vitest'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import { SyncEngine, type SyncEngineDeps } from './engine'
import type { SyncRunOutcome } from './engine/sync-context'
import { DELIVERED } from './engine/sync-run-outcome'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'

interface EngineInternals {
  fullSyncRunner: { run(): Promise<SyncRunOutcome> }
}

const internals = (engine: SyncEngine): EngineInternals => engine as unknown as EngineInternals

/** The statuses the renderer was sent, in order. */
const sentStatuses = (deps: SyncEngineDeps): unknown[] =>
  vi
    .mocked(deps.emitToRenderer)
    .mock.calls.filter(([channel]) => channel === EVENT_CHANNELS.STATUS_CHANGED)
    .map(([, event]) => (event as { status: unknown }).status)

// #3382: a Mac paused sync and showed Synced for three days while its changes
// went nowhere, and each Sync Now started another full sync that moved nothing.
describe('SyncEngine pause, full sync, and Sync Now', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('still reports paused after the pull the pause stopped lets go of the lock', async () => {
    const deps = createMockDeps(getDb())
    const engine = new SyncEngine(deps)
    // The user pauses while a pull is under way.
    vi.mocked(deps.getVaultKey).mockImplementation(async () => {
      engine.pause('popover')
      return new Uint8Array(32)
    })

    await expect(engine.pull()).resolves.toEqual({ status: 'incomplete' })

    expect(sentStatuses(deps).at(-1)).toBe('paused')
    expect(engine.getStatus().status).toBe('paused')
  })

  it('records who paused, and records the runs the pause refused as skipped', async () => {
    const track = vi.spyOn(await import('../telemetry/track'), 'trackMainEvent')
    const deps = createMockDeps(getDb())
    const engine = new SyncEngine(deps)

    engine.pause('settings')
    deps.queue.enqueue({ type: 'task', itemId: 'task-1', operation: 'create', payload: '{}' })
    await engine.push()
    await engine.pull()
    await engine.fullSync()

    expect(track).toHaveBeenCalledWith(
      'setting_changed',
      expect.objectContaining({ action: 'paused', source: 'settings' })
    )
    const runs = track.mock.calls.filter(([name]) => name === 'sync_run_completed')
    expect(runs.map(([, props]) => props)).toEqual(
      ['push_completed', 'pull_completed', 'full_completed'].map((action) =>
        expect.objectContaining({
          action,
          result: 'skipped',
          dimensions: { skip_reason: 'paused' }
        })
      )
    )
  })

  describe('#given full sync requests', () => {
    it('#then one runs at a time, and the requests made during it share one more run', async () => {
      const engine = new SyncEngine(createMockDeps(getDb()))
      const finishers: Array<() => void> = []
      const run = vi.spyOn(internals(engine).fullSyncRunner, 'run').mockImplementation(
        () =>
          new Promise((resolve) =>
            finishers.push(() => {
              resolve(DELIVERED)
            })
          )
      )

      const requests = [engine.fullSync(), engine.fullSync(), engine.fullSync()]
      expect(run).toHaveBeenCalledTimes(1)

      finishers[0]()
      await vi.waitFor(() => {
        expect(run).toHaveBeenCalledTimes(2)
      })
      finishers[1]()

      await expect(Promise.all(requests)).resolves.toEqual([DELIVERED, DELIVERED, DELIVERED])
      expect(run).toHaveBeenCalledTimes(2)
    })

    it('#then a run that threw does not hold up the next request', async () => {
      const engine = new SyncEngine(createMockDeps(getDb()))
      vi.spyOn(internals(engine).fullSyncRunner, 'run')
        .mockRejectedValueOnce(new Error('pull exploded'))
        .mockResolvedValueOnce(DELIVERED)

      await expect(engine.fullSync()).rejects.toThrow('pull exploded')
      await expect(engine.fullSync()).resolves.toEqual(DELIVERED)
    })
  })

  describe('#given Sync Now', () => {
    it('#then offline it ends the pause, so the changes go out on reconnect, and says offline', async () => {
      const deps = createMockDeps(getDb())
      ;(deps.network as unknown as { _online: boolean })._online = false
      const engine = new SyncEngine(deps)
      engine.pause('popover')
      const run = vi.spyOn(internals(engine).fullSyncRunner, 'run')

      await expect(engine.syncNow()).resolves.toEqual({ success: false, reason: 'offline' })

      expect(engine.getStatus().status).toBe('idle')
      expect(run).not.toHaveBeenCalled()
    })

    it('#then without a session it asks for a sign-in instead of reporting success', async () => {
      const engine = new SyncEngine(
        createMockDeps(getDb(), { getAccessToken: vi.fn().mockResolvedValue(null) })
      )

      await expect(engine.syncNow()).resolves.toEqual({ success: false, reason: 'signed_out' })
    })
  })
})
