import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FullSyncRunner, type FullSyncActions } from './full-sync-runner'
import { SYNC_STATE_KEYS, type SyncContext } from './sync-context'
import type { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import type { PushCoordinator } from './push-coordinator'
import type { SyncStateManager } from './sync-state-manager'

/**
 * The #1840 seam inside `FullSyncRunner.run()`: pack bootstrap runs for a
 * fresh device only, before the first item-granular pull, and can never break
 * it. Everything downstream of the hook is covered by pack-bootstrap.test.ts;
 * what is pinned here is that a client whose packs are unusable takes exactly
 * the path it took before packs existed.
 */

const mocks = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  runPackBootstrap: vi.fn(),
  checkManifestIntegrity: vi.fn(),
  runInitialSeed: vi.fn(),
  openBootstrapSession: vi.fn(),
  closeBootstrapSession: vi.fn(),
  isIndexDatabaseInitialized: vi.fn(() => false),
  getIndexDatabase: vi.fn(),
  getAllCrdtNoteIds: vi.fn(() => [])
}))

vi.mock('../../lib/logger', () => ({ createLogger: () => mocks.log }))
vi.mock('../manifest-check', () => ({
  checkManifestIntegrity: (...args: unknown[]) => mocks.checkManifestIntegrity(...args)
}))
vi.mock('../initial-seed', () => ({
  runInitialSeed: (...args: unknown[]) => mocks.runInitialSeed(...args)
}))
vi.mock('../bootstrap-metrics', () => ({
  beginBootstrap: vi.fn(),
  markBootstrapFullText: vi.fn(),
  abandonBootstrap: vi.fn()
}))
vi.mock('../bootstrap-session', () => ({
  openBootstrapSession: (...args: unknown[]) => mocks.openBootstrapSession(...args),
  closeBootstrapSession: (...args: unknown[]) => mocks.closeBootstrapSession(...args)
}))
vi.mock('../../database/client', () => ({
  getIndexDatabase: () => mocks.getIndexDatabase(),
  isIndexDatabaseInitialized: () => mocks.isIndexDatabaseInitialized()
}))
vi.mock('../../database/queries/notes', () => ({
  getAllCrdtNoteIds: () => mocks.getAllCrdtNoteIds()
}))
vi.mock('../packs/pack-bootstrap', () => ({
  runPackBootstrap: (...args: unknown[]) => mocks.runPackBootstrap(...args)
}))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/memry-test-userdata' } }))
vi.mock('../bulk-apply', () => ({ beginPageApply: vi.fn() }))

const okResult = {
  usedPacks: true,
  packsApplied: 1,
  entriesApplied: 3,
  entriesSkipped: 0,
  entriesFailed: 0,
  appliedThroughCursor: 200
}

interface Harness {
  runner: FullSyncRunner
  order: string[]
  setStateValue: ReturnType<typeof vi.fn>
}

const createHarness = (options: { lastCursor?: string; storeId?: string | null } = {}): Harness => {
  const order: string[] = []
  const setStateValue = vi.fn()
  const provider =
    options.storeId === null
      ? undefined
      : {
          storeId: options.storeId ?? 'store-1',
          getSnapshotWatermark: vi.fn(async () => null),
          putSnapshotWatermark: vi.fn(async () => {}),
          applyRemoteUpdate: vi.fn(),
          getOpenNoteIds: vi.fn(() => []),
          inactiveDocCapacity: 32
        }

  const ctx = {
    deps: {
      db: {
        select: () => ({ from: () => ({ all: () => [] as Array<{ key: string }> }) })
      },
      queue: { getPendingCount: vi.fn(() => 0), purgeOldErrors: vi.fn() },
      network: { online: true },
      ws: { connected: true, connectionGeneration: 1 },
      getAccessToken: vi.fn(async () => 'token'),
      getVaultKey: vi.fn(async () => new Uint8Array(32)),
      getSigningKeys: vi.fn(async () => null),
      emitToRenderer: vi.fn(),
      ...(provider ? { crdtProvider: provider } : {})
    },
    fullSyncActive: false
  } as unknown as SyncContext

  const stateManager = {
    getStateValue: vi.fn((key: string) =>
      key === SYNC_STATE_KEYS.LAST_CURSOR ? options.lastCursor : undefined
    ),
    setStateValue,
    isPaused: vi.fn(() => false),
    recordHistory: vi.fn(),
    updateLastSyncAt: vi.fn()
  } as unknown as SyncStateManager

  const actions: FullSyncActions = {
    pull: vi.fn(async () => {
      order.push('pull')
    }),
    push: vi.fn(async () => {
      order.push('push')
    }),
    scheduleSync: vi.fn()
  }

  const runner = new FullSyncRunner(
    ctx,
    stateManager,
    {
      clearPendingAfterFullSync: vi.fn(),
      suppressPushDuringPull: false
    } as unknown as PushCoordinator,
    {
      addPendingPull: vi.fn(),
      drainPendingPulls: vi.fn(() => []),
      pendingPullCount: 0,
      hasUnmergedNotes: false
    } as unknown as CrdtSyncCoordinator,
    actions
  )

  return { runner, order, setStateValue }
}

describe('FullSyncRunner pack bootstrap seam', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isIndexDatabaseInitialized.mockReturnValue(false)
    mocks.checkManifestIntegrity.mockResolvedValue({
      performed: false,
      checkedAt: 0,
      rePullNeeded: false,
      serverOnlyCount: 0
    })
    mocks.runPackBootstrap.mockImplementation(async () => {
      return okResult
    })
  })

  it('#given a fresh device #then packs are applied before the item-granular pull', async () => {
    const harness = createHarness()
    mocks.runPackBootstrap.mockImplementation(async () => {
      harness.order.push('packs')
      return okResult
    })

    await harness.runner.run()

    expect(harness.order.slice(0, 2)).toEqual(['packs', 'pull'])
  })

  it('#given a device with a persisted cursor #then packs are never asked for', async () => {
    const harness = createHarness({ lastCursor: '4200' })

    await harness.runner.run()

    expect(mocks.runPackBootstrap).not.toHaveBeenCalled()
    expect(harness.order[0]).toBe('pull')
  })

  it('#given no CRDT store #then packs are skipped (nothing to seed)', async () => {
    const harness = createHarness({ storeId: null })

    await harness.runner.run()

    expect(mocks.runPackBootstrap).not.toHaveBeenCalled()
    expect(harness.order[0]).toBe('pull')
  })

  it('#given pack bootstrap throws #then the pull still runs and the cursor is untouched', async () => {
    const harness = createHarness()
    mocks.runPackBootstrap.mockRejectedValue(new Error('pack list exploded'))

    await expect(harness.runner.run()).resolves.toBeUndefined()

    expect(harness.order).toContain('pull')
    expect(
      harness.setStateValue.mock.calls.filter(([key]) => key === SYNC_STATE_KEYS.LAST_CURSOR)
    ).toEqual([])
  })

  it('#given packs are unusable #then the run is byte-for-byte the pre-pack path', async () => {
    const withPacks = createHarness()
    mocks.runPackBootstrap.mockResolvedValue({
      usedPacks: false,
      packsApplied: 0,
      entriesApplied: 0,
      entriesSkipped: 0,
      entriesFailed: 0,
      appliedThroughCursor: null
    })
    await withPacks.runner.run()

    const withoutPacks = createHarness({ storeId: null })
    await withoutPacks.runner.run()

    expect(withPacks.order).toEqual(withoutPacks.order)
    expect(withPacks.setStateValue.mock.calls).toEqual(withoutPacks.setStateValue.mock.calls)
  })
})
