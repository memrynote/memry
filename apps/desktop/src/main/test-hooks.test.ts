import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const windowSendMock = vi.fn()
const browserWindows = [{ isDestroyed: () => false, webContents: { send: windowSendMock } }]
const storeGetMock = vi.fn(() => ({ existing: true }))
const storeSetMock = vi.fn()
const persistKeysAndRegisterDeviceMock = vi.fn(async () => 'device-1')
const yDocToMarkdownMock = vi.fn(async () => '# Note')
const crdtDestroyMock = vi.fn(async () => undefined)
const getDocMock = vi.fn((noteId: string) => (noteId === 'missing' ? null : { id: noteId }))
const getCrdtProviderMock = vi.fn(() => ({
  getDoc: getDocMock,
  destroy: crdtDestroyMock
}))
const resetCrdtProviderMock = vi.fn()
const getWritebackDebugStateMock = vi.fn(() => ({ pending: false }))
const networkSetOnlineMock = vi.fn()
const outstandingCountMock = vi.fn(() => 3)
const getNetworkMonitorMock = vi.fn(() => ({ setOnlineForTests: networkSetOnlineMock }))
const getCrdtQueueMock = vi.fn(() => ({ getOutstandingCount: outstandingCountMock }))
const startSyncRuntimeMock = vi.fn(async () => ({}))
const getOrInitializeLocalVaultKeyMock = vi.fn(async () => new Uint8Array([1]))
const getOrCreateVaultUuidMock = vi.fn(() => 'vault-1')
const resetVaultUuidCacheMock = vi.fn()
const dbRunMock = vi.fn()
const dbGetMock = vi.fn(() => ({ id: 'project-1' }))
const insertRunMock = vi.fn()
const valuesMock = vi.fn(() => ({ run: insertRunMock }))
const dbInsertMock = vi.fn(() => ({ values: valuesMock }))
const getDatabaseMock = vi.fn(() => ({
  get: dbGetMock,
  run: dbRunMock,
  insert: dbInsertMock
}))
const getNoteMetadataByIdMock = vi.fn(() => ({ id: 'note-1' }))
const storeGoogleCalendarRefreshTokenMock = vi.fn(async () => undefined)
const upsertCalendarSourceMock = vi.fn()
const writeCalendarGoogleSettingsMock = vi.fn()
const getGooglePushRuntimeMock = vi.fn(() => ({ getActiveChannelCount: vi.fn(() => 2) }))
const startGoogleCalendarSyncRunnerMock = vi.fn(async () => undefined)
const syncGoogleCalendarSourceMock = vi.fn(async () => undefined)
const pushSourceToGoogleCalendarMock = vi.fn(async () => ({
  remoteCalendarId: 'primary',
  remoteEventId: 'remote-1',
  remoteVersion: 'etag-1'
}))
const listCalendarExternalEventsBySourceMock = vi.fn(() => [
  {
    id: 'external-1',
    remoteEventId: 'google-1',
    title: 'Imported',
    startAt: '2026-05-10T09:00:00.000Z',
    endAt: null
  }
])
const translateMock = vi.fn((key: string) => `t:${key}`)

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => browserWindows)
  }
}))

vi.mock('./store', () => ({
  store: {
    get: storeGetMock,
    set: storeSetMock
  }
}))

vi.mock('./sync/device-registration', () => ({
  persistKeysAndRegisterDevice: persistKeysAndRegisterDeviceMock
}))

vi.mock('./sync/blocknote-converter', () => ({
  yDocToMarkdown: yDocToMarkdownMock
}))

vi.mock('./sync/crdt-provider', () => ({
  getCrdtProvider: getCrdtProviderMock,
  resetCrdtProvider: resetCrdtProviderMock
}))

vi.mock('./sync/crdt-writeback', () => ({
  getWritebackDebugState: getWritebackDebugStateMock
}))

vi.mock('./sync/runtime', () => ({
  getCrdtQueue: getCrdtQueueMock,
  getNetworkMonitor: getNetworkMonitorMock,
  startSyncRuntime: startSyncRuntimeMock
}))

vi.mock('./crypto/vault-key-state', () => ({
  getOrInitializeLocalVaultKey: getOrInitializeLocalVaultKeyMock,
  VAULT_KEY_VERIFIER_SETTING: 'vault.crypto.verifier.v1'
}))

vi.mock('./agent/storage/vault-id', () => ({
  getOrCreateVaultUuid: getOrCreateVaultUuidMock,
  resetVaultUuidCache: resetVaultUuidCacheMock
}))

vi.mock('./database', () => ({
  getDatabase: getDatabaseMock
}))

vi.mock('@memry/storage-data', () => ({
  getNoteMetadataById: getNoteMetadataByIdMock
}))

vi.mock('./calendar/google/keychain', () => ({
  storeGoogleCalendarRefreshToken: storeGoogleCalendarRefreshTokenMock
}))

vi.mock('./calendar/repositories/calendar-sources-repository', () => ({
  upsertCalendarSource: upsertCalendarSourceMock
}))

vi.mock('./calendar/google/calendar-google-settings', () => ({
  writeCalendarGoogleSettings: writeCalendarGoogleSettingsMock
}))

vi.mock('./calendar/google/push-runtime', () => ({
  getGooglePushRuntime: getGooglePushRuntimeMock
}))

vi.mock('./calendar/google/google-sync-runner', () => ({
  startGoogleCalendarSyncRunner: startGoogleCalendarSyncRunnerMock
}))

vi.mock('./calendar/google/sync-service', () => ({
  syncGoogleCalendarSource: syncGoogleCalendarSourceMock,
  pushSourceToGoogleCalendar: pushSourceToGoogleCalendarMock
}))

vi.mock('./calendar/repositories/calendar-external-events-repository', () => ({
  listCalendarExternalEventsBySource: listCalendarExternalEventsBySourceMock
}))

vi.mock('@memry/db-schema/schema/calendar-events', () => ({
  calendarEvents: {}
}))

vi.mock('./lib/main-i18n', () => ({
  getMainI18n: vi.fn(() => ({ t: translateMock }))
}))

const ORIGINAL_ENV = { ...process.env }
const originalFetch = globalThis.fetch

async function importHooks() {
  return import('./test-hooks')
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init?.headers }
  })
}

describe('main test hooks', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env = { ...ORIGINAL_ENV }
    globalThis.__memryTestHooks = undefined
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/events') && init?.method === 'POST') {
        return jsonResponse({ id: 'inserted-event' })
      }
      if (url.includes('/events/') && init?.method !== 'DELETE') {
        return jsonResponse({
          id: 'remote-1',
          summary: 'Remote event',
          start: { dateTime: '2026-05-10T09:00:00.000Z' },
          end: { dateTime: '2026-05-10T10:00:00.000Z' }
        })
      }
      if (url.includes('/token')) return jsonResponse({ access_token: 'access-token' })
      if (url.includes('/calendars/primary')) {
        return jsonResponse({
          id: 'owner@example.com',
          summary: 'Owner Calendar',
          timeZone: 'Europe/Istanbul',
          backgroundColor: '#2563eb'
        })
      }
      return jsonResponse({ id: 'inserted-event' })
    }) as typeof fetch
    dbGetMock.mockReturnValue({ id: 'project-1' })
    getNetworkMonitorMock.mockReturnValue({ setOnlineForTests: networkSetOnlineMock })
    getCrdtQueueMock.mockReturnValue({ getOutstandingCount: outstandingCountMock })
    getGooglePushRuntimeMock.mockReturnValue({ getActiveChannelCount: vi.fn(() => 2) })
    pushSourceToGoogleCalendarMock.mockResolvedValue({
      remoteCalendarId: 'primary',
      remoteEventId: 'remote-1',
      remoteVersion: 'etag-1'
    })
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    globalThis.fetch = originalFetch
    globalThis.__memryTestHooks = undefined
  })

  it('does not register hooks outside test mode', async () => {
    process.env.NODE_ENV = 'production'
    const { registerTestHooks } = await importHooks()

    registerTestHooks()

    expect(globalThis.__memryTestHooks).toBeUndefined()
  })

  it('registers sync and CRDT helpers in test mode', async () => {
    process.env.NODE_ENV = 'test'
    const { registerTestHooks } = await importHooks()

    registerTestHooks()
    const hooks = globalThis.__memryTestHooks!

    await expect(
      hooks.bootstrapSyncDevice({
        email: 'user@example.com',
        setupToken: 'setup',
        masterKeyBase64: Buffer.from('master-key').toString('base64'),
        signingSecretKeyBase64: Buffer.from('signing-key').toString('base64'),
        kdfSalt: 'salt',
        keyVerifier: 'verifier'
      })
    ).resolves.toEqual({ deviceId: 'device-1' })
    expect(storeSetMock).toHaveBeenCalledWith(
      'sync',
      expect.objectContaining({
        email: 'user@example.com',
        recoveryPhraseConfirmed: true
      })
    )
    expect(dbRunMock).toHaveBeenCalled()
    // The hook rewrites vault_metadata on the already-open handle, so the
    // handle-keyed vault-uuid cache has to be dropped or every later call site
    // (registration, vault key, request header) keeps the pre-bootstrap id.
    expect(resetVaultUuidCacheMock).toHaveBeenCalled()
    expect(getOrInitializeLocalVaultKeyMock).toHaveBeenCalled()
    expect(startSyncRuntimeMock).toHaveBeenCalled()

    await hooks.setNetworkOnlineForTests(false)
    expect(networkSetOnlineMock).toHaveBeenCalledWith(false)
    await expect(hooks.getCrdtPendingCount()).resolves.toBe(3)
    await expect(hooks.getCrdtDocMarkdown('note-1')).resolves.toBe('# Note')
    await expect(hooks.getCrdtDocMarkdown('missing')).resolves.toBeNull()
    await expect(hooks.hasNoteOnDevice('note-1')).resolves.toEqual({
      recordPresent: true,
      crdtPresent: true,
      crdtBody: '# Note'
    })
    await expect(hooks.getWritebackDebugState('note-1')).resolves.toEqual({ pending: false })

    await hooks.simulateCrdtTeardownForTests()
    expect(crdtDestroyMock).toHaveBeenCalled()
    expect(resetCrdtProviderMock).toHaveBeenCalled()
  })

  it('reports sync runtime missing states', async () => {
    process.env.NODE_ENV = 'test'
    getNetworkMonitorMock.mockReturnValue(null)
    getCrdtQueueMock.mockReturnValue(null)
    const { registerTestHooks } = await importHooks()

    registerTestHooks()
    const hooks = globalThis.__memryTestHooks!

    await expect(hooks.setNetworkOnlineForTests(true)).rejects.toThrow(
      'Sync runtime is not initialized'
    )
    await expect(hooks.getCrdtPendingCount()).resolves.toBe(0)
  })

  it('seeds calendar projections and broadcasts renderer invalidations', async () => {
    process.env.NODE_ENV = 'test'
    const { registerTestHooks } = await importHooks()

    registerTestHooks()
    await globalThis.__memryTestHooks!.seedCalendarProjection({
      day: '2026-05-10',
      importedTitle: 'Imported',
      taskTitle: 'Task',
      reminderTitle: 'Reminder',
      snoozeTitle: 'Snoozed',
      overlapMemryTitle: 'memrynote overlap'
    })

    expect(dbGetMock).toHaveBeenCalled()
    expect(dbRunMock).toHaveBeenCalledTimes(6)
    // A seeded Google source must carry an answer to the one-time agent-access
    // question, or the calendar opens behind a modal the specs cannot dismiss.
    expect(writeCalendarGoogleSettingsMock).toHaveBeenCalledWith(expect.anything(), {
      agentReadEventsConsent: false
    })
    expect(windowSendMock).toHaveBeenCalledWith(
      expect.stringContaining('calendar'),
      expect.objectContaining({ id: 'calendar-e2e-external' })
    )
    expect(windowSendMock).toHaveBeenCalledWith(
      expect.stringContaining('tasks'),
      expect.objectContaining({ task: { id: 'calendar-e2e-task' } })
    )
  })

  it('throws when calendar projection seeding has no default project', async () => {
    process.env.NODE_ENV = 'test'
    dbGetMock.mockReturnValue(null)
    const { registerTestHooks } = await importHooks()

    registerTestHooks()

    await expect(
      globalThis.__memryTestHooks!.seedCalendarProjection({
        day: '2026-05-10',
        importedTitle: 'Imported',
        taskTitle: 'Task',
        reminderTitle: 'Reminder',
        snoozeTitle: 'Snoozed'
      })
    ).rejects.toThrow('No default project available')
  })

  it('seeds and exercises Google calendar E2E hooks', async () => {
    process.env.NODE_ENV = 'test'
    const { registerTestHooks } = await importHooks()

    registerTestHooks()
    const hooks = globalThis.__memryTestHooks!

    await hooks.seedGoogleCalendarTokens({
      refreshToken: 'refresh',
      clientId: 'client',
      clientSecret: null
    })
    expect(process.env.GOOGLE_CALENDAR_CLIENT_ID).toBe('client')
    expect(storeGoogleCalendarRefreshTokenMock).toHaveBeenCalledWith({
      accountId: 'owner@example.com',
      refreshToken: 'refresh'
    })

    await expect(hooks.getGooglePushChannelProbe()).resolves.toEqual({ activeCount: 2 })
    await expect(hooks.connectGoogleCalendarForE2E()).resolves.toEqual({
      accountId: 'owner@example.com',
      accountSourceId: 'google-account:owner@example.com',
      calendarSourceId: 'google-calendar:owner@example.com',
      primaryCalendarId: 'owner@example.com'
    })
    expect(upsertCalendarSourceMock).toHaveBeenCalledTimes(2)
    expect(startGoogleCalendarSyncRunnerMock).toHaveBeenCalled()
    // Standing in for the connect flow includes standing in for its answer to
    // the one-time agent-access question.
    expect(writeCalendarGoogleSettingsMock).toHaveBeenCalledWith(expect.anything(), {
      agentReadEventsConsent: false
    })

    await hooks.syncGoogleCalendarSourceForE2E({ sourceId: 'source-1' })
    expect(syncGoogleCalendarSourceMock).toHaveBeenCalledWith(expect.any(Object), 'source-1')

    await expect(hooks.listCalendarExternalEventsForE2E({ sourceId: 'source-1' })).resolves.toEqual(
      [
        {
          id: 'external-1',
          remoteEventId: 'google-1',
          title: 'Imported',
          startAt: '2026-05-10T09:00:00.000Z',
          endAt: null
        }
      ]
    )

    await expect(
      hooks.createGoogleCalendarEventForE2E({
        calendarId: 'primary',
        summary: 'Created',
        startMs: Date.UTC(2026, 4, 10, 9),
        endMs: Date.UTC(2026, 4, 10, 10)
      })
    ).resolves.toBe('inserted-event')
    await expect(
      hooks.deleteGoogleCalendarEventForE2E({ calendarId: 'primary', eventId: 'remote-1' })
    ).resolves.toBeUndefined()
    await expect(
      hooks.fetchGoogleEventForE2E({ calendarId: 'primary', eventId: 'remote-1' })
    ).resolves.toEqual({
      id: 'remote-1',
      summary: 'Remote event',
      start: { dateTime: '2026-05-10T09:00:00.000Z' },
      end: { dateTime: '2026-05-10T10:00:00.000Z' }
    })
  })

  it('exercises memrynote write-back and translation hooks', async () => {
    process.env.NODE_ENV = 'test'
    const { registerTestHooks } = await importHooks()

    registerTestHooks()
    const hooks = globalThis.__memryTestHooks!

    await expect(
      hooks.createMemryEventForWriteBackE2E({
        title: 'Local event',
        startMs: Date.UTC(2026, 4, 10, 9),
        endMs: Date.UTC(2026, 4, 10, 10),
        targetCalendarId: 'primary'
      })
    ).resolves.toEqual({ sourceId: expect.stringMatching(/^calendar-writeback-e2e:/) })
    expect(dbInsertMock).toHaveBeenCalled()
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Local event' }))

    await expect(hooks.pushMemryEventToGoogleForE2E({ sourceId: 'local-1' })).resolves.toEqual({
      remoteCalendarId: 'primary',
      remoteEventId: 'remote-1',
      remoteVersion: 'etag-1'
    })
    await expect(hooks.translateInMain('menu.file')).resolves.toBe('t:menu.file')
  })

  it('guards Google hooks when credentials or remote identifiers are missing', async () => {
    process.env.NODE_ENV = 'test'
    const { registerTestHooks } = await importHooks()

    registerTestHooks()
    const hooks = globalThis.__memryTestHooks!

    await expect(hooks.connectGoogleCalendarForE2E()).rejects.toThrow(
      'Google E2E credentials not seeded'
    )

    await hooks.seedGoogleCalendarTokens({
      refreshToken: 'refresh',
      clientId: 'client',
      clientSecret: 'secret'
    })
    pushSourceToGoogleCalendarMock.mockResolvedValueOnce({
      remoteCalendarId: null,
      remoteEventId: null,
      remoteVersion: null
    })

    await expect(hooks.pushMemryEventToGoogleForE2E({ sourceId: 'local-1' })).rejects.toThrow(
      'without remote identifiers'
    )
  })
})
