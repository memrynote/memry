/**
 * The seam, driven end to end.
 *
 * The #1503 fix spans four layers: `CrdtSyncCoordinator` decides a note's
 * server state is unmerged, `SyncEngine.hasUnmergedRemoteCrdtState` carries
 * that answer out, and `snapshotPushFn` in `runtime.ts` turns it into an
 * endpoint — `/sync/crdt/updates` (appends, prunes nothing) instead of
 * `/sync/crdt/snapshot` (whose `pruneUpdatesBeforeSnapshot` deletes every
 * device's rows at or below the watermark).
 *
 * #1489 shipped a first revision where each half was tested against a mock of
 * the other: `crdt-sync-coordinator.test.ts` asserts the flag is raised,
 * `runtime.test.ts` asserts the endpoint given a flag through a stubbed
 * `SyncEngine`, and a mutation that disabled the fix outright left every sync
 * test green. So this file mocks nothing between the two: a REAL coordinator
 * inside a REAL engine inside the REAL runtime, with a genuinely failing pull,
 * asserted against which HTTP function the push actually called. Only the HTTP
 * layer and the process-level infrastructure are mocked.
 */
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
    SyncWorkerBridge,
    taskSync: service('task'),
    inboxSync: service('inbox'),
    filterSync: service('filter'),
    taskActivitySync: service('taskActivity'),
    bookmarkSync: service('bookmark'),
    reminderSync: service('reminder'),
    templateSync: service('template'),
    homePageSync: service('home_page'),
    customIconSync: service('custom_icon'),
    projectSync: service('project'),
    settingsSync: service('settings'),
    noteSync: service('note'),
    journalSync: service('journal'),
    tagDefinitionSync: service('tag_definition'),
    propertyDefinitionSync: service('property_definition'),
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
    syncStateRows: [] as Array<{ value: string }>,
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
    pushCrdtFullUpdate: vi.fn(),
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => ({ value: await fn() })),
    getFromServer: vi.fn(),
    fetchCrdtSnapshot: vi.fn(),
    trackMainError: vi.fn(),
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
    recordPendingCrdtNotes: vi.fn(),
    drainPendingCrdtNotes: vi.fn(
      async (_deps: {
        mergeRemote: (noteId: string) => Promise<boolean>
        pushSnapshot: (noteId: string) => Promise<boolean>
        isSyncable: (noteId: string) => boolean
      }) => ({ cleared: 0, retained: 0 })
    ),
    resetCrdtProvider: vi.fn(),
    /** Notes the engine reports as holding server state it could not verify. */
    unverifiedCrdtNotes: new Set<string>(),
    syncGoogleCalendarSource: vi.fn(),
    crdtProvider: {
      isNoteLocalOnly: vi.fn(() => false),
      isNoteSyncable: vi.fn(() => true),
      init: vi.fn(),
      seedExistingDocs: vi.fn(),
      pushSnapshotForNote: vi.fn(),
      pushAllSnapshots: vi.fn(),
      destroy: vi.fn(),
      // The surface the real CrdtSyncCoordinator drives. Y.Doc mechanics are
      // not what this file is testing; which endpoint the push reaches is.
      inactiveDocCapacity: 32,
      getDoc: vi.fn(() => undefined),
      open: vi.fn(async () => ({})),
      closeIfInactive: vi.fn(async () => true),
      applyRemoteUpdate: vi.fn(),
      getStateVector: vi.fn(() => new Uint8Array([1, 2, 3, 4])),
      seedFromMarkdownPublic: vi.fn(async () => undefined),
      getOpenNoteIds: vi.fn(() => [])
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

vi.mock('@memry/sync-client/queue', () => ({ SyncQueueManager: runtimeMocks.SyncQueueManager }))
vi.mock('./network', () => ({ NetworkMonitor: runtimeMocks.NetworkMonitor }))
vi.mock('./websocket', () => ({ WebSocketManager: runtimeMocks.WebSocketManager }))
/**
 * The real SyncEngine, with only `start`/`stop` neutered.
 *
 * Those two bring up the websocket, the network monitor and a full sync — none
 * of which the endpoint choice depends on, and all of which would drag half the
 * process into this file. Everything the fix runs through — the coordinator it
 * constructs, `mergeRemoteCrdtForNote`, `hasUnmergedRemoteCrdtState` — is the
 * shipped implementation.
 */
vi.mock('./engine', async () => {
  const actual = await vi.importActual<typeof import('./engine')>('./engine')
  class TestSyncEngine extends actual.SyncEngine {
    static instances: TestSyncEngine[] = []
    constructor(deps: ConstructorParameters<typeof actual.SyncEngine>[0]) {
      super(deps)
      TestSyncEngine.instances.push(this)
    }
    async start(): Promise<void> {
      if (runtimeMocks.engineStartError) throw runtimeMocks.engineStartError
    }
    async stop(): Promise<void> {}
  }
  return { SyncEngine: TestSyncEngine }
})

vi.mock('../telemetry/diagnostics', () => ({
  trackMainError: runtimeMocks.trackMainError
}))
vi.mock('./worker-bridge', () => ({ SyncWorkerBridge: runtimeMocks.SyncWorkerBridge }))
vi.mock('./crdt-queue', () => ({ CrdtUpdateQueue: runtimeMocks.CrdtUpdateQueue }))

vi.mock('@memry/sync-client/task-sync', () => ({
  initTaskSyncService: runtimeMocks.taskSync.init,
  resetTaskSyncService: runtimeMocks.taskSync.reset
}))
vi.mock('@memry/sync-client/inbox-sync', () => ({
  initInboxSyncService: runtimeMocks.inboxSync.init,
  resetInboxSyncService: runtimeMocks.inboxSync.reset
}))
vi.mock('@memry/sync-client/filter-sync', () => ({
  initFilterSyncService: runtimeMocks.filterSync.init,
  resetFilterSyncService: runtimeMocks.filterSync.reset
}))
vi.mock('@memry/sync-client/task-activity-sync', () => ({
  initTaskActivitySyncService: runtimeMocks.taskActivitySync.init,
  resetTaskActivitySyncService: runtimeMocks.taskActivitySync.reset
}))
vi.mock('@memry/sync-client/bookmark-sync', () => ({
  initBookmarkSyncService: runtimeMocks.bookmarkSync.init,
  resetBookmarkSyncService: runtimeMocks.bookmarkSync.reset
}))

vi.mock('@memry/sync-client/template-sync', () => ({
  initTemplateSyncService: runtimeMocks.templateSync.init,
  resetTemplateSyncService: runtimeMocks.templateSync.reset
}))
vi.mock('@memry/sync-client/home-page-sync', () => ({
  initHomePageSyncService: runtimeMocks.homePageSync.init,
  resetHomePageSyncService: runtimeMocks.homePageSync.reset
}))
vi.mock('@memry/sync-client/custom-icon-sync', () => ({
  initCustomIconSyncService: runtimeMocks.customIconSync.init,
  resetCustomIconSyncService: runtimeMocks.customIconSync.reset
}))
vi.mock('@memry/sync-client/reminder-sync', () => ({
  initReminderSyncService: runtimeMocks.reminderSync.init,
  resetReminderSyncService: runtimeMocks.reminderSync.reset
}))
vi.mock('@memry/sync-client/canvas-sync', () => ({
  initCanvasSyncService: vi.fn(() => ({})),
  resetCanvasSyncService: vi.fn(),
  getCanvasSyncService: vi.fn(() => null)
}))
vi.mock('@memry/sync-client/canvas-folder-sync', () => ({
  initCanvasFolderSyncService: vi.fn(() => ({})),
  resetCanvasFolderSyncService: vi.fn(),
  getCanvasFolderSyncService: vi.fn(() => null)
}))
vi.mock('@memry/sync-client/project-sync', () => ({
  initProjectSyncService: runtimeMocks.projectSync.init,
  resetProjectSyncService: runtimeMocks.projectSync.reset
}))
vi.mock('@memry/sync-client/settings-sync', () => ({
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
vi.mock('@memry/sync-client/tag-definition-sync', () => ({
  initTagDefinitionSyncService: runtimeMocks.tagDefinitionSync.init,
  resetTagDefinitionSyncService: runtimeMocks.tagDefinitionSync.reset
}))
vi.mock('@memry/sync-client/property-definition-sync', () => ({
  initPropertyDefinitionSyncService: runtimeMocks.propertyDefinitionSync.init,
  resetPropertyDefinitionSyncService: runtimeMocks.propertyDefinitionSync.reset
}))
vi.mock('@memry/sync-client/tag-category-sync', () => ({
  initTagCategorySyncService: runtimeMocks.tagCategorySync.init,
  resetTagCategorySyncService: runtimeMocks.tagCategorySync.reset
}))
vi.mock('@memry/sync-client/folder-config-sync', () => ({
  initFolderConfigSyncService: runtimeMocks.folderConfigSync.init,
  resetFolderConfigSyncService: runtimeMocks.folderConfigSync.reset
}))
vi.mock('./calendar-event-sync', () => ({
  initCalendarEventSyncService: runtimeMocks.calendarEventSync.init,
  resetCalendarEventSyncService: runtimeMocks.calendarEventSync.reset
}))
vi.mock('@memry/sync-client/calendar-source-sync', () => ({
  initCalendarSourceSyncService: runtimeMocks.calendarSourceSync.init,
  resetCalendarSourceSyncService: runtimeMocks.calendarSourceSync.reset
}))
vi.mock('@memry/sync-client/calendar-binding-sync', () => ({
  initCalendarBindingSyncService: runtimeMocks.calendarBindingSync.init,
  resetCalendarBindingSyncService: runtimeMocks.calendarBindingSync.reset
}))
vi.mock('@memry/sync-client/calendar-external-event-sync', () => ({
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

vi.mock('./crdt-pending-notes', () => ({
  recordPendingCrdtNotes: runtimeMocks.recordPendingCrdtNotes,
  drainPendingCrdtNotes: runtimeMocks.drainPendingCrdtNotes
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
  pushCrdtFullUpdate: runtimeMocks.pushCrdtFullUpdate,
  // Mocking stops here: everything between these calls and the endpoint choice
  // is the real code path.
  getFromServer: runtimeMocks.getFromServer,
  fetchCrdtSnapshot: runtimeMocks.fetchCrdtSnapshot,
  SyncServerError: runtimeMocks.SyncServerError,
  // runtime.ts → sync-errors.ts imports these; they only need to exist here.
  NetworkError: class NetworkError extends Error {},
  RateLimitError: class RateLimitError extends Error {},
  AttachmentTooLargeError: class AttachmentTooLargeError extends Error {}
}))

vi.mock('@memry/sync-client/retry', () => ({
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
  // `sync_state` rows, read through SyncStateManager.getStateValue (`.all()`)
  // rather than the device lookup (`.get()`). The endpoint choice reads one of
  // them — `crdtUnmergedDebt`, the record that a previous session ended holding
  // notes it had not merged — so this is on the path, not scenery.
  const stateInsertRun = vi.fn()
  return {
    updateRun,
    stateInsertRun,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(() => runtimeMocks.currentDevice),
            all: vi.fn(() => runtimeMocks.syncStateRows)
          }))
        }))
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() => ({ run: stateInsertRun }))
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

describe('CRDT snapshot push endpoint choice, coordinator to wire', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    runtimeMocks.SyncQueueManager.instances = []
    runtimeMocks.CrdtUpdateQueue.instances = []
    runtimeMocks.NetworkMonitor.instances = []
    runtimeMocks.WebSocketManager.instances = []
    runtimeMocks.SyncWorkerBridge.instances = []
    runtimeMocks.networkOnline = true
    runtimeMocks.engineStartError = null
    runtimeMocks.workerStartError = null
    runtimeMocks.indexRows = [{ id: 'note-1', title: 'Note 1', date: null }]
    runtimeMocks.currentDevice = { id: 'device-1', signingPublicKey: null }
    runtimeMocks.syncStateRows = []
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
    runtimeMocks.pushCrdtFullUpdate.mockResolvedValue({ ok: true })
    runtimeMocks.crdtProvider.init.mockResolvedValue(undefined)
    runtimeMocks.crdtProvider.seedExistingDocs.mockResolvedValue(1)
    runtimeMocks.crdtProvider.pushSnapshotForNote.mockResolvedValue(undefined)
    runtimeMocks.crdtProvider.pushAllSnapshots.mockResolvedValue(2)
    runtimeMocks.crdtProvider.destroy.mockResolvedValue(undefined)
    runtimeMocks.crdtProvider.getDoc.mockReturnValue(undefined)
    runtimeMocks.crdtProvider.open.mockResolvedValue({})
    runtimeMocks.crdtProvider.closeIfInactive.mockResolvedValue(true)
    runtimeMocks.crdtProvider.getStateVector.mockReturnValue(new Uint8Array([1, 2, 3, 4]))
    runtimeMocks.syncGoogleCalendarSource.mockResolvedValue(undefined)
    runtimeMocks.resolveEntitlementForSyncStart.mockResolvedValue({
      isPaid: true,
      plan: 'plus',
      status: 'active'
    })
    // No server snapshot for these notes — the state every note is in until its
    // first snapshot lands, and the only window in which the prune is
    // destructive (`storeSnapshot` freezes the watermark thereafter).
    runtimeMocks.fetchCrdtSnapshot.mockResolvedValue(null)
  })

  async function bootRuntime(): Promise<{
    engine: { mergeRemoteCrdtForNote: (noteId: string) => Promise<boolean> }
    snapshotPush: (noteId: string, state: Uint8Array) => Promise<void>
    stop: () => Promise<void>
  }> {
    const runtime = await loadRuntime()
    await runtime.startSyncRuntime()
    const engine = runtime.getSyncEngine()
    if (!engine) throw new Error('sync runtime did not start')
    return {
      engine,
      snapshotPush: runtimeMocks.crdtProvider.init.mock.calls[0][1] as (
        noteId: string,
        state: Uint8Array
      ) => Promise<void>,
      stop: () => runtime.stopSyncRuntime()
    }
  }

  it('sends a note whose pull genuinely failed to the endpoint that prunes nothing', async () => {
    const { engine, snapshotPush, stop } = await bootRuntime()

    // #given the server sheds this note's incrementals. A rate-limited pull is
    // the ordinary way step 2 of #1503 happens: the sweep's per-note baselines
    // are the bulk of its requests and the first thing the server refuses, and
    // `retryOn429: false` means the pass gives up rather than waiting it out.
    runtimeMocks.getFromServer.mockRejectedValue(new runtimeMocks.SyncServerError(429))

    // #when the real CrdtSyncCoordinator tries to merge, through the real
    // SyncEngine, and cannot
    await expect(engine.mergeRemoteCrdtForNote('note-unmerged')).resolves.toBe(false)

    runtimeMocks.pushCrdtSnapshot.mockClear()
    runtimeMocks.pushCrdtFullUpdate.mockClear()

    // #and the 30s quiet period then asks for this note's full state
    await snapshotPush('note-unmerged', new Uint8Array([1, 2, 3]))

    // #then it must not reach /sync/crdt/snapshot. That route runs
    // pruneUpdatesBeforeSnapshot, and with no snapshot stored yet the watermark
    // is `currentSeq` — so it deletes EVERY crdt_updates row for the note,
    // including the peer incrementals this device just failed to read. They
    // would be gone from the server and absent from the snapshot replacing
    // them: destroyed for every device.
    expect(runtimeMocks.pushCrdtSnapshot).not.toHaveBeenCalled()
    expect(runtimeMocks.pushCrdtFullUpdate).toHaveBeenCalledWith(
      'note-unmerged',
      new Uint8Array([10, 11]),
      'access-token'
    )

    await stop()
  })

  it('still snapshots a note whose pull merged end to end', async () => {
    const { engine, snapshotPush, stop } = await bootRuntime()

    // #given the pull completes
    runtimeMocks.getFromServer.mockResolvedValue({ updates: [], hasMore: false })

    // #when
    await expect(engine.mergeRemoteCrdtForNote('note-merged')).resolves.toBe(true)

    runtimeMocks.pushCrdtSnapshot.mockClear()
    runtimeMocks.pushCrdtFullUpdate.mockClear()
    await snapshotPush('note-merged', new Uint8Array([1, 2, 3]))

    // #then the safe route has to stay the exception. A predicate hard-wired to
    // `true` would cost every note in the vault its compaction point and leave
    // the server accumulating full-state rows forever, which is a real cost
    // dressed up as a passing test.
    expect(runtimeMocks.pushCrdtFullUpdate).not.toHaveBeenCalled()
    expect(runtimeMocks.pushCrdtSnapshot).toHaveBeenCalledWith(
      'note-merged',
      new Uint8Array([10, 11]),
      'access-token'
    )

    await stop()
  })

  it('routes every note away from the prune when the last session ended holding debt', async () => {
    // #given the previous session quit with a note it had not merged. The set
    // naming that note is per session and `clearCaches()` emptied it, and this
    // launch is inside the sweep interval, so `shouldSweepAllCrdtNotes` queues
    // nothing that would re-raise it. All that survives is the `sync_state`
    // record that debt existed.
    runtimeMocks.syncStateRows = [{ value: '1' }]
    const { snapshotPush, stop } = await bootRuntime()

    // #when the user edits a note this session has never pulled, merged or even
    // heard of, and the 30s quiet period pushes its full state
    await snapshotPush('note-from-last-session', new Uint8Array([1, 2, 3]))

    // #then it still must not reach /sync/crdt/snapshot. That note may be the
    // one the last session failed to merge — this session cannot tell — and with
    // no snapshot stored the prune's watermark is `currentSeq`, so it would
    // delete every peer row the note has.
    expect(runtimeMocks.pushCrdtSnapshot).not.toHaveBeenCalled()
    expect(runtimeMocks.pushCrdtFullUpdate).toHaveBeenCalledWith(
      'note-from-last-session',
      new Uint8Array([10, 11]),
      'access-token'
    )

    await stop()
  })

  it('snapshots normally when the last session ended with nothing outstanding', async () => {
    // #given no carried-over debt — the ordinary case, and the one that keeps
    // the blanket from quietly costing every install its compaction point
    runtimeMocks.syncStateRows = []
    const { snapshotPush, stop } = await bootRuntime()

    // #when
    await snapshotPush('note-untouched', new Uint8Array([1, 2, 3]))

    // #then
    expect(runtimeMocks.pushCrdtFullUpdate).not.toHaveBeenCalled()
    expect(runtimeMocks.pushCrdtSnapshot).toHaveBeenCalledWith(
      'note-untouched',
      new Uint8Array([10, 11]),
      'access-token'
    )

    await stop()
  })

  it('returns the note to the snapshot endpoint once a later pass does merge it', async () => {
    const { engine, snapshotPush, stop } = await bootRuntime()

    // #given a pull that failed, so the note is routed away from the prune
    runtimeMocks.getFromServer.mockRejectedValueOnce(new runtimeMocks.SyncServerError(429))
    await engine.mergeRemoteCrdtForNote('note-retried')
    await snapshotPush('note-retried', new Uint8Array([1, 2, 3]))
    expect(runtimeMocks.pushCrdtFullUpdate).toHaveBeenCalledTimes(1)

    // #when the next pass succeeds — the transient case, which is what a 429 or
    // a briefly expired token looks like from here
    runtimeMocks.getFromServer.mockResolvedValue({ updates: [], hasMore: false })
    await expect(engine.mergeRemoteCrdtForNote('note-retried')).resolves.toBe(true)

    runtimeMocks.pushCrdtSnapshot.mockClear()
    runtimeMocks.pushCrdtFullUpdate.mockClear()
    await snapshotPush('note-retried', new Uint8Array([1, 2, 3]))

    // #then compaction resumes. A flag that only ever latched would be safe but
    // permanently expensive: the note would never get a snapshot again for the
    // life of the session.
    expect(runtimeMocks.pushCrdtFullUpdate).not.toHaveBeenCalled()
    expect(runtimeMocks.pushCrdtSnapshot).toHaveBeenCalledTimes(1)

    await stop()
  })
})
