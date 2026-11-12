import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { z } from 'zod'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { noteBodySync } from '@memry/db-schema/schema/note-body-sync'
import type { DataDb } from '../database'
import type { NoteBodyOutbox } from './note-body-outbox'
import type { SnapshotBatchPushFn, SnapshotPushFn } from './crdt-provider'
import type * as Runtime from './runtime'
import type * as BodyPush from './note-body-push'

// Only platform/session infrastructure is substituted. The runtime's body push,
// outbox, SQLite queue, snapshot senders, retries, auth retry and HTTP stay real.
const fixture = vi.hoisted(() => ({
  db: null as DataDb | null,
  pendingPushes: new Set<Promise<void>>(),
  fetch: vi.fn<typeof fetch>(),
  getToken: vi.fn<() => Promise<string | null>>(),
  getKey: vi.fn<() => Promise<Uint8Array | null>>(),
  refresh: vi.fn<() => Promise<boolean>>(),
  encrypt: vi.fn<(raw: Uint8Array) => Uint8Array>(),
  provider: {
    init: vi.fn<
      (outbox: NoteBodyOutbox, single: SnapshotPushFn, batch: SnapshotBatchPushFn) => Promise<void>
    >(),
    setSyncPaused: vi.fn(),
    setSnapshotCoverage: vi.fn(),
    setOweRemoteMerge: vi.fn(),
    setRemoteMerge: vi.fn(),
    setSnapshotDeferral: vi.fn(),
    isNoteLocalOnly: () => false,
    isNoteSyncable: () => true,
    recordPushedSnapshot: vi.fn(async () => undefined),
    readSyncableState: vi.fn(async () => new Uint8Array([0, 0])),
    seedExistingDocs: vi.fn(async () => 0),
    pushSnapshotForNote: vi.fn(async () => false),
    pushSnapshotsForNotes: vi.fn<(ids: string[]) => Promise<Map<string, boolean>>>(),
    pushAllSnapshots: vi.fn<(signal?: AbortSignal) => Promise<number>>(),
    destroy: vi.fn(async () => undefined)
  }
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-memry-backpressure-test', getVersion: () => '99.0.0' },
  net: { fetch: (...args: Parameters<typeof fetch>) => fixture.fetch(...args) },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('libsodium-wrappers-sumo', () => ({ default: {} }))
vi.mock('../database', () => ({ getDatabase: () => fixture.db }))
vi.mock('../database/client', () => ({
  getIndexDatabase: () => ({
    select: () => ({ from: () => ({ where: () => ({ all: () => [] }) }) })
  })
}))
vi.mock('../crypto', () => ({
  getDevicePublicKey: () => new Uint8Array(32),
  getOrInitializeLocalVaultKey: async () => new Uint8Array(32),
  retrieveKey: () => fixture.getKey(),
  secureCleanup: vi.fn()
}))
vi.mock('../lib/main-i18n', () => ({ getMainI18n: () => ({ t: (key: string) => key }) }))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))
vi.mock('../store', () => ({ store: { get: () => ({}) }, getCurrentVaultPath: () => null }))
vi.mock('../agent/storage/vault-id', () => ({ getOrCreateVaultUuid: () => 'test-vault' }))
vi.mock('../billing/paddle-billing', () => ({
  resolveEntitlementForSyncStart: async () => ({ isPaid: true })
}))
vi.mock('../calendar/google/sync-service', () => ({ syncGoogleCalendarSource: vi.fn() }))
vi.mock('../calendar/calendar-settings-sync', () => ({
  initSettingsSync: () => ({}),
  resetSettingsSyncManager: vi.fn()
}))
vi.mock('../home/cover-service', () => ({
  reconcileHomeCovers: vi.fn(),
  requireVaultPath: () => ''
}))
vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
vi.mock('@memry/sync-core', () => ({
  createCrdtSyncAdapter: () => ({}),
  createSyncAdapterRegistry: () => ({})
}))
vi.mock('./crdt-provider', () => ({
  getCrdtProvider: () => fixture.provider,
  resetCrdtProvider: vi.fn()
}))
vi.mock('./crdt-encrypt', () => ({ encryptCrdtUpdate: (raw: Uint8Array) => fixture.encrypt(raw) }))
vi.mock('./token-manager', () => ({
  retrieveToken: async () => 'refresh-token',
  getValidAccessToken: () => fixture.getToken(),
  refreshAccessToken: () => fixture.refresh(),
  setOnTokenRefreshed: vi.fn()
}))
vi.mock('./device-registration', () => ({ ensureDeviceRowForVault: vi.fn() }))
vi.mock('./device-keys', () => ({ getDeviceSigningKey: vi.fn() }))
vi.mock('./dirty-recovery', () => ({ recoverDirtyItems: vi.fn() }))
vi.mock('./key-verification', () => ({
  checkLocalKeyAgainstAccount: async () => 'unknown',
  isKeyMaterialActivityRecent: () => false
}))
vi.mock('./keychain-retry', () => ({ pauseForKeychain: () => false }))
vi.mock('./vault-account-binding', () => ({
  applyOpenVaultBinding: async () => 'start',
  scheduleBindingRetry: vi.fn(),
  cancelBindingRetry: vi.fn(),
  resetVaultBindingState: vi.fn()
}))
vi.mock('./vault-index-ready', () => ({ waitForVaultIndexBuild: async () => undefined }))
vi.mock('./network', () => ({
  NetworkMonitor: class {
    online = true
    start = vi.fn()
    stop = vi.fn()
    on = vi.fn()
    removeListener = vi.fn()
  }
}))
vi.mock('./websocket', () => ({
  WebSocketManager: class {
    disconnect = vi.fn()
    refreshAuth = vi.fn(async () => undefined)
  }
}))
vi.mock('./worker-bridge', () => ({
  SyncWorkerBridge: class {
    start = vi.fn(async () => undefined)
    stop = vi.fn(async () => undefined)
  }
}))
vi.mock('./engine', () => ({
  SyncEngine: class {
    start = vi.fn(async () => undefined)
    stop = vi.fn(async () => undefined)
    requestCancel = vi.fn()
    requestPush = vi.fn()
    isPaused() {
      return false
    }
    isCaughtUpWithServer() {
      return false
    }
    isDeviceRevoked() {
      return false
    }
    hasUnmergedRemoteCrdtState() {
      return false
    }
    snapshotCoverage() {
      return { unmerged: false }
    }
    async mergeRemoteCrdtForNote() {
      return true
    }
    oweCrdtPull = vi.fn()
    recordSnapshotRefusal = vi.fn()
    markCrdtRemoteStateUnmerged = vi.fn()
    clearCrdtUnmergedForDroppedNote = vi.fn()
  }
}))
vi.mock('./item-handlers', () => ({ getRemoteSyncAdapter: () => ({}) }))
vi.mock('./attachment-outbox', () => ({ resetAttachmentQueue: vi.fn() }))
vi.mock('./attachment-download-redriver', () => ({
  stopAttachmentDownloadRedriver: vi.fn(),
  startAttachmentDownloadRedriver: vi.fn(),
  redriveAttachmentDownloads: async () => undefined
}))
vi.mock('./attachment-upload-redriver', () => ({
  attachmentUploadRedriver: { start: vi.fn(), stop: vi.fn(), redrive: async () => undefined }
}))
vi.mock('./deleted-asset-release-runner', () => ({
  deletedAssetReleaseRunner: { start: vi.fn(), stop: vi.fn() }
}))
vi.mock('@memry/sync-client/task-sync', () => ({
  initTaskSyncService: () => ({}),
  resetTaskSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/inbox-sync', () => ({
  initInboxSyncService: () => ({}),
  resetInboxSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/filter-sync', () => ({
  initFilterSyncService: () => ({}),
  resetFilterSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/task-activity-sync', () => ({
  initTaskActivitySyncService: () => ({}),
  resetTaskActivitySyncService: vi.fn()
}))
vi.mock('@memry/sync-client/bookmark-sync', () => ({
  initBookmarkSyncService: () => ({}),
  resetBookmarkSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/template-sync', () => ({
  initTemplateSyncService: () => ({}),
  resetTemplateSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/home-page-sync', () => ({
  initHomePageSyncService: () => ({}),
  resetHomePageSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/custom-icon-sync', () => ({
  initCustomIconSyncService: () => ({}),
  resetCustomIconSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/vault-lock-sync', () => ({
  initVaultLockSyncService: () => ({}),
  resetVaultLockSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/sticky-draft-sync', () => ({
  initStickyDraftSyncService: () => ({}),
  resetStickyDraftSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/reminder-sync', () => ({
  initReminderSyncService: () => ({}),
  resetReminderSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/canvas-sync', () => ({
  initCanvasSyncService: () => ({}),
  resetCanvasSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/canvas-folder-sync', () => ({
  initCanvasFolderSyncService: () => ({}),
  resetCanvasFolderSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/project-sync', () => ({
  initProjectSyncService: () => ({}),
  resetProjectSyncService: vi.fn()
}))
vi.mock('./note-sync', () => ({ initNoteSyncService: () => ({}), resetNoteSyncService: vi.fn() }))
vi.mock('./journal-sync', () => ({
  initJournalSyncService: () => ({}),
  resetJournalSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/tag-definition-sync', () => ({
  initTagDefinitionSyncService: () => ({}),
  resetTagDefinitionSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/property-definition-sync', () => ({
  initPropertyDefinitionSyncService: () => ({}),
  resetPropertyDefinitionSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/tag-category-sync', () => ({
  initTagCategorySyncService: () => ({}),
  resetTagCategorySyncService: vi.fn()
}))
vi.mock('@memry/sync-client/folder-config-sync', () => ({
  initFolderConfigSyncService: () => ({}),
  resetFolderConfigSyncService: vi.fn()
}))
vi.mock('./calendar-event-sync', () => ({
  initCalendarEventSyncService: () => ({}),
  resetCalendarEventSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/calendar-source-sync', () => ({
  initCalendarSourceSyncService: () => ({}),
  resetCalendarSourceSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/calendar-binding-sync', () => ({
  initCalendarBindingSyncService: () => ({}),
  resetCalendarBindingSyncService: vi.fn()
}))
vi.mock('@memry/sync-client/calendar-external-event-sync', () => ({
  initCalendarExternalEventSyncService: () => ({}),
  resetCalendarExternalEventSyncService: vi.fn()
}))

const snapshotBody = z.object({ snapshots: z.array(z.object({ noteId: z.string() })) })
const updateBody = z.object({ noteId: z.string() })
const json = (body: unknown, status = 200, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })

async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn++) await nextTurn()
}

function localUpdate(): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('body').insert(0, 'imported markdown')
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

describe('runtime CRDT backpressure through durable SQLite and HTTP', () => {
  let data: TestDatabaseResult
  let runtime: typeof Runtime
  let outbox: NoteBodyOutbox
  const cleanups: Array<() => void> = []

  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    })
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'))
    vi.resetModules()
    vi.clearAllMocks()
    // New callback identities keep a failed burst's late continuations out of
    // the next case's counters. Module factories capture these, not the holder.
    const getToken = (fixture.getToken = vi.fn(async () => 'access-token'))
    const getKey = (fixture.getKey = vi.fn(async () => new Uint8Array(64)))
    const refresh = (fixture.refresh = vi.fn(async () => false))
    const encrypt = (fixture.encrypt = vi.fn((raw: Uint8Array) => raw))
    const fetch = (fixture.fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ sequenceNum: 1, revision: 'r1' })
    ))
    vi.doMock('electron', () => ({
      app: { getPath: () => '/nonexistent-memry-backpressure-test', getVersion: () => '99.0.0' },
      net: { fetch },
      BrowserWindow: { getAllWindows: () => [] }
    }))
    vi.doMock('./crdt-encrypt', () => ({ encryptCrdtUpdate: encrypt }))
    // Recreate the instrumented real sender with this case's module graph;
    // resetModules alone does not invalidate a hoisted mock factory's cache.
    vi.doMock('./note-body-push', async (importOriginal) => {
      const actual = await importOriginal<typeof BodyPush>()
      return {
        ...actual,
        createNoteBodyPush: (deps: Parameters<typeof actual.createNoteBodyPush>[0]) => {
          const push = actual.createNoteBodyPush(deps)
          return (...args: Parameters<typeof push>) => {
            const pending = push(...args)
            fixture.pendingPushes.add(pending)
            return pending.finally(() => fixture.pendingPushes.delete(pending))
          }
        }
      }
    })
    vi.doMock('../crypto', () => ({
      getDevicePublicKey: () => new Uint8Array(32),
      getOrInitializeLocalVaultKey: async () => new Uint8Array(32),
      retrieveKey: getKey,
      secureCleanup: vi.fn()
    }))
    vi.doMock('./token-manager', () => ({
      retrieveToken: async () => 'refresh-token',
      getValidAccessToken: getToken,
      refreshAccessToken: refresh,
      setOnTokenRefreshed: vi.fn()
    }))
    fixture.provider.init.mockResolvedValue(undefined)
    fixture.provider.pushAllSnapshots.mockReset().mockResolvedValue(0)
    fixture.provider.pushSnapshotsForNotes.mockReset().mockResolvedValue(new Map())
    data = createTestDataDb()
    const db = (fixture.db = asClientDb(data.db))
    vi.doMock('../database', () => ({ getDatabase: () => db }))
    vi.stubEnv('SYNC_SERVER_URL', 'http://sync.test')
    // Import after module reset so the runtime and all HTTP callers share state.
    runtime = await import('./runtime')
    await runtime.startSyncRuntime()
    const live = runtime.getNoteBodyOutbox()
    if (!live) throw new Error('Runtime did not create its real NoteBodyOutbox')
    outbox = live
    // Resolve the adapter's lazy imports before advancing the virtual clock.
    const http = await import('./http-client')
    await http.getSyncVaultHeaders()
  })

  afterEach(async () => {
    outbox?.stop()
    await runtime?.stopSyncRuntime({ skipFinalSync: true })
    for (const cleanup of cleanups.splice(0)) cleanup()
    await Promise.allSettled(fixture.pendingPushes)
    await settle()
    await vi.advanceTimersByTimeAsync(0)
    await settle()
    vi.clearAllTimers()
    vi.useRealTimers()
    data?.close()
    fixture.db = null
    vi.unstubAllEnvs()
  })

  it('returns a 429 body failure to its durable owner immediately without acknowledging it', async () => {
    fixture.fetch.mockImplementation(async () => json({}, 429, { 'Retry-After': '60' }))
    outbox.enqueue('limited-note', localUpdate())
    await settle()

    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    expect(outbox.getOutstandingCount()).toBe(1)
    const record = data.db.select().from(noteBodySync).get()
    // A private retry loop would leave this note merely "sent" for minutes.
    expect(record?.lastFailedAt).toBeTypeOf('number')
    expect(record?.lastConfirmedAt).toBeNull()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(fixture.fetch).toHaveBeenCalledTimes(1)
    expect(outbox.getOutstandingCount()).toBe(1)
  })

  it('bounds pre-encryption work and uses one wakeup for a 1606-note deferred backlog', async () => {
    const { getActiveRuntime } = await import('./runtime-state')
    const active = getActiveRuntime()
    if (!active) throw new Error('No live runtime queue')
    const rowReads = vi.spyOn(active.queue, 'takeNoteBodyRows')
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    fixture.fetch.mockImplementation(async () => {
      await pending
      return json({}, 429, { 'Retry-After': '60' })
    })
    cleanups.push(() => release())
    const update = localUpdate()
    for (let index = 0; index < 1606; index++) outbox.enqueue(`bulk-${index}`, update)
    await settle()

    expect(outbox.getOutstandingCount()).toBe(1606)
    // The bound is before merge/encrypt, not merely before the socket opens.
    expect(rowReads.mock.calls.length).toBeLessThanOrEqual(4)
    expect(fixture.encrypt.mock.calls.length).toBeGreaterThan(0)
    expect(fixture.encrypt.mock.calls.length).toBeLessThanOrEqual(4)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1)

    release()
    await settle()
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
    expect(outbox.getOutstandingCount()).toBe(1606)
  })

  it.each(['single', 'batch'] as const)(
    'returns a %s snapshot 429 promptly and never records it as stored',
    async (kind) => {
      fixture.fetch.mockImplementation(async () => json({}, 429, { 'Retry-After': '60' }))
      const [, single, batch] = fixture.provider.init.mock.calls[0]
      let settled = false
      let outcome: unknown
      const attempt = (
        kind === 'single'
          ? single('snapshot-note', localUpdate(), { unmerged: false })
          : batch([
              { noteId: 'snapshot-note', state: localUpdate(), coverage: { unmerged: false } }
            ])
      ).then(
        (value) => {
          settled = true
          outcome = value
          return undefined
        },
        (error: unknown) => {
          settled = true
          outcome = error
          return undefined
        }
      )
      await settle()

      expect(fixture.fetch).toHaveBeenCalledTimes(1)
      expect(settled).toBe(true)
      const { RateLimitError } = await import('./http-client')
      const expected = {
        single: expect.any(RateLimitError),
        batch: new Map([['snapshot-note', false]])
      }
      expect(outcome).toEqual(expected[kind])
      expect(fixture.provider.recordPushedSnapshot).not.toHaveBeenCalled()
      expect(data.db.select().from(noteBodySync).all()).toEqual([])
      await attempt
    }
  )

  it('rearms refused snapshots after a finite bulk drains without another edit or reconnect', async () => {
    const stored = new Set<string>()
    const snapshotsAvailableAt = Date.now() + 90_000
    fixture.fetch.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = new URL(url).pathname
      if (path === '/sync/crdt/snapshot/batch') {
        if (Date.now() < snapshotsAvailableAt) return json({}, 429, { 'Retry-After': '5' })
        if (typeof init?.body !== 'string') throw new Error('Snapshot request has no JSON body')
        const body = snapshotBody.parse(JSON.parse(init.body))
        for (const { noteId } of body.snapshots) stored.add(noteId)
        return json({
          results: body.snapshots.map(({ noteId }) => ({
            noteId,
            accepted: true,
            sequenceNum: 1,
            revision: 'r1'
          }))
        })
      }
      return json({ sequenceNum: 1 })
    })
    fixture.provider.pushSnapshotsForNotes.mockImplementation(async (ids) => {
      // Provider encoding is not under test; delivery comes from the runtime's
      // actual batched sender, including the actual retry/auth/HTTP adapters.
      const [, , batch] = fixture.provider.init.mock.calls[0]
      return batch(
        ids.map((noteId) => ({ noteId, state: localUpdate(), coverage: { unmerged: false } }))
      )
    })
    const ids = Array.from({ length: 12 }, (_, index) => `finite-${index}`)
    for (const id of ids) outbox.enqueue(id, localUpdate())
    await vi.advanceTimersByTimeAsync(30_000)
    await settle()
    expect(outbox.getOutstandingCount()).toBe(0)

    // Every inline retry has failed before admission becomes available again.
    // No new writes, reconnects or manual scheduling occur after the bulk.
    await vi.advanceTimersByTimeAsync(180_000)
    await settle()
    expect([...stored].toSorted()).toEqual(ids.toSorted())
  })

  it.each(['token', 'signing-key'] as const)(
    'does not encrypt, send or acknowledge a body whose %s await outlives its runtime',
    async (credential) => {
      let release!: () => void
      if (credential === 'token') {
        fixture.getToken.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () => resolve('old-session-token')
            })
        )
      } else {
        fixture.getKey.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () => resolve(new Uint8Array(64))
            })
        )
      }
      cleanups.push(() => release?.())
      outbox.enqueue('old-session-note', localUpdate())
      await settle()
      expect(fixture.encrypt).not.toHaveBeenCalled()
      await runtime.stopSyncRuntime({ skipFinalSync: true })

      release()
      await settle()
      expect(fixture.encrypt).not.toHaveBeenCalled()
      expect(fixture.fetch).not.toHaveBeenCalled()
      expect(outbox.getOutstandingCount()).toBe(1)
    }
  )

  it('aborts a body HTTP request in flight and leaves its SQLite row queued on stop', async () => {
    let signal: AbortSignal | null | undefined
    let release!: (response: Response) => void
    fixture.fetch.mockImplementation((_input, init) => {
      signal = init?.signal
      return new Promise<Response>((resolve, reject) => {
        release = resolve
        const abort = (): void => {
          const reason: unknown = signal?.reason
          reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'))
        }
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    })
    cleanups.push(() => release?.(json({ sequenceNum: 1 })))
    outbox.enqueue('in-flight-note', localUpdate())
    await settle()
    expect(fixture.fetch).toHaveBeenCalledTimes(1)

    await runtime.stopSyncRuntime({ skipFinalSync: true })
    await settle()
    expect(signal?.aborted).toBe(true)
    expect(outbox.getOutstandingCount()).toBe(1)
    expect(data.db.select().from(noteBodySync).get()?.lastConfirmedAt).toBeNull()
  })

  it('still delivers the intentional final snapshot after background body work is aborted', async () => {
    const delivered: string[] = []
    fixture.fetch.mockImplementation(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Snapshot request has no JSON body')
      delivered.push(updateBody.parse(JSON.parse(init.body)).noteId)
      return json({ sequenceNum: 1, revision: 'quit-r1' })
    })
    fixture.provider.pushAllSnapshots.mockImplementationOnce(async () => {
      const [, single] = fixture.provider.init.mock.calls[0]
      await single('quit-note', localUpdate(), { unmerged: false })
      return 1
    })

    await runtime.stopSyncRuntime({ finalSyncTimeoutMs: 5000 })
    expect(delivered).toEqual(['quit-note'])
    expect(fixture.provider.recordPushedSnapshot).toHaveBeenCalledWith('quit-note', {
      sequenceNum: 1,
      revision: 'quit-r1'
    })
  })
})
