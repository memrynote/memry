import sodium, {
  ready as sodiumReady,
  to_base64 as sodiumToBase64,
  base64_variants as sodiumBase64Variants
} from 'libsodium-wrappers-sumo'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PackSummary } from '@memry/contracts/sync-api'

import { encryptCrdtUpdate } from '../crdt-encrypt'
import type { DocumentPlan } from '../packs/body-plan'
import type * as PackBootstrapModule from '../packs/pack-bootstrap'
import type { PackBootstrapDeps } from '../packs/pack-bootstrap'
import { buildTestPack } from '../packs/test-pack-builder'
import { downloadPacks } from '../packs/pack-downloads'
import { FullSyncRunner, type FullSyncActions } from './full-sync-runner'
import { SYNC_STATE_KEYS, type SyncContext } from './sync-context'
import type { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import type { PushCoordinator } from './push-coordinator'
import type { SyncStateManager } from './sync-state-manager'
import { DELIVERED } from './sync-run-outcome'

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
  updatesApplied: 0,
  appliedThroughCursor: 200
}

type ProviderMock = {
  storeId: string | null
  getSnapshotWatermark: ReturnType<typeof vi.fn>
  putSnapshotWatermark: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  applyRemoteUpdate: ReturnType<typeof vi.fn>
  getDoc: ReturnType<typeof vi.fn>
  getStateVector: ReturnType<typeof vi.fn>
  closeIfInactive: ReturnType<typeof vi.fn>
  getOpenNoteIds: ReturnType<typeof vi.fn>
  inactiveDocCapacity: number
}

const snapshotPlan = (bytes: Uint8Array): DocumentPlan => ({
  snapshot: {
    entry: {
      kind: 'crdt_snapshot',
      id: 'note-1',
      sourceKey: '',
      sortKey: 0,
      offset: 0,
      length: 0,
      sha256: new Uint8Array(32)
    },
    meta: { sequenceNum: 4, revision: 'r4' },
    read: async () => bytes
  },
  updates: [],
  watermark: { appliedSequence: 4, snapshotRevision: 'r4' }
})

interface Harness {
  runner: FullSyncRunner
  order: string[]
  setStateValue: ReturnType<typeof vi.fn>
  provider: ProviderMock | undefined
  deviceKeys: string[]
  stateManager: SyncStateManager
  actions: FullSyncActions
}

const createHarness = (
  options: { lastCursor?: string; storeId?: string | null; omitProvider?: boolean } = {}
): Harness => {
  const order: string[] = []
  const state = new Map<string, string>(
    options.lastCursor === undefined ? [] : [[SYNC_STATE_KEYS.LAST_CURSOR, options.lastCursor]]
  )
  const setStateValue = vi.fn((key: string, value: string) => state.set(key, value))
  const deviceKeys: string[] = []
  const provider: ProviderMock | undefined = options.omitProvider
    ? undefined
    : {
        storeId: options.storeId === undefined ? 'store-1' : options.storeId,
        getSnapshotWatermark: vi.fn(async () => null),
        putSnapshotWatermark: vi.fn(async () => {}),
        open: vi.fn(async () => ({})),
        applyRemoteUpdate: vi.fn(() => true),
        getDoc: vi.fn(() => undefined),
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
        select: () => ({
          from: () => ({
            all: () => deviceKeys.map((key, i) => ({ deviceId: `device-${i}`, key })),
            // The pack-seed settle markers (pack-seeded-docs.ts): none listed.
            where: () => ({ all: () => [] })
          })
        })
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
    applier: { changedCount: 0 },
    acquireLock: vi.fn(async () => ({ release: () => {} })),
    releaseLock: vi.fn(),
    fullSyncActive: false
  } as unknown as SyncContext

  const stateManager = {
    getStateValue: vi.fn((key: string) => state.get(key)),
    setStateValue,
    deleteStateValue: vi.fn((key: string) => state.delete(key)),
    isPaused: vi.fn(() => false),
    recordHistory: vi.fn(),
    updateLastSyncAt: vi.fn()
  } as unknown as SyncStateManager

  const actions: FullSyncActions = {
    pull: vi.fn(async () => {
      order.push('pull')
      return DELIVERED
    }),
    push: vi.fn(async () => {
      order.push('push')
      return DELIVERED
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
      nextDeferredPullAt: vi.fn(() => null)
    } as unknown as CrdtSyncCoordinator,
    actions
  )

  return { runner, order, setStateValue, provider, deviceKeys, stateManager, actions }
}

describe('FullSyncRunner pack bootstrap seam', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isIndexDatabaseInitialized.mockReturnValue(false)
    mocks.checkManifestIntegrity.mockResolvedValue({
      performed: false,
      checkedAt: 0,
      serverOnly: []
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

    await expect(harness.runner.run()).resolves.toEqual(DELIVERED)

    expect(harness.order).toContain('pull')
    expect(
      harness.setStateValue.mock.calls.filter(([key]) => key === SYNC_STATE_KEYS.LAST_CURSOR)
    ).toEqual([])
  })

  it.each(['stop', 'vault switch'] as const)(
    '#given a %s during a pack pause #then the phase returns at once and nothing downloads after it',
    async (ending) => {
      const harness = createHarness()
      const fetched: string[] = []
      let applied = false
      let paused!: () => void
      const pausing = new Promise<void>((resolve) => (paused = resolve))
      // The real phase-wide pause (production timer), cut short only by the signal.
      mocks.runPackBootstrap.mockImplementation(async (deps: PackBootstrapDeps) => {
        const packs = ['p-1', 'p-2'].map((id) => ({ id }) as PackSummary)
        await downloadPacks(packs, {
          parallel: 1,
          fetchOne: async (pack) => {
            fetched.push(pack.id)
            paused()
            return { lostMs: 0 }
          },
          onPause: () => {},
          ...(deps.signal ? { signal: deps.signal } : {})
        })
        if (!deps.signal?.aborted) applied = true
        return okResult
      })

      const running = harness.runner.run()
      await pausing
      if (ending === 'stop') harness.runner.abortPackPhase('stop')
      else harness.runner.dispose()
      await running

      expect(fetched).toEqual(['p-1'])
      expect(applied).toBe(false)
    }
  )

  it.each(['stop or cancel', 'pause', 'vault switch'] as const)(
    '#given a %s while the bootstrap session opens #then neither the pack phase nor the pull starts',
    async (ending) => {
      const harness = createHarness()
      let sessionOpened!: () => void
      const opening = new Promise<void>((resolve) => (sessionOpened = resolve))
      let finishOpen!: () => void
      // openBootstrapSession is a network call: the ending lands while it is awaited.
      mocks.openBootstrapSession.mockImplementationOnce(() => {
        sessionOpened()
        return new Promise<string>((resolve) => (finishOpen = () => resolve('open')))
      })

      const running = harness.runner.run()
      await opening
      if (ending === 'stop or cancel') harness.runner.abortPackPhase('stop')
      else if (ending === 'pause') vi.mocked(harness.stateManager.isPaused).mockReturnValue(true)
      else harness.runner.dispose()
      finishOpen()
      const outcome = await running

      expect(mocks.runPackBootstrap).not.toHaveBeenCalled()
      expect(harness.actions.pull).not.toHaveBeenCalled()
      expect(outcome).toEqual({
        status: 'skipped',
        reason: ending === 'pause' ? 'paused' : 'cancelled'
      })
    }
  )

  it('#given a pause that ended while the bootstrap session opened #then the run still pulls', async () => {
    // pause() aborts the pack phase; resume()'s sync is dropped while this run
    // holds fullSyncActive, so this run is the one that must pull.
    const harness = createHarness()
    let sessionOpened!: () => void
    const opening = new Promise<void>((resolve) => (sessionOpened = resolve))
    let finishOpen!: () => void
    mocks.openBootstrapSession.mockImplementationOnce(() => {
      sessionOpened()
      return new Promise<string>((resolve) => (finishOpen = () => resolve('open')))
    })

    const running = harness.runner.run()
    await opening
    harness.runner.abortPackPhase('pause')
    finishOpen()
    await running

    expect(harness.actions.pull).toHaveBeenCalledTimes(1)
  })

  describe('the seed store handed to the pack runner', () => {
    let vaultKey: Uint8Array
    let peer: { publicKey: Uint8Array; privateKey: Uint8Array }

    beforeAll(async () => {
      await sodiumReady
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
      harness.deviceKeys.push(sodiumToBase64(peer.publicKey, sodiumBase64Variants.ORIGINAL))
      const deps = await capture(harness)

      const packed = encryptCrdtUpdate(
        new TextEncoder().encode('a yjs update'),
        vaultKey,
        'note-1',
        peer.privateKey
      )
      await expect(deps.bodies.applyDocument('note-1', snapshotPlan(packed))).resolves.toEqual({
        appliedSequence: 4,
        snapshotRevision: 'r4'
      })

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
      harness.deviceKeys.push(sodiumToBase64(own.publicKey, sodiumBase64Variants.ORIGINAL))
      mocks.fetchAndCacheDeviceKeys.mockImplementation(async () => {
        harness.deviceKeys.push(sodiumToBase64(peer.publicKey, sodiumBase64Variants.ORIGINAL))
      })
      const deps = await capture(harness)

      const packed = encryptCrdtUpdate(
        new TextEncoder().encode('a yjs update'),
        vaultKey,
        'note-1',
        peer.privateKey
      )

      await expect(deps.bodies.applyDocument('note-1', snapshotPlan(packed))).resolves.toEqual({
        appliedSequence: 4,
        snapshotRevision: 'r4'
      })
      expect(mocks.fetchAndCacheDeviceKeys).toHaveBeenCalled()
    })

    it('#given the key refresh fails #then the cached keys are still tried', async () => {
      const harness = createHarness()
      harness.deviceKeys.push(sodiumToBase64(peer.publicKey, sodiumBase64Variants.ORIGINAL))
      mocks.fetchAndCacheDeviceKeys.mockRejectedValue(new Error('offline'))
      const deps = await capture(harness)

      const packed = encryptCrdtUpdate(
        new TextEncoder().encode('a yjs update'),
        vaultKey,
        'note-1',
        peer.privateKey
      )

      await expect(deps.bodies.applyDocument('note-1', snapshotPlan(packed))).resolves.toEqual({
        appliedSequence: 4,
        snapshotRevision: 'r4'
      })
    })
  })

  it('#given a pause and resume during the pack phase #then the pull gets every record and re-requests only unapplied bodies', async () => {
    // VERIFY-5450 #7. pause() aborts the pack phase (engine.ts); resume()'s
    // sync is dropped while this run holds fullSyncActive, so this run pulls,
    // with whatever the aborted phase handed back. The real pack runner and
    // body applier run here; only the network is scripted.
    await sodiumReady
    const vaultKey = new Uint8Array(32)
    const peer = sodium.crypto_sign_keypair('uint8array')
    const harness = createHarness()
    harness.deviceKeys.push(sodiumToBase64(peer.publicKey, sodiumBase64Variants.ORIGINAL))
    const notes = ['note-1', 'note-2', 'note-3', 'note-4']
    const snapshots = buildTestPack(
      notes.map((id) => ({
        id,
        bytes: encryptCrdtUpdate(new TextEncoder().encode(id), vaultKey, id, peer.privateKey),
        meta: { sequenceNum: 4, revision: `r-${id}` }
      }))
    ).bytes
    const blob = { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' }
    const records = buildTestPack(
      notes.map((id, index) => ({
        kind: 'record' as const,
        id: `note:${id}`,
        sortKey: 10 + index,
        meta: { operation: 'update', signature: 'sig', signerDeviceId: 'device-0' },
        bytes: new TextEncoder().encode(JSON.stringify(blob))
      }))
    ).bytes
    const files = new Map([
      ['p-snap', snapshots],
      ['p-rec', records]
    ])
    const summary = (id: string, itemKind: PackSummary['itemKind'], extra = {}): PackSummary => ({
      id,
      itemKind,
      packKey: `packs/${id}`,
      minCursor: 1,
      maxCursor: 100,
      itemCount: 4,
      byteSize: 128,
      createdAt: 1_700_000_000,
      url: `https://r2.example/${id}`,
      expiresAt: 1_800_000_000,
      ...extra
    })
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memry-pack-pause-'))
    const { runPackBootstrap } =
      await vi.importActual<typeof PackBootstrapModule>('../packs/pack-bootstrap')
    mocks.runPackBootstrap.mockImplementation(async (deps: PackBootstrapDeps) => {
      const result = await runPackBootstrap({
        ...deps,
        tempDir,
        now: () => 1_700_000_100_000,
        pageEntries: 2,
        maxParallelDownloads: 1,
        recordBytes: () => {},
        fetchPackPage: async () => ({
          packs: [
            summary('p-snap', 'crdt_snapshot'),
            summary('p-rec', 'record', { coverFrom: 0, coverThrough: 100 })
          ],
          coverage: [{ itemKind: 'record', packedThrough: 100, coveredThrough: 100 }],
          serverTime: 1_700_000_100
        }),
        download: async ({ url, destPath }) => {
          const bytes = files.get(url.split('/').pop()!)!
          await fs.mkdir(path.dirname(destPath), { recursive: true })
          await fs.writeFile(destPath, bytes)
          return { bytes: bytes.length, resumed: false }
        },
        readManifest: async () =>
          new Map(
            notes.map((noteId) => [
              noteId,
              {
                noteId,
                floor: 0,
                maxSequenceNum: 4,
                snapshot: { revision: `r-${noteId}`, sequenceNum: 4 }
              }
            ])
          ),
        readRecordManifest: async () => ({
          items: notes.map((id, index) => ({
            id,
            type: 'note',
            version: 1,
            modifiedAt: 1,
            size: 1,
            serverCursor: 10 + index
          })),
          complete: true
        }),
        beginPage: () => ({
          db: {} as never,
          transacted: true,
          afterCommit: () => {},
          commit: () => {},
          rollback: () => {},
          flushFiles: async () => {},
          savepoint: (apply) => apply(),
          flushFilesSync: () => {}
        }),
        // The pause lands once the first page of two documents committed.
        emit: (_channel, data) => {
          if ((data as { processedItems: number }).processedItems >= 2) {
            vi.mocked(harness.stateManager.isPaused).mockReturnValue(true)
            harness.runner.abortPackPhase('pause')
          }
        }
      })
      // And the resume, before the run reads the pause again.
      vi.mocked(harness.stateManager.isPaused).mockReturnValue(false)
      return result
    })

    try {
      await expect(harness.runner.run()).resolves.toEqual(DELIVERED)
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true })
    }

    expect(harness.provider!.putSnapshotWatermark.mock.calls.map(([id]) => id)).toEqual([
      'note-1',
      'note-2'
    ])
    expect(harness.actions.pull).toHaveBeenCalledTimes(1)
    const packed = vi.mocked(harness.actions.pull).mock.calls[0][1]
    // No item lost: every packed record reaches the pull, and the bodies the
    // pause cut off stay owed to their item routes.
    expect(packed?.apply.map(({ item }) => item.id)).toEqual(notes)
    expect(packed?.pullById).toEqual([])
    // Nothing applied is asked for again.
    expect([...(packed?.settledBodies ?? [])]).toEqual(['note-1', 'note-2'])
  })

  it('#given packs are unusable #then the run is byte-for-byte the pre-pack path', async () => {
    const withPacks = createHarness()
    mocks.runPackBootstrap.mockResolvedValue({
      usedPacks: false,
      packsApplied: 0,
      entriesApplied: 0,
      entriesSkipped: 0,
      entriesFailed: 0,
      updatesApplied: 0,
      appliedThroughCursor: null
    })
    await withPacks.runner.run()

    const withoutPacks = createHarness({ omitProvider: true })
    await withoutPacks.runner.run()

    expect(withPacks.order).toEqual(withoutPacks.order)
    expect(withPacks.setStateValue.mock.calls).toEqual(withoutPacks.setStateValue.mock.calls)
  })
})
