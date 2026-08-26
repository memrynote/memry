import sodium from 'libsodium-wrappers-sumo'

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { encryptCrdtUpdate } from '../crdt-encrypt'
import type { PackBootstrapDeps } from '../packs/pack-bootstrap'
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
  getAllCrdtNoteIds: vi.fn(() => []),
  fetchAndCacheDeviceKeys: vi.fn()
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
vi.mock('../device-keys', () => ({
  fetchAndCacheDeviceKeys: (...args: unknown[]) => mocks.fetchAndCacheDeviceKeys(...args)
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

type ProviderMock = {
  storeId: string | null
  getSnapshotWatermark: ReturnType<typeof vi.fn>
  putSnapshotWatermark: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  applyRemoteUpdate: ReturnType<typeof vi.fn>
  getStateVector: ReturnType<typeof vi.fn>
  closeIfInactive: ReturnType<typeof vi.fn>
  getOpenNoteIds: ReturnType<typeof vi.fn>
  inactiveDocCapacity: number
}

interface Harness {
  runner: FullSyncRunner
  order: string[]
  setStateValue: ReturnType<typeof vi.fn>
  provider: ProviderMock | undefined
  deviceKeys: string[]
}

const createHarness = (
  options: { lastCursor?: string; storeId?: string | null; omitProvider?: boolean } = {}
): Harness => {
  const order: string[] = []
  const setStateValue = vi.fn()
  const deviceKeys: string[] = []
  const provider: ProviderMock | undefined = options.omitProvider
    ? undefined
    : {
        storeId: options.storeId === undefined ? 'store-1' : options.storeId,
        getSnapshotWatermark: vi.fn(async () => null),
        putSnapshotWatermark: vi.fn(async () => {}),
        open: vi.fn(async () => ({})),
        applyRemoteUpdate: vi.fn(),
        // Non-empty: the applier refuses to record a watermark for a doc that
        // is still empty after the seed.
        getStateVector: vi.fn(() => new Uint8Array([1, 220, 148, 3, 1])),
        closeIfInactive: vi.fn(async () => true),
        getOpenNoteIds: vi.fn(() => []),
        inactiveDocCapacity: 32
      }

  const ctx = {
    deps: {
      db: {
        select: () => ({ from: () => ({ all: () => deviceKeys.map((key) => ({ key })) }) })
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
      return true
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

  return { runner, order, setStateValue, provider, deviceKeys }
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

  it('#given no crdt provider at all #then packs are skipped', async () => {
    const harness = createHarness({ omitProvider: true })

    await harness.runner.run()

    expect(mocks.runPackBootstrap).not.toHaveBeenCalled()
    expect(harness.order[0]).toBe('pull')
  })

  it('#given a provider with no store #then packs are skipped (nothing to seed)', async () => {
    // An in-memory provider: it holds docs but persists no watermark, so a
    // packed baseline it "applied" would be forgotten and re-fetched anyway.
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

  describe('the seed store handed to the pack runner', () => {
    let vaultKey: Uint8Array
    let peer: { publicKey: Uint8Array; privateKey: Uint8Array }

    beforeAll(async () => {
      await sodium.ready
      vaultKey = new Uint8Array(32)
      peer = sodium.crypto_sign_keypair('uint8array')
    })

    const capture = async (harness: Harness): Promise<PackBootstrapDeps> => {
      let captured: PackBootstrapDeps | null = null
      mocks.runPackBootstrap.mockImplementation(async (deps: PackBootstrapDeps) => {
        captured = deps
        return okResult
      })
      await harness.runner.run()
      if (!captured) throw new Error('pack bootstrap was never invoked')
      return captured
    }

    it('opens the doc without a markdown seed, and releases it after', async () => {
      const harness = createHarness()
      harness.deviceKeys.push(sodium.to_base64(peer.publicKey, sodium.base64_variants.ORIGINAL))
      const deps = await capture(harness)

      const packed = encryptCrdtUpdate(
        new TextEncoder().encode('a yjs update'),
        vaultKey,
        'note-1',
        peer.privateKey
      )
      await expect(
        deps.snapshots.apply('note-1', packed, { sequenceNum: 4, revision: 'r4' })
      ).resolves.toBe(true)

      // `applyRemoteUpdate` routes through the provider's live doc map and
      // DROPS anything for a doc it is not holding, so the open is what makes
      // pack seeding real. `skipSeed` because seeding from local markdown
      // first would give the doc a client id the packed baseline never saw.
      expect(harness.provider!.open).toHaveBeenCalledWith('note-1', undefined, { skipSeed: true })
      expect(harness.provider!.applyRemoteUpdate).toHaveBeenCalled()
      expect(harness.provider!.open.mock.invocationCallOrder[0]).toBeLessThan(
        harness.provider!.applyRemoteUpdate.mock.invocationCallOrder[0]
      )
      // Released again: hundreds of packed notes must not pin hundreds of docs.
      expect(harness.provider!.closeIfInactive).toHaveBeenCalledWith('note-1')
      expect(harness.provider!.putSnapshotWatermark).toHaveBeenCalledWith('note-1', {
        appliedSequence: 4,
        snapshotRevision: 'r4'
      })
    })

    it('#given only this device in the key cache #then peer keys are fetched first', async () => {
      // The only devices pack bootstrap runs on are fresh ones, where
      // `sync_devices` holds this device's own row and nothing else — peer rows
      // arrive through the device-key cache, filled by the item-granular pull
      // that runs after this. Every packed snapshot is peer-signed.
      const harness = createHarness()
      const own = sodium.crypto_sign_keypair('uint8array')
      harness.deviceKeys.push(sodium.to_base64(own.publicKey, sodium.base64_variants.ORIGINAL))
      mocks.fetchAndCacheDeviceKeys.mockImplementation(async () => {
        harness.deviceKeys.push(sodium.to_base64(peer.publicKey, sodium.base64_variants.ORIGINAL))
      })
      const deps = await capture(harness)

      const packed = encryptCrdtUpdate(
        new TextEncoder().encode('a yjs update'),
        vaultKey,
        'note-1',
        peer.privateKey
      )

      await expect(
        deps.snapshots.apply('note-1', packed, { sequenceNum: 4, revision: 'r4' })
      ).resolves.toBe(true)
      expect(mocks.fetchAndCacheDeviceKeys).toHaveBeenCalled()
    })

    it('#given the key refresh fails #then the cached keys are still tried', async () => {
      const harness = createHarness()
      harness.deviceKeys.push(sodium.to_base64(peer.publicKey, sodium.base64_variants.ORIGINAL))
      mocks.fetchAndCacheDeviceKeys.mockRejectedValue(new Error('offline'))
      const deps = await capture(harness)

      const packed = encryptCrdtUpdate(
        new TextEncoder().encode('a yjs update'),
        vaultKey,
        'note-1',
        peer.privateKey
      )

      await expect(
        deps.snapshots.apply('note-1', packed, { sequenceNum: 4, revision: 'r4' })
      ).resolves.toBe(true)
    })
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

    const withoutPacks = createHarness({ omitProvider: true })
    await withoutPacks.runner.run()

    expect(withPacks.order).toEqual(withoutPacks.order)
    expect(withPacks.setStateValue.mock.calls).toEqual(withoutPacks.setStateValue.mock.calls)
  })
})
