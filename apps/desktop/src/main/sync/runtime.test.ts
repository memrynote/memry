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
    removeListener = vi.fn((event: string, cb: (payload: { online: boolean }) => void) => {
      if (this.listeners.get(event) === cb) this.listeners.delete(event)
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
    taskActivitySync: service('taskActivity'),
    bookmarkSync: service('bookmark'),
    reminderSync: service('reminder'),
    templateSync: service('template'),
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
    // token-manager keeps exactly one callback slot, and a refresh invokes
    // whatever is in it. Model that instead of a bare spy so "who does a token
    // refresh actually reach after teardown" is observable.
    tokenRefreshedCallback: null as (() => void) | null,
    setOnTokenRefreshed: vi.fn((cb: (() => void) | null) => {
      runtimeMocks.tokenRefreshedCallback = cb
    }),
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
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: runtimeMocks.browserSend }
      }
    ])
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

vi.mock('../calendar/providers/google/sync-service', () => ({
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
vi.mock('./task-activity-sync', () => ({
  initTaskActivitySyncService: runtimeMocks.taskActivitySync.init,
  resetTaskActivitySyncService: runtimeMocks.taskActivitySync.reset
}))
vi.mock('./bookmark-sync', () => ({
  initBookmarkSyncService: runtimeMocks.bookmarkSync.init,
  resetBookmarkSyncService: runtimeMocks.bookmarkSync.reset
}))

vi.mock('./template-sync', () => ({
  initTemplateSyncService: runtimeMocks.templateSync.init,
  resetTemplateSyncService: runtimeMocks.templateSync.reset
}))
vi.mock('./reminder-sync', () => ({
  initReminderSyncService: runtimeMocks.reminderSync.init,
  resetReminderSyncService: runtimeMocks.reminderSync.reset
}))
vi.mock('./canvas-sync', () => ({
  initCanvasSyncService: vi.fn(() => ({})),
  resetCanvasSyncService: vi.fn(),
  getCanvasSyncService: vi.fn(() => null)
}))
vi.mock('./canvas-folder-sync', () => ({
  initCanvasFolderSyncService: vi.fn(() => ({})),
  resetCanvasFolderSyncService: vi.fn(),
  getCanvasFolderSyncService: vi.fn(() => null)
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
  SyncServerError: runtimeMocks.SyncServerError,
  // runtime.ts → sync-errors.ts imports these; they only need to exist here.
  NetworkError: class NetworkError extends Error {},
  RateLimitError: class RateLimitError extends Error {},
  AttachmentTooLargeError: class AttachmentTooLargeError extends Error {}
}))

vi.mock('./retry', () => ({
  withRetry: runtimeMocks.withRetry,
  // runtime.ts → sync-errors.ts imports this; the class itself is exercised in
  // sync-errors.test.ts, here it only needs to exist.
  DeadLetterError: class DeadLetterError extends Error {
    constructor(public lastError: unknown) {
      super('dead letter')
    }
  }
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
        expect.objectContaining({ type: 'calendar_external_event' }),
        // Without a registry entry the handler exists but nothing ever routes
        // template mutations to it, so custom templates silently stop syncing.
        expect.objectContaining({ type: 'template', kind: 'record' })
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
    // The snapshot is deferred, not skipped — see the debounce test below.
    expect(runtimeMocks.crdtProvider.pushSnapshotForNote).not.toHaveBeenCalled()
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

  it('defers CRDT snapshot pushes instead of re-uploading after every batch', async () => {
    const runtime = await loadRuntime()
    await runtime.startSyncRuntime()
    const queue = runtimeMocks.CrdtUpdateQueue.instances[0]

    vi.useFakeTimers()
    try {
      // Continuous typing: one incremental batch per flush interval. A full
      // document encode + encrypt + upload must not ride along with each one.
      for (let i = 0; i < 5; i++) {
        await queue.onBatch?.('note-1', [new Uint8Array([1])])
        await vi.advanceTimersByTimeAsync(1000)
      }

      expect(runtimeMocks.postToServer).toHaveBeenCalledTimes(5)
      expect(runtimeMocks.crdtProvider.pushSnapshotForNote).not.toHaveBeenCalled()

      // Once typing stops, the snapshot still lands — exactly once.
      await vi.advanceTimersByTimeAsync(30_000)
      expect(runtimeMocks.crdtProvider.pushSnapshotForNote).toHaveBeenCalledTimes(1)
      expect(runtimeMocks.crdtProvider.pushSnapshotForNote).toHaveBeenCalledWith('note-1')
    } finally {
      vi.useRealTimers()
    }

    await runtime.stopSyncRuntime({ skipFinalSync: true })
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

    // Bare 413 = body-limit rejection (oversized note), NOT quota: report
    // note_too_large and keep the queue running for every other note.
    const pauseCallsBeforeBodyLimit = queue.pause.mock.calls.length
    runtimeMocks.postToServer.mockRejectedValueOnce(new runtimeMocks.SyncServerError(413))
    await expect(queue.onBatch?.('note-1', [new Uint8Array([1])])).rejects.toThrow(
      'sync server error'
    )
    expect(runtimeMocks.browserSend).toHaveBeenCalledWith(
      'sync:status-changed',
      expect.objectContaining({
        status: 'error',
        errorCategory: 'note_too_large'
      })
    )
    expect(queue.pause.mock.calls.length).toBe(pauseCallsBeforeBodyLimit)

    // 413 carrying the server's quota code is the real storage-full case:
    // everything will fail, so pausing the queue is correct.
    runtimeMocks.postToServer.mockRejectedValueOnce(
      new runtimeMocks.SyncServerError(413, 'STORAGE_QUOTA_EXCEEDED: Storage quota exceeded')
    )
    await expect(queue.onBatch?.('note-1', [new Uint8Array([1])])).rejects.toThrow(
      'STORAGE_QUOTA_EXCEEDED'
    )
    expect(runtimeMocks.browserSend).toHaveBeenCalledWith(
      'sync:status-changed',
      expect.objectContaining({
        status: 'error',
        errorCategory: 'storage_quota_exceeded'
      })
    )
    expect(queue.pause.mock.calls.length).toBe(pauseCallsBeforeBodyLimit + 1)

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

    // A batch whose total is large but whose entries each fit a D1 row must be
    // sent, not discarded: dropping it lost the user's paste on every device.
    runtimeMocks.encryptCrdtUpdate.mockReturnValueOnce(new Uint8Array(700_000))
    await queue.onBatch?.('note-too-large', [new Uint8Array([1]), new Uint8Array([2])])
    expect(runtimeMocks.postToServer).toHaveBeenCalledWith(
      '/sync/crdt/updates',
      expect.objectContaining({ noteId: 'note-too-large' }),
      'access-token'
    )
    const sentBody = runtimeMocks.postToServer.mock.calls[0][1] as { updates: string[] }
    expect(sentBody.updates).toHaveLength(2)

    runtimeMocks.postToServer.mockClear()
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

    // Bare 413 on snapshot push = the note's snapshot is over the body limit:
    // note_too_large, no queue pause (other notes must keep syncing).
    const pauseCallsBeforeSnapshot = queue.pause.mock.calls.length
    runtimeMocks.pushCrdtSnapshot.mockRejectedValueOnce(new runtimeMocks.SyncServerError(413))
    await expect(snapshotPush('note-oversized', new Uint8Array([1]))).rejects.toThrow(
      'sync server error'
    )
    expect(runtimeMocks.browserSend).toHaveBeenCalledWith(
      'sync:status-changed',
      expect.objectContaining({ errorCategory: 'note_too_large' })
    )
    expect(queue.pause.mock.calls.length).toBe(pauseCallsBeforeSnapshot)

    runtimeMocks.pushCrdtSnapshot.mockRejectedValueOnce(
      new runtimeMocks.SyncServerError(413, 'STORAGE_QUOTA_EXCEEDED: Storage quota exceeded')
    )
    await expect(snapshotPush('note-quota', new Uint8Array([1]))).rejects.toThrow(
      'STORAGE_QUOTA_EXCEEDED'
    )
    expect(runtimeMocks.browserSend).toHaveBeenCalledWith(
      'sync:status-changed',
      expect.objectContaining({ errorCategory: 'storage_quota_exceeded' })
    )
    expect(queue.pause.mock.calls.length).toBe(pauseCallsBeforeSnapshot + 1)
  })

  it('splits a CRDT batch too big for one request across several requests', async () => {
    const runtime = await loadRuntime()
    await runtime.startSyncRuntime()
    const queue = runtimeMocks.CrdtUpdateQueue.instances[0]
    runtimeMocks.postToServer.mockClear()

    // Six updates that each fit a D1 row but together exceed the 8 MiB body cap.
    runtimeMocks.encryptCrdtUpdate.mockReturnValue(new Uint8Array(890_000))
    const raw = Array.from({ length: 6 }, (_, i) => new Uint8Array([i]))

    await queue.onBatch?.('note-1', raw)

    expect(runtimeMocks.postToServer).toHaveBeenCalledTimes(2)
    const sent = runtimeMocks.postToServer.mock.calls.flatMap(
      (call) => (call[1] as { updates: string[] }).updates
    )
    // Every update reaches the server — the batch is split, never trimmed.
    expect(sent).toHaveLength(6)
    for (const call of runtimeMocks.postToServer.mock.calls) {
      const body = call[1] as { updates: string[] }
      const chars = body.updates.reduce((sum, update) => sum + update.length, 0)
      expect(chars).toBeLessThanOrEqual(6_000_000)
    }

    runtimeMocks.encryptCrdtUpdate.mockReturnValue(new Uint8Array([10, 11]))
    await runtime.stopSyncRuntime({ skipFinalSync: true })
  })

  it('pushes a snapshot when one CRDT update is too large for the incremental path', async () => {
    const runtime = await loadRuntime()
    await runtime.startSyncRuntime()
    const queue = runtimeMocks.CrdtUpdateQueue.instances[0]
    runtimeMocks.postToServer.mockClear()
    runtimeMocks.crdtProvider.pushSnapshotForNote.mockReset()
    runtimeMocks.crdtProvider.pushSnapshotForNote.mockResolvedValue(true)

    // One paste: a single update far past what a D1 `crdt_updates` row holds.
    runtimeMocks.encryptCrdtUpdate.mockReturnValueOnce(new Uint8Array(1_000_000))

    await expect(
      queue.onBatch?.('note-1', [new Uint8Array([1]), new Uint8Array([2])])
    ).resolves.toBeUndefined()

    // The small sibling still rides the incremental path...
    expect(runtimeMocks.postToServer).toHaveBeenCalledTimes(1)
    const body = runtimeMocks.postToServer.mock.calls[0][1] as { updates: string[] }
    expect(body.updates).toHaveLength(1)
    // ...and the oversized one converges through the R2-backed snapshot instead
    // of vanishing.
    expect(runtimeMocks.crdtProvider.pushSnapshotForNote).toHaveBeenCalledWith('note-1')

    runtimeMocks.encryptCrdtUpdate.mockReturnValue(new Uint8Array([10, 11]))
    await runtime.stopSyncRuntime({ skipFinalSync: true })
  })

  it('fails loudly when the snapshot fallback for an oversized CRDT update does not land', async () => {
    const runtime = await loadRuntime()
    await runtime.startSyncRuntime()
    const queue = runtimeMocks.CrdtUpdateQueue.instances[0]
    runtimeMocks.postToServer.mockClear()
    runtimeMocks.crdtProvider.pushSnapshotForNote.mockReset()
    runtimeMocks.crdtProvider.pushSnapshotForNote.mockResolvedValue(false)

    runtimeMocks.encryptCrdtUpdate.mockReturnValue(new Uint8Array(1_000_000))

    // Rejecting is what keeps the batch buffered for the next flush; resolving
    // here would be the silent drop this path replaces.
    await expect(queue.onBatch?.('note-1', [new Uint8Array([1])])).rejects.toThrow(
      'CRDT snapshot fallback failed'
    )
    expect(runtimeMocks.postToServer).not.toHaveBeenCalled()

    runtimeMocks.encryptCrdtUpdate.mockReturnValue(new Uint8Array([10, 11]))
    await runtime.stopSyncRuntime({ skipFinalSync: true })
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

  it('detaches its network subscriber on stop so the dead runtime graph is unreachable', async () => {
    const runtime = await loadRuntime()
    await runtime.startSyncRuntime()

    const deadNetwork = runtimeMocks.NetworkMonitor.instances[0]
    const deadQueue = runtimeMocks.CrdtUpdateQueue.instances[0]
    // The subscriber the runtime installed really does reach this runtime's
    // CRDT queue — that is what makes leaving it attached a live wire.
    deadNetwork.listeners.get('status-changed')?.({ online: false })
    expect(deadQueue.pause).toHaveBeenCalled()
    deadQueue.pause.mockClear()

    await runtime.stopSyncRuntime({ skipFinalSync: true })

    // The attachment UploadQueue is a module singleton that keeps holding this
    // NetworkMonitor after the runtime is gone, so an attached subscriber would
    // keep the dead crdtQueue/crdtProvider graph reachable for the session.
    expect(deadNetwork.listeners.size).toBe(0)
  })

  it('detaches its network subscriber when startup fails after the runtime is assembled', async () => {
    const runtime = await loadRuntime()
    runtimeMocks.engineStartError = new Error('engine start failed')

    await expect(runtime.startSyncRuntime()).resolves.toBeNull()

    expect(runtimeMocks.NetworkMonitor.instances[0].listeners.size).toBe(0)
    expect(runtimeMocks.NetworkMonitor.instances[0].stop).toHaveBeenCalled()
  })

  // The attachment UploadQueue lives in the IPC layer but binds THIS runtime's
  // NetworkMonitor for its lifetime, so it has to be reset on the same paths the
  // other per-vault singletons are. Left alive it stays subscribed to a stopped
  // monitor — reconnect wake-up dead, `online` frozen — and serves the next vault.
  it('resets the attachment upload queue on stop', async () => {
    const runtime = await loadRuntime()
    // resetModules ran in beforeEach, so this is the same module instance the
    // freshly-loaded runtime imports.
    const { registerAttachmentQueueReset } = await import('./attachment-outbox')
    const resetAttachmentQueue = vi.fn()
    registerAttachmentQueueReset(resetAttachmentQueue)

    await runtime.startSyncRuntime()
    expect(resetAttachmentQueue).not.toHaveBeenCalled()

    await runtime.stopSyncRuntime({ skipFinalSync: true })

    expect(resetAttachmentQueue).toHaveBeenCalled()
  })

  it('resets the attachment upload queue when startup fails after the runtime is assembled', async () => {
    const runtime = await loadRuntime()
    const { registerAttachmentQueueReset } = await import('./attachment-outbox')
    const resetAttachmentQueue = vi.fn()
    registerAttachmentQueueReset(resetAttachmentQueue)
    runtimeMocks.engineStartError = new Error('engine start failed')

    await expect(runtime.startSyncRuntime()).resolves.toBeNull()

    // A queue built during the doomed start would otherwise outlive the monitor
    // that was just stopped in the same cleanup block.
    expect(resetAttachmentQueue).toHaveBeenCalled()
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

  describe('token-refresh callback lifecycle', () => {
    /** What token-manager does on a successful refresh: invoke the one slot. */
    const fireTokenRefresh = (): void => runtimeMocks.tokenRefreshedCallback?.()

    beforeEach(() => {
      runtimeMocks.tokenRefreshedCallback = null
    })

    it('detaches the callback on stop so a later refresh cannot reach the dead runtime', async () => {
      const runtime = await loadRuntime()
      await runtime.startSyncRuntime()

      const deadQueue = runtimeMocks.CrdtUpdateQueue.instances[0]
      const deadWs = runtimeMocks.WebSocketManager.instances[0]
      const deadNetwork = runtimeMocks.NetworkMonitor.instances[0]
      // The closure the runtime installed really is the one that reaches into
      // these three — that is what makes leaving it installed a live wire.
      fireTokenRefresh()
      expect(deadQueue.resume).toHaveBeenCalledTimes(1)
      expect(deadWs.refreshAuth).toHaveBeenCalledTimes(1)
      deadQueue.resume.mockClear()
      deadWs.refreshAuth.mockClear()

      await runtime.stopSyncRuntime({ skipFinalSync: true })
      expect(deadQueue.stop).toHaveBeenCalledTimes(1)
      expect(deadWs.disconnect).toHaveBeenCalledTimes(1)
      expect(deadNetwork.stop).toHaveBeenCalledTimes(1)

      // The slot token-manager reads is empty: nothing in the token layer still
      // holds this runtime's queue, socket or network monitor.
      expect(runtimeMocks.tokenRefreshedCallback).toBeNull()

      fireTokenRefresh()
      expect(deadQueue.resume).not.toHaveBeenCalled()
      expect(deadWs.refreshAuth).not.toHaveBeenCalled()
    })

    it('leaves token refresh working for the runtime that replaces a stopped one', async () => {
      const runtime = await loadRuntime()
      await runtime.startSyncRuntime()
      const firstQueue = runtimeMocks.CrdtUpdateQueue.instances[0]
      const firstWs = runtimeMocks.WebSocketManager.instances[0]

      await runtime.stopSyncRuntime({ skipFinalSync: true })
      await runtime.startSyncRuntime()

      const secondQueue = runtimeMocks.CrdtUpdateQueue.instances[1]
      const secondWs = runtimeMocks.WebSocketManager.instances[1]
      expect(secondQueue).not.toBe(firstQueue)
      expect(secondWs).not.toBe(firstWs)
      firstQueue.resume.mockClear()
      firstWs.refreshAuth.mockClear()

      fireTokenRefresh()

      // Clearing on stop must not outlive the stop: the vault-switch runtime
      // still re-authenticates, or sync dies silently for the rest of the session.
      expect(secondQueue.resume).toHaveBeenCalledTimes(1)
      expect(secondWs.refreshAuth).toHaveBeenCalledTimes(1)
      expect(firstQueue.resume).not.toHaveBeenCalled()
      expect(firstWs.refreshAuth).not.toHaveBeenCalled()
    })

    it('does not unhook a runtime that starts while the previous one is still tearing down', async () => {
      const runtime = await loadRuntime()
      await runtime.startSyncRuntime()

      // stopSyncRuntime clears `runtime` before it awaits its teardown, so a
      // start that lands during those awaits — the deferred-start timer, a
      // sync:enable IPC — builds a whole new runtime while the old stop is
      // still in flight. engine.stop is the first of those awaits.
      runtimeMocks.SyncEngine.instances[0].stop.mockImplementationOnce(async () => {
        await runtime.startSyncRuntime()
      })
      await runtime.stopSyncRuntime({ skipFinalSync: true })

      const secondQueue = runtimeMocks.CrdtUpdateQueue.instances[1]
      const secondWs = runtimeMocks.WebSocketManager.instances[1]
      expect(secondQueue).toBeDefined()

      fireTokenRefresh()

      // The live runtime keeps its token refresh. Detaching any later than the
      // tick that clears `runtime` would strand this one with no way to
      // re-authenticate, and sync would stop with no error surfaced.
      expect(secondQueue.resume).toHaveBeenCalledTimes(1)
      expect(secondWs.refreshAuth).toHaveBeenCalledTimes(1)
    })
  })
})
