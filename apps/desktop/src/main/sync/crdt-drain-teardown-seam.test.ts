/**
 * The teardown abort, driven end to end.
 *
 * The #1514 fix spans three layers: `stopSyncRuntime` trips an AbortController,
 * the runtime's full-state reader checks it around its merge, and the note-body
 * outbox keeps a row whose read threw. Each half is trivially testable against
 * a mock of the other, and #1489 already showed where that ends — its two
 * halves were each tested against a mock of the other, and a mutation that
 * disabled the fix outright left 2217 tests green.
 *
 * So nothing between the ends is mocked here: a REAL `stopSyncRuntime` on the
 * REAL runtime, tripping a REAL `NoteBodyOutbox` full-state flush that is
 * genuinely in flight, fed by the REAL import of the pre-#2298 pending-note
 * file, with a REAL SyncEngine and CrdtSyncCoordinator doing the merge. Only
 * the HTTP layer, the sync_queue rows (an in-memory stand-in), the
 * CrdtProvider's Y.Doc mechanics and the process-level infrastructure are
 * mocked — and `crdtProvider.open` is the assertion target precisely because it
 * is the call the issue is about: after `destroy()` the provider has no
 * persistence, so every server update it applies lands in a doc nothing will
 * ever save.
 *
 * Modelled on crdt-snapshot-endpoint-seam.test.ts, which stands the same runtime
 * up for #1503.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtimeMocks = vi.hoisted(() => {
  class SyncServerError extends Error {
    statusCode: number
    constructor(statusCode: number, message = 'sync server error') {
      super(message)
      this.statusCode = statusCode
    }
  }

  /** The note_body rows of sync_queue, shared by every instance like the table. */
  class SyncQueueManager {
    static rows: Array<{ id: string; itemId: string; payload: string }> = []
    static nextId = 0
    onItemEnqueued: (() => void) | null = null
    constructor(public db: unknown) {}
    setOnItemEnqueued = vi.fn((cb: () => void) => {
      this.onItemEnqueued = cb
    })
    enqueueNoteBody(noteId: string, payload: string): void {
      const rows = SyncQueueManager.rows
      if (payload === '' && rows.some((r) => r.itemId === noteId && r.payload === '')) return
      rows.push({ id: `row-${SyncQueueManager.nextId++}`, itemId: noteId, payload })
    }
    takeNoteBodyRows(noteId: string, limit: number): Array<{ id: string; payload: string }> {
      return SyncQueueManager.rows
        .filter((r) => r.itemId === noteId)
        .slice(0, limit)
        .map(({ id, payload }) => ({ id, payload }))
    }
    hasNoteBody(noteId: string): boolean {
      return SyncQueueManager.rows.some((r) => r.itemId === noteId)
    }
    listNoteBodyNoteIds(): string[] {
      return [...new Set(SyncQueueManager.rows.map((r) => r.itemId))]
    }
    countNoteBodyRows(): number {
      return SyncQueueManager.rows.length
    }
    removeNoteBodyRows(ids: string[]): void {
      SyncQueueManager.rows = SyncQueueManager.rows.filter((r) => !ids.includes(r.id))
    }
    removeNoteBody(noteId: string): number {
      const before = SyncQueueManager.rows.length
      SyncQueueManager.rows = SyncQueueManager.rows.filter((r) => r.itemId !== noteId)
      return before - SyncQueueManager.rows.length
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
    }
  }

  class WebSocketManager {
    disconnect = vi.fn()
    refreshAuth = vi.fn(async () => undefined)
    constructor(public options: unknown) {}
  }

  class SyncWorkerBridge {
    start = vi.fn(async () => undefined)
    stop = vi.fn(async () => undefined)
  }

  const service = (name: string) => ({
    init: vi.fn(() => ({ name })),
    reset: vi.fn()
  })

  return {
    SyncServerError,
    SyncQueueManager,
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
    /** Where the retired pending-note file lives; a fresh temp dir per test. */
    userDataDir: '',
    indexRows: [] as Array<{ id: string; title: string; date: string | null }>,
    currentDevice: { id: 'device-1', signingPublicKey: null as string | null },
    db: null as any,
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
      // `open` is what the issue is about, so it is a plain spy on a fake doc
      // rather than real Y.Doc machinery: the question is WHICH notes it is
      // called for after teardown, not what the doc ends up holding.
      open: vi.fn(async () => ({})),
      pushSnapshotForNote: vi.fn(async () => true),
      readSyncableState: vi.fn(async (_noteId: string) => new Uint8Array([1, 2, 3, 4, 5])),
      validateNoteForCrdt: vi.fn(() => ({ ok: true })),
      isNoteSyncable: vi.fn((_noteId: string) => true),
      isNoteLocalOnly: vi.fn((_noteId: string) => false),
      pushAllSnapshots: vi.fn(),
      destroy: vi.fn(),
      inactiveDocCapacity: 32,
      getDoc: vi.fn(() => undefined),
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
  app: {
    getVersion: vi.fn(() => '1.2.3'),
    // Where the retired crdt-pending-notes.json is imported from.
    getPath: vi.fn(() => runtimeMocks.userDataDir)
  },
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

vi.mock('../database', () => ({ getDatabase: runtimeMocks.getDatabase }))
vi.mock('../database/client', () => ({ getIndexDatabase: runtimeMocks.getIndexDatabase }))

vi.mock('../crypto', () => ({
  getDevicePublicKey: runtimeMocks.deriveDevicePublicKey,
  getOrInitializeLocalVaultKey: runtimeMocks.getOrInitializeLocalVaultKey,
  retrieveKey: runtimeMocks.retrieveKey,
  secureCleanup: runtimeMocks.secureCleanup
}))

vi.mock('../store', () => ({ store: { get: runtimeMocks.storeGet } }))

vi.mock('../agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: runtimeMocks.getOrCreateVaultUuid
}))

vi.mock('../calendar/google/sync-service', () => ({
  syncGoogleCalendarSource: runtimeMocks.syncGoogleCalendarSource
}))

vi.mock('../telemetry/track', () => ({ trackMainEvent: runtimeMocks.trackMainEvent }))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: (...args: unknown[]) => runtimeMocks.logDebug(...args),
    info: (...args: unknown[]) => runtimeMocks.logInfo(...args),
    warn: (...args: unknown[]) => runtimeMocks.logWarn(...args),
    error: (...args: unknown[]) => runtimeMocks.logError(...args)
  })
}))

vi.mock('@memry/sync-client/queue', () => ({
  SyncQueueManager: runtimeMocks.SyncQueueManager,
  NOTE_BODY_FULL_STATE_PAYLOAD: ''
}))
vi.mock('./network', () => ({ NetworkMonitor: runtimeMocks.NetworkMonitor }))
vi.mock('./websocket', () => ({ WebSocketManager: runtimeMocks.WebSocketManager }))

/**
 * The real SyncEngine, with only `start`/`stop` neutered — same trade as the
 * endpoint seam file. `mergeRemoteCrdtForNote` and the CrdtSyncCoordinator it
 * delegates to are the shipped implementation, which is what makes
 * `crdtProvider.open` a real observation of the dangerous call.
 */
vi.mock('./engine', async () => {
  const actual = await vi.importActual<typeof import('./engine')>('./engine')
  class TestSyncEngine extends actual.SyncEngine {
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  }
  return { SyncEngine: TestSyncEngine }
})

vi.mock('../telemetry/diagnostics', () => ({ trackMainError: runtimeMocks.trackMainError }))
vi.mock('./worker-bridge', () => ({ SyncWorkerBridge: runtimeMocks.SyncWorkerBridge }))

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

vi.mock('./item-handlers', () => ({ getRemoteSyncAdapter: runtimeMocks.getRemoteSyncAdapter }))
vi.mock('./device-keys', () => ({ getDeviceSigningKey: runtimeMocks.getDeviceSigningKey }))

vi.mock('./crdt-provider', () => ({
  getCrdtProvider: vi.fn(() => runtimeMocks.crdtProvider),
  resetCrdtProvider: runtimeMocks.resetCrdtProvider
}))

// NOTE: './note-body-outbox' is deliberately NOT mocked. It is one half of the
// seam under test.

vi.mock('./dirty-recovery', () => ({ recoverDirtyItems: runtimeMocks.recoverDirtyItems }))

vi.mock('../billing/paddle-billing', () => ({
  resolveEntitlementForSyncStart: (...args: unknown[]) =>
    runtimeMocks.resolveEntitlementForSyncStart(...args)
}))

vi.mock('./crdt-encrypt', () => ({ encryptCrdtUpdate: runtimeMocks.encryptCrdtUpdate }))

vi.mock('./http-client', () => ({
  postToServer: runtimeMocks.postToServer,
  pushCrdtSnapshot: runtimeMocks.pushCrdtSnapshot,
  pushCrdtFullUpdate: runtimeMocks.pushCrdtFullUpdate,
  getFromServer: runtimeMocks.getFromServer,
  fetchCrdtSnapshot: runtimeMocks.fetchCrdtSnapshot,
  SyncServerError: runtimeMocks.SyncServerError,
  NetworkError: class NetworkError extends Error {},
  RateLimitError: class RateLimitError extends Error {},
  AttachmentTooLargeError: class AttachmentTooLargeError extends Error {}
}))

vi.mock('@memry/sync-client/retry', () => ({
  withRetry: runtimeMocks.withRetry,
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
  checkLocalKeyAgainstAccount: vi.fn().mockResolvedValue('unknown'),
  isKeyMaterialActivityRecent: vi.fn().mockReturnValue(false)
}))

function createDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ get: vi.fn(() => runtimeMocks.currentDevice) }))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ run: vi.fn() })) }))
    }))
  }
}

function createIndexDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ all: vi.fn(() => runtimeMocks.indexRows) }))
      }))
    }))
  }
}

/** Note ids `crdtProvider.open` was actually called for, in order. */
function openedNotes(): string[] {
  return runtimeMocks.crdtProvider.open.mock.calls.map((call) => (call as unknown[])[0] as string)
}

/**
 * Let every pending microtask AND macrotask turn run out.
 *
 * Needed for the negative assertions: "the drain never opened this note" is only
 * worth anything once the drain has had every chance to. A drain that is not
 * aborted reaches `crdtProvider.open` in a handful of turns, so this is far more
 * headroom than it needs.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('full-state flush liveness, stopSyncRuntime to the note-body outbox', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    runtimeMocks.NetworkMonitor.instances = []
    runtimeMocks.SyncQueueManager.rows = []
    runtimeMocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-drain-seam-'))
    runtimeMocks.indexRows = [{ id: 'note-a', title: 'Note A', date: null }]
    runtimeMocks.currentDevice = { id: 'device-1', signingPublicKey: null }
    runtimeMocks.db = createDb()
    runtimeMocks.getDatabase.mockReturnValue(runtimeMocks.db)
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
    runtimeMocks.crdtProvider.seedExistingDocs.mockResolvedValue(0)
    runtimeMocks.crdtProvider.open.mockResolvedValue({})
    runtimeMocks.crdtProvider.pushSnapshotForNote.mockResolvedValue(true)
    runtimeMocks.crdtProvider.validateNoteForCrdt.mockReturnValue({ ok: true })
    runtimeMocks.crdtProvider.isNoteLocalOnly.mockReturnValue(false)
    runtimeMocks.crdtProvider.isNoteSyncable.mockReturnValue(true)
    runtimeMocks.crdtProvider.pushAllSnapshots.mockResolvedValue(0)
    runtimeMocks.crdtProvider.destroy.mockResolvedValue(undefined)
    runtimeMocks.crdtProvider.getDoc.mockReturnValue(undefined)
    runtimeMocks.crdtProvider.closeIfInactive.mockResolvedValue(true)
    runtimeMocks.crdtProvider.getStateVector.mockReturnValue(new Uint8Array([1, 2, 3, 4]))
    runtimeMocks.syncGoogleCalendarSource.mockResolvedValue(undefined)
    runtimeMocks.resolveEntitlementForSyncStart.mockResolvedValue({
      isPaid: true,
      plan: 'plus',
      status: 'active'
    })
    runtimeMocks.getFromServer.mockResolvedValue({ updates: [], hasMore: false })
    runtimeMocks.fetchCrdtSnapshot.mockResolvedValue(null)
  })

  afterEach(() => {
    fs.rmSync(runtimeMocks.userDataDir, { recursive: true, force: true })
  })

  /**
   * Hold the very first per-note snapshot baseline GET. That call sits inside
   * `applyCrdtIncrementals`, immediately after the note is opened, so the drain
   * parks mid-merge on its first note with the rest of the backlog untouched —
   * the exact state a quit or a vault switch catches it in.
   */
  function holdFirstPull(): { reached: Promise<void>; release: () => void } {
    let sawIt!: () => void
    let letGo!: () => void
    const reached = new Promise<void>((resolve) => {
      sawIt = resolve
    })
    const held = new Promise<void>((resolve) => {
      letGo = resolve
    })
    let holding = false
    runtimeMocks.fetchCrdtSnapshot.mockImplementation(async () => {
      if (!holding) {
        holding = true
        sawIt()
        await held
      }
      return null
    })
    return { reached, release: letGo }
  }

  /** What an older build left in userData, imported once by startSyncRuntime. */
  function writeLegacyPendingNotes(noteIds: string[]): void {
    fs.writeFileSync(
      path.join(runtimeMocks.userDataDir, 'crdt-pending-notes.json'),
      JSON.stringify(noteIds)
    )
  }

  const owedNotes = (): string[] => [
    ...new Set(runtimeMocks.SyncQueueManager.rows.map((row) => row.itemId))
  ]

  const pushedBodies = (): string[] =>
    runtimeMocks.postToServer.mock.calls
      .filter((call) => call[0] === '/sync/crdt/updates')
      .map((call) => (call[1] as { noteId: string }).noteId)

  // #2298
  it('pushes the notes an older build left owed, and drops a local-only one instead of retaining it', async () => {
    writeLegacyPendingNotes(['note-local', 'note-a'])
    runtimeMocks.crdtProvider.isNoteLocalOnly.mockImplementation(
      (noteId: string) => noteId === 'note-local'
    )
    runtimeMocks.crdtProvider.isNoteSyncable.mockImplementation(
      (noteId: string) => noteId !== 'note-local'
    )

    const runtime = await import('./runtime')

    // #when the runtime starts on the upgraded build
    await runtime.startSyncRuntime()
    await vi.waitFor(() => expect(owedNotes()).toEqual([]))

    // #then the file is retired, the syncable note is merged and pushed as an
    // update, and the local-only note is neither merged nor pushed
    expect(fs.existsSync(path.join(runtimeMocks.userDataDir, 'crdt-pending-notes.json'))).toBe(
      false
    )
    expect(openedNotes()).toEqual(['note-a'])
    expect(pushedBodies()).toEqual(['note-a'])
    expect(runtimeMocks.crdtProvider.pushSnapshotForNote).not.toHaveBeenCalled()

    await runtime.stopSyncRuntime()
  })

  it('stops merging the rest of the backlog the moment its runtime is torn down', async () => {
    // Two notes an earlier session owed the server: edits made while signed out
    // or offline, whose rows are the only record that the server is owed them.
    writeLegacyPendingNotes(['note-a', 'note-b'])

    const gate = holdFirstPull()
    const runtime = await import('./runtime')

    // #given a runtime whose first full-state flush is mid-pull on note-a
    await runtime.startSyncRuntime()
    await gate.reached
    expect(openedNotes()).toEqual(['note-a'])

    // #when the session is torn down — sign-out, vault switch, quit — which does
    // NOT await the flush
    await runtime.stopSyncRuntime()
    gate.release()
    await settle()

    // #then note-b is never opened on the destroyed provider. `destroy()` nulls
    // persistence, so `open` would build a doc from markdown, apply the server's
    // updates to it and save none of it — into a vault this session may no
    // longer own.
    expect(openedNotes()).toEqual(['note-a'])

    // #and both rows survive: the aborted flush pushed nothing, and a row is
    // only deleted by the ack of a push that landed.
    expect(pushedBodies()).toEqual([])
    expect(owedNotes()).toEqual(['note-a', 'note-b'])
  })

  it('aborts a flush triggered by a reconnect that lands mid-teardown', async () => {
    // The window is real, and it is wide. `stopSyncRuntime` trips the abort
    // early but does not remove the network listener or stop the outbox until
    // after `await pushAllSnapshots()` and `await engine.stop()`. A reconnect
    // in that stretch resumes the outbox, which flushes every queued note.
    const runtime = await import('./runtime')

    // #given a session that started with nothing owed, then went offline
    await runtime.startSyncRuntime()
    await settle()
    expect(openedNotes()).toEqual([])
    const network = runtimeMocks.NetworkMonitor.instances.at(-1)!
    network.listeners.get('status-changed')!({ online: false })

    // #and a note that became owed in full while offline
    new runtimeMocks.SyncQueueManager(null).enqueueNoteBody('note-x', '')

    // #when the device comes back online while teardown is awaiting the
    // pre-shutdown snapshot push
    runtimeMocks.crdtProvider.pushAllSnapshots.mockImplementation(async () => {
      network.listeners.get('status-changed')!({ online: true })
      return 0
    })
    await runtime.stopSyncRuntime()
    await settle()

    // #then the flush that reconnect triggered reads the torn-down runtime's
    // own signal — already tripped — and never opens the note.
    expect(openedNotes()).toEqual([])
    expect(owedNotes()).toEqual(['note-x'])
  })

  it('pushes the surviving backlog under the next runtime, which the old signal must not abort', async () => {
    writeLegacyPendingNotes(['note-a', 'note-b'])

    const gate = holdFirstPull()
    const runtime = await import('./runtime')
    await runtime.startSyncRuntime()
    await gate.reached
    await runtime.stopSyncRuntime()
    gate.release()
    await settle()
    expect(owedNotes()).toEqual(['note-a', 'note-b'])
    runtimeMocks.crdtProvider.open.mockClear()

    // #when the user signs back in, or the next launch starts sync
    await runtime.startSyncRuntime()

    // #then both notes are merged and pushed. A liveness flag kept in module
    // state rather than per runtime would latch on the first teardown and
    // silently strand every backlog for the rest of the process.
    await vi.waitFor(() => expect(owedNotes()).toEqual([]))
    expect(openedNotes()).toEqual(['note-a', 'note-b'])
    expect(pushedBodies()).toEqual(['note-a', 'note-b'])

    await runtime.stopSyncRuntime()
  })
})
