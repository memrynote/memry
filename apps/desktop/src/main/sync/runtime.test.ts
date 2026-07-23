import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtimeMocks = vi.hoisted(() => {
  class SyncServerError extends Error {
    statusCode: number
    constructor(statusCode: number, message = 'sync server error') {
      super(message)
      this.statusCode = statusCode
    }
  }

  class SyncQueueManager {
    static instances: SyncQueueManager[] = []
    onItemEnqueued: (() => void) | null = null
    constructor(public db: unknown) {
      SyncQueueManager.instances.push(this)
    }
    setOnItemEnqueued = vi.fn((cb: () => void) => {
      this.onItemEnqueued = cb
    })
  }

  class CrdtUpdateQueue {
    static instances: CrdtUpdateQueue[] = []
    onBatch: ((noteId: string, updates: Uint8Array[]) => Promise<void>) | null = null
    start = vi.fn((cb: (noteId: string, updates: Uint8Array[]) => Promise<void>) => {
      this.onBatch = cb
    })
    pause = vi.fn()
    resume = vi.fn()
    stop = vi.fn()
    constructor() {
      CrdtUpdateQueue.instances.push(this)
    }
  }

  class NetworkMonitor {
    static instances: NetworkMonitor[] = []
    online = true
    listeners = new Map<string, (event: { online: boolean }) => void>()
    start = vi.fn()
    stop = vi.fn()
    on = vi.fn((event: string, cb: (payload: { online: boolean }) => void) => {
      this.listeners.set(event, cb)
    })
    constructor() {
      NetworkMonitor.instances.push(this)
      this.online = runtimeMocks.networkOnline
    }
  }

  class WebSocketManager {
    static instances: WebSocketManager[] = []
    disconnect = vi.fn()
    refreshAuth = vi.fn(async () => undefined)
    constructor(public options: unknown) {
      WebSocketManager.instances.push(this)
    }
  }

  class SyncEngine {
    static instances: SyncEngine[] = []
    start = vi.fn(async () => {
      if (runtimeMocks.engineStartError) throw runtimeMocks.engineStartError
    })
    stop = vi.fn(async () => undefined)
    requestPush = vi.fn()
    constructor(public deps: Record<string, unknown>) {
      SyncEngine.instances.push(this)
    }
  }

  class SyncWorkerBridge {
    static instances: SyncWorkerBridge[] = []
    start = vi.fn(async () => {
      if (runtimeMocks.workerStartError) throw runtimeMocks.workerStartError
    })
    stop = vi.fn(async () => undefined)
    constructor() {
      SyncWorkerBridge.instances.push(this)
    }
  }

  const service = (name: string) => ({
    init: vi.fn(() => ({ name })),
    reset: vi.fn()
  })

  return {
    SyncServerError,
    SyncQueueManager,
    CrdtUpdateQueue,
    NetworkMonitor,
    WebSocketManager,
    SyncEngine,
    SyncWorkerBridge,
    taskSync: service('task'),
    inboxSync: service('inbox'),
    filterSync: service('filter'),
    projectSync: service('project'),
    settingsSync: service('settings'),
    noteSync: service('note'),
    journalSync: service('journal'),
    tagDefinitionSync: service('tag_definition'),
    tagCategorySync: service('tag_category'),
    folderConfigSync: service('folder_config'),
    calendarEventSync: service('calendar_event'),
    calendarSourceSync: service('calendar_source'),
    calendarBindingSync: service('calendar_binding'),
    calendarExternalEventSync: service('calendar_external_event'),
    networkOnline: true,
    engineStartError: null as Error | null,
    workerStartError: null as Error | null,
    db: null as any,
    indexRows: [] as Array<{ id: string; title: string; date: string | null }>,
    currentDevice: { id: 'device-1', signingPublicKey: null as string | null },
    getDatabase: vi.fn(),
    getIndexDatabase: vi.fn(),
    retrieveToken: vi.fn(),
    getValidAccessToken: vi.fn(),
    refreshAccessToken: vi.fn(),
    retrieveKey: vi.fn(),
    storeGet: vi.fn(),
    getOrInitializeLocalVaultKey: vi.fn(),
    getOrCreateVaultUuid: vi.fn(() => 'vault-1'),
    deriveDevicePublicKey: vi.fn(),
    secureCleanup: vi.fn(),
    encryptCrdtUpdate: vi.fn(),
    postToServer: vi.fn(),
    pushCrdtSnapshot: vi.fn(),
    withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
    emitSessionExpired: vi.fn(),
    setOnTokenRefreshed: vi.fn(),
    trackMainEvent: vi.fn(),
    logDebug: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
    recoverDirtyItems: vi.fn(),
    createSyncAdapterRegistry: vi.fn((adapters: unknown[]) => adapters),
    createCrdtSyncAdapter: vi.fn((type: string, options: unknown) => ({ type, options })),
    getRemoteSyncAdapter: vi.fn((type: string) => ({ remote: type })),
    getDeviceSigningKey: vi.fn(),
    resetCrdtProvider: vi.fn(),
    syncGoogleCalendarSource: vi.fn(),
    crdtProvider: {
      init: vi.fn(),
      seedExistingDocs: vi.fn(),
      pushSnapshotForNote: vi.fn(),
      pushAllSnapshots: vi.fn(),
      destroy: vi.fn()
    },
    browserSend: vi.fn(),
    sodiumToBase64: vi.fn(() => 'derived-public-key'),
    resolveEntitlementForSyncStart: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.2.3') },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { send: runtimeMocks.browserSend } }])
  }
}))

vi.mock('libsodium-wrappers-sumo', () => ({
  default: {
    to_base64: runtimeMocks.sodiumToBase64,
    base64_variants: { ORIGINAL: 'original' }
  }
}))

vi.mock('@memry/sync-core', () => ({
  createCrdtSyncAdapter: runtimeMocks.createCrdtSyncAdapter,
  createSyncAdapterRegistry: runtimeMocks.createSyncAdapterRegistry
}))

vi.mock('../database', () => ({
  getDatabase: runtimeMocks.getDatabase
}))

vi.mock('../database/client', () => ({
  getIndexDatabase: runtimeMocks.getIndexDatabase
}))

vi.mock('../crypto', () => ({
  getDevicePublicKey: runtimeMocks.deriveDevicePublicKey,
  getOrInitializeLocalVaultKey: runtimeMocks.getOrInitializeLocalVaultKey,
  retrieveKey: runtimeMocks.retrieveKey,
  secureCleanup: runtimeMocks.secureCleanup
}))

vi.mock('../store', () => ({
  store: {
    get: runtimeMocks.storeGet
  }
}))

vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: runtimeMocks.getOrCreateVaultUuid
}))

vi.mock('../calendar/google/sync-service', () => ({
  syncGoogleCalendarSource: runtimeMocks.syncGoogleCalendarSource
}))

vi.mock('../telemetry/track', () => ({
  trackMainEvent: runtimeMocks.trackMainEvent
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: (...args: unknown[]) => runtimeMocks.logDebug(...args),
    info: (...args: unknown[]) => runtimeMocks.logInfo(...args),
    warn: (...args: unknown[]) => runtimeMocks.logWarn(...args),
    error: (...args: unknown[]) => runtimeMocks.logError(...args)
  })
}))

vi.mock('./queue', () => ({ SyncQueueManager: runtimeMocks.SyncQueueManager }))
vi.mock('./network', () => ({ NetworkMonitor: runtimeMocks.NetworkMonitor }))
vi.mock('./websocket', () => ({ WebSocketManager: runtimeMocks.WebSocketManager }))
vi.mock('./engine', () => ({ SyncEngine: runtimeMocks.SyncEngine }))
vi.mock('./worker-bridge', () => ({ SyncWorkerBridge: runtimeMocks.SyncWorkerBridge }))
vi.mock('./crdt-queue', () => ({ CrdtUpdateQueue: runtimeMocks.CrdtUpdateQueue }))

vi.mock('./task-sync', () => ({
  initTaskSyncService: runtimeMocks.taskSync.init,
  resetTaskSyncService: runtimeMocks.taskSync.reset
}))
vi.mock('./inbox-sync', () => ({
  initInboxSyncService: runtimeMocks.inboxSync.init,
  resetInboxSyncService: runtimeMocks.inboxSync.reset
}))
vi.mock('./filter-sync', () => ({
  initFilterSyncService: runtimeMocks.filterSync.init,
  resetFilterSyncService: runtimeMocks.filterSync.reset
}))
vi.mock('./canvas-sync', () => ({
  initCanvasSyncService: vi.fn(() => ({})),
  resetCanvasSyncService: vi.fn(),
  getCanvasSyncService: vi.fn(() => null)
}))
vi.mock('./project-sync', () => ({
  initProjectSyncService: runtimeMocks.projectSync.init,
  resetProjectSyncService: runtimeMocks.projectSync.reset
}))
vi.mock('./settings-sync', () => ({
  initSettingsSyncManager: runtimeMocks.settingsSync.init,
  resetSettingsSyncManager: runtimeMocks.settingsSync.reset
}))
vi.mock('./note-sync', () => ({
  initNoteSyncService: runtimeMocks.noteSync.init,
  resetNoteSyncService: runtimeMocks.noteSync.reset
}))
vi.mock('./journal-sync', () => ({
  initJournalSyncService: runtimeMocks.journalSync.init,
  resetJournalSyncService: runtimeMocks.journalSync.reset
}))
vi.mock('./tag-definition-sync', () => ({
  initTagDefinitionSyncService: runtimeMocks.tagDefinitionSync.init,
  resetTagDefinitionSyncService: runtimeMocks.tagDefinitionSync.reset
}))
vi.mock('./tag-category-sync', () => ({
  initTagCategorySyncService: runtimeMocks.tagCategorySync.init,
  resetTagCategorySyncService: runtimeMocks.tagCategorySync.reset
}))
vi.mock('./folder-config-sync', () => ({
  initFolderConfigSyncService: runtimeMocks.folderConfigSync.init,
  resetFolderConfigSyncService: runtimeMocks.folderConfigSync.reset
}))
vi.mock('./calendar-event-sync', () => ({
  initCalendarEventSyncService: runtimeMocks.calendarEventSync.init,
  resetCalendarEventSyncService: runtimeMocks.calendarEventSync.reset
}))
vi.mock('./calendar-source-sync', () => ({
  initCalendarSourceSyncService: runtimeMocks.calendarSourceSync.init,
  resetCalendarSourceSyncService: runtimeMocks.calendarSourceSync.reset
}))
vi.mock('./calendar-binding-sync', () => ({
  initCalendarBindingSyncService: runtimeMocks.calendarBindingSync.init,
  resetCalendarBindingSyncService: runtimeMocks.calendarBindingSync.reset
}))
vi.mock('./calendar-external-event-sync', () => ({
  initCalendarExternalEventSyncService: runtimeMocks.calendarExternalEventSync.init,
  resetCalendarExternalEventSyncService: runtimeMocks.calendarExternalEventSync.reset
}))

vi.mock('./item-handlers', () => ({
  getRemoteSyncAdapter: runtimeMocks.getRemoteSyncAdapter
}))

vi.mock('./device-keys', () => ({
  getDeviceSigningKey: runtimeMocks.getDeviceSigningKey
}))

vi.mock('./crdt-provider', () => ({
  getCrdtProvider: vi.fn(() => runtimeMocks.crdtProvider),
  resetCrdtProvider: runtimeMocks.resetCrdtProvider
}))

vi.mock('./dirty-recovery', () => ({
  recoverDirtyItems: runtimeMocks.recoverDirtyItems
}))

vi.mock('../billing/paddle-billing', () => ({
  resolveEntitlementForSyncStart: (...args: unknown[]) =>
    runtimeMocks.resolveEntitlementForSyncStart(...args)
}))

vi.mock('./crdt-encrypt', () => ({
  encryptCrdtUpdate: runtimeMocks.encryptCrdtUpdate
}))

vi.mock('./http-client', () => ({
  postToServer: runtimeMocks.postToServer,
  pushCrdtSnapshot: runtimeMocks.pushCrdtSnapshot,
  SyncServerError: runtimeMocks.SyncServerError
}))

vi.mock('./retry', () => ({
  withRetry: runtimeMocks.withRetry
}))

vi.mock('./token-manager', () => ({
  emitSessionExpired: runtimeMocks.emitSessionExpired,
  getValidAccessToken: runtimeMocks.getValidAccessToken,
  refreshAccessToken: runtimeMocks.refreshAccessToken,
  retrieveToken: runtimeMocks.retrieveToken,
  setOnTokenRefreshed: runtimeMocks.setOnTokenRefreshed
}))

vi.mock('./key-verification', () => ({
  // 'unknown' = account verifier unavailable → runtime proceeds as before.
  checkLocalKeyAgainstAccount: vi.fn().mockResolvedValue('unknown'),
  isKeyMaterialActivityRecent: vi.fn().mockReturnValue(false)
}))

function createDb() {
  const updateRun = vi.fn()
  return {
    updateRun,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(() => runtimeMocks.currentDevice)
          }))
        }))
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            run: updateRun
          }))
        }))
      }))
    }
  }
}

function createIndexDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          all: vi.fn(() => runtimeMocks.indexRows)
        }))
      }))
    }))
  }
}

async function loadRuntime() {
  return import('./runtime')
}

describe('sync runtime', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    runtimeMocks.SyncQueueManager.instances = []
    runtimeMocks.CrdtUpdateQueue.instances = []
    runtimeMocks.NetworkMonitor.instances = []
    runtimeMocks.WebSocketManager.instances = []
    runtimeMocks.SyncEngine.instances = []
    runtimeMocks.SyncWorkerBridge.instances = []
    runtimeMocks.networkOnline = true
    runtimeMocks.engineStartError = null
    runtimeMocks.workerStartError = null
    runtimeMocks.indexRows = [{ id: 'note-1', title: 'Note 1', date: null }]
    runtimeMocks.currentDevice = { id: 'device-1', signingPublicKey: null }
    runtimeMocks.db = createDb()
    runtimeMocks.getDatabase.mockReturnValue(runtimeMocks.db.db)
    runtimeMocks.getIndexDatabase.mockReturnValue(createIndexDb())
    runtimeMocks.retrieveToken.mockResolvedValue('refresh-token')
    runtimeMocks.storeGet.mockReturnValue({})
    runtimeMocks.getValidAccessToken.mockResolvedValue('access-token')
    runtimeMocks.getOrInitializeLocalVaultKey.mockResolvedValue(new Uint8Array([1, 2, 3]))
    runtimeMocks.retrieveKey.mockResolvedValue(new Uint8Array([4, 5, 6]))
    runtimeMocks.deriveDevicePublicKey.mockReturnValue(new Uint8Array([7, 8, 9]))
    runtimeMocks.encryptCrdtUpdate.mockReturnValue(new Uint8Array([10, 11]))
    runtimeMocks.postToServer.mockResolvedValue({ ok: true })
    runtimeMocks.pushCrdtSnapshot.mockResolvedValue({ ok: true })
    runtimeMocks.crdtProvider.init.mockResolvedValue(undefined)
    runtimeMocks.crdtProvider.seedExistingDocs.mockResolvedValue(1)
    runtimeMocks.crdtProvider.pushSnapshotForNote.mockResolvedValue(undefined)
    runtimeMocks.crdtProvider.pushAllSnapshots.mockResolvedValue(2)
    runtimeMocks.crdtProvider.destroy.mockResolvedValue(undefined)
    runtimeMocks.syncGoogleCalendarSource.mockResolvedValue(undefined)
    runtimeMocks.resolveEntitlementForSyncStart.mockResolvedValue({
      isPaid: true,
      plan: 'plus',
      status: 'active'
    })
  })

  it('skips startup when no refresh token exists', async () => {
    runtimeMocks.retrieveToken.mockResolvedValueOnce(null)
    const runtime = await loadRuntime()

    await expect(runtime.startSyncRuntime()).resolves.toBeNull()

    expect(runtimeMocks.getDatabase).not.toHaveBeenCalled()
    expect(runtime.getSyncEngine()).toBeNull()
  })

  it('skips startup before queues and CRDT seed when vault key verification fails', async () => {
    const verificationError = new Error('Current master key does not match this vault')
    runtimeMocks.getOrInitializeLocalVaultKey.mockRejectedValueOnce(verificationError)
    const runtime = await loadRuntime()

    try {
      await expect(runtime.startSyncRuntime()).resolves.toBeNull()
    } finally {
      runtimeMocks.getOrInitializeLocalVaultKey.mockReset()
      runtimeMocks.getOrInitializeLocalVaultKey.mockResolvedValue(new Uint8Array([1, 2, 3]))
    }

    expect(runtimeMocks.SyncQueueManager.instances).toHaveLength(0)
    expect(runtimeMocks.CrdtUpdateQueue.instances).toHaveLength(0)
    expect(runtimeMocks.SyncEngine.instances).toHaveLength(0)
    expect(runtimeMocks.crdtProvider.init).not.toHaveBeenCalled()
    expect(runtimeMocks.crdtProvider.seedExistingDocs).not.toHaveBeenCalled()
    expect(runtimeMocks.recoverDirtyItems).not.toHaveBeenCalled()
    expect(runtimeMocks.logError).toHaveBeenCalledWith(
      'Sync runtime unavailable: vault key verification failed',
      verificationError
    )
    expect(runtime.getSyncEngine()).toBeNull()
  })

  it('continues startup with main-thread crypto when the sync worker fails to init', async () => {
    const workerError = new Error("Cannot find module 'electron'")
    runtimeMocks.workerStartError = workerError
    const runtime = await loadRuntime()

    try {
      await runtime.startSyncRuntime()
    } finally {
      runtimeMocks.workerStartError = null
    }

    expect(runtime.getSyncEngine()).not.toBeNull()
    expect(runtimeMocks.SyncEngine.instances).toHaveLength(1)
    expect(runtimeMocks.SyncEngine.instances[0].start).toHaveBeenCalled()
    expect(runtimeMocks.logError).toHaveBeenCalledWith(
      'Sync worker failed to start — continuing with main-thread crypto',
      workerError
    )
  })

  it('skips startup when recovery phrase confirmation is still pending', async () => {
    runtimeMocks.storeGet.mockReturnValue({ recoveryPhraseConfirmed: false })
    const runtime = await loadRuntime()

    await expect(runtime.startSyncRuntime()).resolves.toBeNull()

    expect(runtimeMocks.getDatabase).not.toHaveBeenCalled()
    expect(runtime.getSyncEngine()).toBeNull()
  })

  it('skips startup when the account is not on a paid plan', async () => {
    runtimeMocks.resolveEntitlementForSyncStart.mockResolvedValue({
      isPaid: false,
      plan: 'free',
      status: 'inactive'
    })
    const runtime = await loadRuntime()

    await expect(runtime.startSyncRuntime()).resolves.toBeNull()

    expect(runtimeMocks.getDatabase).not.toHaveBeenCalled()
    expect(runtime.getSyncEngine()).toBeNull()
  })

  it('starts, exposes, uploads CRDT batches, reacts to network/token events, and stops cleanly', async () => {
    runtimeMocks.networkOnline = false
    const runtime = await loadRuntime()

    const engine = await runtime.startSyncRuntime()

    expect(engine).toBe(runtimeMocks.SyncEngine.instances[0])
    expect(runtime.getSyncEngine()).toBe(engine)
    expect(runtime.getCrdtQueue()).toBe(runtimeMocks.CrdtUpdateQueue.instances[0])
    expect(runtime.getNetworkMonitor()).toBe(runtimeMocks.NetworkMonitor.instances[0])
    expect(runtimeMocks.createSyncAdapterRegistry).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ type: 'task' }),
        expect.objectContaining({ type: 'note', kind: 'crdt' }),
        expect.objectContaining({ type: 'calendar_external_event' })
      ])
    )
    expect(runtimeMocks.crdtProvider.init).toHaveBeenCalled()
    expect(runtimeMocks.crdtProvider.seedExistingDocs).toHaveBeenCalledWith(
      [{ id: 'note-1', title: 'Note 1', date: undefined }],
      undefined,
      expect.any(AbortSignal)
    )
    expect(runtimeMocks.trackMainEvent).toHaveBeenCalledWith('sync_enabled', {
      surface: 'sync',
      action: 'enabled',
      result: 'success'
    })

    const queue = runtimeMocks.CrdtUpdateQueue.instances[0]
    expect(queue.pause).toHaveBeenCalledTimes(1)

    await queue.onBatch?.('note-1', [new Uint8Array([1])])
    expect(runtimeMocks.postToServer).toHaveBeenCalledWith(
      '/sync/crdt/updates',
      { noteId: 'note-1', updates: [Buffer.from(new Uint8Array([10, 11])).toString('base64')] },
      'access-token'
    )
    expect(runtimeMocks.crdtProvider.pushSnapshotForNote).toHaveBeenCalledWith('note-1')
    expect(runtimeMocks.secureCleanup).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))
    expect(runtimeMocks.secureCleanup).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]))

    runtimeMocks.SyncQueueManager.instances[0].onItemEnqueued?.()
    expect(runtimeMocks.SyncEngine.instances[0].requestPush).toHaveBeenCalledTimes(1)

    const network = runtimeMocks.NetworkMonitor.instances[0]
    network.online = true
    network.listeners.get('status-changed')?.({ online: true })
    expect(queue.resume).toHaveBeenCalledTimes(1)

    const onTokenRefreshed = runtimeMocks.setOnTokenRefreshed.mock.calls[0][0] as () => void
    onTokenRefreshed()
    expect(queue.resume).toHaveBeenCalledTimes(2)
    // Fresh token is handed to the live socket so the server extends it in place
    // rather than dropping it with WS_TOKEN_EXPIRED.
    expect(runtimeMocks.WebSocketManager.instances[0].refreshAuth).toHaveBeenCalledTimes(1)

    await runtime.stopSyncRuntime()
    expect(runtimeMocks.crdtProvider.pushAllSnapshots).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.SyncEngine.instances[0].stop).toHaveBeenCalledWith({
      skipFinalPush: undefined
    })
    expect(runtimeMocks.SyncWorkerBridge.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.WebSocketManager.instances[0].disconnect).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.NetworkMonitor.instances[0].stop).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.resetCrdtProvider).toHaveBeenCalled()
  })

  it('handles CRDT auth and quota failures by pausing and notifying renderer', async () => {
    const runtime = await loadRuntime()
    await runtime.startSyncRuntime()
    const queue = runtimeMocks.CrdtUpdateQueue.instances[0]

    // Recoverable 401: refresh succeeds and the batch retries with the fresh token
    runtimeMocks.postToServer.mockRejectedValueOnce(new runtimeMocks.SyncServerError(401))
    runtimeMocks.refreshAccessToken.mockResolvedValueOnce(true)
    runtimeMocks.getValidAccessToken
      .mockResolvedValueOnce('access-token')
      .mockResolvedValueOnce('fresh-token')
    await expect(queue.onBatch?.('note-1', [new Uint8Array([1])])).resolves.toBeUndefined()
    expect(runtimeMocks.postToServer).toHaveBeenLastCalledWith(
      '/sync/crdt/updates',
      expect.objectContaining({ noteId: 'note-1' }),
      'fresh-token'
    )
    expect(queue.pause).not.toHaveBeenCalled()
    expect(runtimeMocks.emitSessionExpired).not.toHaveBeenCalled()

    // Terminal 401: refresh fails — pause without a false session-expired toast
    // (token-manager owns that emission on terminal refresh failure)
    runtimeMocks.postToServer.mockRejectedValueOnce(new runtimeMocks.SyncServerError(401))
    runtimeMocks.refreshAccessToken.mockResolvedValueOnce(false)
    await expect(queue.onBatch?.('note-1', [new Uint8Array([1])])).rejects.toThrow(
      'sync server error'
    )
    expect(queue.pause).toHaveBeenCalled()
    expect(runtimeMocks.emitSessionExpired).not.toHaveBeenCalled()

    runtimeMocks.postToServer.mockRejectedValueOnce(new runtimeMocks.SyncServerError(413))
    await expect(queue.onBatch?.('note-1', [new Uint8Array([1])])).rejects.toThrow(
      'sync server error'
    )
    expect(runtimeMocks.browserSend).toHaveBeenCalledWith(
      'sync:status-changed',
      expect.objectContaining({
        status: 'error',
        errorCategory: 'storage_quota_exceeded'
      })
    )

    await runtime.stopSyncRuntime({ skipFinalSync: true })
    expect(runtimeMocks.crdtProvider.pushAllSnapshots).not.toHaveBeenCalled()
  })

  it('guards CRDT batches and handles snapshot push auth/quota failures', async () => {
    const runtime = await loadRuntime()
    await runtime.startSyncRuntime()
    const queue = runtimeMocks.CrdtUpdateQueue.instances[0]

    runtimeMocks.getValidAccessToken.mockResolvedValueOnce(null)
    runtimeMocks.postToServer.mockClear()
    await queue.onBatch?.('note-missing-token', [new Uint8Array([1])])
    expect(runtimeMocks.postToServer).not.toHaveBeenCalled()

    runtimeMocks.encryptCrdtUpdate.mockReturnValueOnce(new Uint8Array(700_000))
    await queue.onBatch?.('note-too-large', [new Uint8Array([1]), new Uint8Array([2])])
    expect(runtimeMocks.postToServer).not.toHaveBeenCalled()

    runtimeMocks.encryptCrdtUpdate.mockReturnValue(new Uint8Array([10, 11]))
    runtimeMocks.crdtProvider.pushSnapshotForNote.mockRejectedValueOnce(
      new Error('snapshot failed')
    )
    await queue.onBatch?.('note-1', [new Uint8Array([1])])
    expect(runtimeMocks.postToServer).toHaveBeenCalledTimes(1)

    const snapshotPush = runtimeMocks.crdtProvider.init.mock.calls[0][1] as (
      noteId: string,
      state: Uint8Array
    ) => Promise<void>

    runtimeMocks.getValidAccessToken.mockResolvedValueOnce(null)
    await expect(snapshotPush('note-no-token', new Uint8Array([1]))).rejects.toThrow(
      'Missing credentials'
    )

    runtimeMocks.pushCrdtSnapshot.mockRejectedValueOnce(new runtimeMocks.SyncServerError(401))
    await expect(snapshotPush('note-auth', new Uint8Array([1]))).rejects.toThrow(
      'sync server error'
    )
    expect(queue.pause).toHaveBeenCalled()
    expect(runtimeMocks.refreshAccessToken).toHaveBeenCalled()
    expect(runtimeMocks.emitSessionExpired).not.toHaveBeenCalled()

    runtimeMocks.pushCrdtSnapshot.mockRejectedValueOnce(new runtimeMocks.SyncServerError(413))
    await expect(snapshotPush('note-quota', new Uint8Array([1]))).rejects.toThrow(
      'sync server error'
    )
    expect(runtimeMocks.browserSend).toHaveBeenCalledWith(
      'sync:status-changed',
      expect.objectContaining({ errorCategory: 'storage_quota_exceeded' })
    )
  })

  it('exposes engine dependency branches for signing keys, device keys, and calendar sync', async () => {
    const runtime = await loadRuntime()
    runtimeMocks.currentDevice = { id: 'device-1', signingPublicKey: 'stale-public-key' }
    await runtime.startSyncRuntime()

    const deps = runtimeMocks.SyncEngine.instances[0].deps as {
      getSigningKeys: () => Promise<unknown>
      getDevicePublicKey: (deviceId: string) => Promise<unknown>
      calendarSyncOneSource: (sourceId: string) => void
    }

    await expect(deps.getSigningKeys()).resolves.toEqual({
      secretKey: new Uint8Array([4, 5, 6]),
      publicKey: new Uint8Array([7, 8, 9]),
      deviceId: 'device-1'
    })
    expect(runtimeMocks.db.updateRun).toHaveBeenCalledTimes(1)

    runtimeMocks.retrieveKey.mockResolvedValueOnce(null)
    await expect(deps.getSigningKeys()).resolves.toBeNull()

    runtimeMocks.currentDevice = null
    await expect(deps.getSigningKeys()).resolves.toBeNull()
    expect(runtimeMocks.secureCleanup).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]))

    runtimeMocks.getValidAccessToken.mockResolvedValueOnce(null)
    await expect(deps.getDevicePublicKey('device-2')).resolves.toBeNull()
    await expect(deps.getDevicePublicKey('device-2')).resolves.toBeUndefined()
    expect(runtimeMocks.getDeviceSigningKey).toHaveBeenCalledWith(
      runtimeMocks.db.db,
      'device-2',
      'access-token'
    )

    deps.calendarSyncOneSource('source-1')
    expect(runtimeMocks.syncGoogleCalendarSource).toHaveBeenCalledWith(
      runtimeMocks.db.db,
      'source-1'
    )

    runtimeMocks.syncGoogleCalendarSource.mockRejectedValueOnce(new Error('google failed'))
    deps.calendarSyncOneSource('source-2')
    await Promise.resolve()
  })

  it('does not start or re-arm the sync runtime once app shutdown has begun', async () => {
    const runtime = await loadRuntime()
    // Shares the module instance the freshly-loaded runtime imports (resetModules
    // ran in beforeEach, so this is the same latch startSyncRuntime checks).
    const { beginAppShutdown } = await import('../app-shutdown')
    beginAppShutdown()

    await expect(runtime.startSyncRuntime()).resolves.toBeNull()

    // Bailed before touching the session token, database, or engine — no
    // mid-shutdown restart.
    expect(runtimeMocks.retrieveToken).not.toHaveBeenCalled()
    expect(runtimeMocks.getDatabase).not.toHaveBeenCalled()
    expect(runtimeMocks.SyncEngine.instances).toHaveLength(0)
    expect(runtime.getSyncEngine()).toBeNull()
  })

  it('cleans up partial runtime when startup fails', async () => {
    runtimeMocks.engineStartError = new Error('start failed')
    const runtime = await loadRuntime()

    await expect(runtime.startSyncRuntime()).resolves.toBeNull()

    expect(runtimeMocks.CrdtUpdateQueue.instances[0].stop).toHaveBeenCalled()
    expect(runtimeMocks.WebSocketManager.instances[0].disconnect).toHaveBeenCalled()
    expect(runtimeMocks.NetworkMonitor.instances[0].stop).toHaveBeenCalled()
    expect(runtimeMocks.SyncWorkerBridge.instances[0].stop).toHaveBeenCalled()
    expect(runtimeMocks.SyncEngine.instances[0].stop).toHaveBeenCalled()
    expect(runtimeMocks.crdtProvider.destroy).toHaveBeenCalled()
    expect(runtimeMocks.resetCrdtProvider).toHaveBeenCalled()
    expect(runtime.getSyncEngine()).toBeNull()
  })

  it('destroys CRDT provider when stopped without an active runtime', async () => {
    const runtime = await loadRuntime()

    await runtime.stopSyncRuntime()

    expect(runtimeMocks.crdtProvider.destroy).toHaveBeenCalled()
    expect(runtimeMocks.resetCrdtProvider).toHaveBeenCalled()
  })

  it('logs and continues through stop failures', async () => {
    const runtime = await loadRuntime()
    await runtime.startSyncRuntime()
    runtimeMocks.crdtProvider.pushAllSnapshots.mockRejectedValueOnce(new Error('push failed'))
    runtimeMocks.SyncEngine.instances[0].stop.mockRejectedValueOnce(new Error('stop failed'))
    runtimeMocks.SyncWorkerBridge.instances[0].stop.mockRejectedValueOnce(
      new Error('worker failed')
    )
    runtimeMocks.crdtProvider.destroy.mockRejectedValueOnce(new Error('destroy failed'))

    await runtime.stopSyncRuntime()

    expect(runtimeMocks.CrdtUpdateQueue.instances[0].stop).toHaveBeenCalled()
    expect(runtimeMocks.WebSocketManager.instances[0].disconnect).toHaveBeenCalled()
    expect(runtimeMocks.NetworkMonitor.instances[0].stop).toHaveBeenCalled()
    expect(runtimeMocks.resetCrdtProvider).toHaveBeenCalled()
  })
})
