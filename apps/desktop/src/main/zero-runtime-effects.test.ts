import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: null as any,
  indexDb: { kind: 'index-db' },
  dataDb: { kind: 'data-db' },
  handle: vi.fn(),
  removeHandler: vi.fn(),
  getGraphData: vi.fn(),
  getLocalGraph: vi.fn(),
  keytarGet: vi.fn(),
  keytarSet: vi.fn(),
  keytarDelete: vi.fn(),
  updateNoteMetadata: vi.fn(),
  updateNoteCache: vi.fn(),
  attachmentEmitSaved: vi.fn(),
  initForNote: vi.fn(),
  updateMeta: vi.fn(),
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  removePendingNoteSyncItems: vi.fn(),
  publishProjectionEvent: vi.fn(),
  emitCalendarProjectionChanged: vi.fn(),
  scheduleGoogleCalendarSourceSync: vi.fn(),
  settingsQueries: {
    listSavedFilters: vi.fn(),
    getNextSavedFilterPosition: vi.fn(),
    insertSavedFilter: vi.fn(),
    savedFilterExists: vi.fn(),
    updateSavedFilter: vi.fn(),
    getSavedFilterById: vi.fn(),
    deleteSavedFilter: vi.fn(),
    reorderSavedFilters: vi.fn()
  },
  syncControllerOptions: [] as any[],
  syncControllerInstances: [] as any[]
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.handle,
    removeHandler: mocks.removeHandler
  }
}))

vi.mock('keytar', () => ({
  default: {
    getPassword: mocks.keytarGet,
    setPassword: mocks.keytarSet,
    deletePassword: mocks.keytarDelete
  }
}))

vi.mock('@memry/storage-data', () => ({
  updateNoteMetadata: mocks.updateNoteMetadata,
  getNoteMetadataById: vi.fn(() => undefined)
}))

vi.mock('@main/database/queries/notes', () => ({
  updateNoteCache: mocks.updateNoteCache
}))

vi.mock('@main/database/queries/settings', () => mocks.settingsQueries)

vi.mock('./database', () => ({
  getDatabase: () => mocks.db,
  getIndexDatabase: () => mocks.indexDb,
  requireDatabase: () => mocks.db
}))

vi.mock('./database/client', () => ({
  getDatabase: () => mocks.dataDb,
  getIndexDatabase: () => mocks.indexDb
}))

vi.mock('./graph/store', () => ({
  getGraphData: mocks.getGraphData,
  getLocalGraph: mocks.getLocalGraph
}))

vi.mock('./lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('./sync/attachment-events', () => ({
  attachmentEvents: {
    emitSaved: mocks.attachmentEmitSaved
  }
}))

vi.mock('./sync/crdt-provider', () => ({
  getCrdtProvider: () => ({
    initForNote: mocks.initForNote,
    updateMeta: mocks.updateMeta,
    setNoteLocalOnly: vi.fn()
  })
}))

// The CRDT half of the local-only toggle: a body that stopped going up while
// the flag was set is owed to the server as a whole document once it clears.
vi.mock('./sync/crdt-pending-notes', () => ({
  recordPendingCrdtNotes: vi.fn(),
  clearPendingCrdtNotes: vi.fn()
}))

vi.mock('./sync/local-mutations', () => ({
  enqueueLocalSyncCreate: mocks.enqueueLocalSyncCreate,
  enqueueLocalSyncUpdate: mocks.enqueueLocalSyncUpdate,
  enqueueLocalSyncDelete: mocks.enqueueLocalSyncDelete,
  removePendingNoteSyncItems: mocks.removePendingNoteSyncItems
}))

vi.mock('./projections', () => ({
  publishProjectionEvent: mocks.publishProjectionEvent
}))

vi.mock('./calendar/change-events', () => ({
  emitCalendarProjectionChanged: mocks.emitCalendarProjectionChanged
}))

vi.mock('./calendar/google/local-sync-effects', () => ({
  scheduleGoogleCalendarSourceSync: mocks.scheduleGoogleCalendarSourceSync
}))

vi.mock('@memry/shared/utc', () => ({
  utcNow: () => '2026-05-10T09:00:00.000Z'
}))

vi.mock('@memry/sync-core', () => {
  class RecordSyncController {
    options: any
    enqueueCreate = vi.fn()
    enqueueUpdate = vi.fn()
    enqueueDelete = vi.fn()

    constructor(options: any) {
      this.options = options
      mocks.syncControllerOptions.push(options)
      mocks.syncControllerInstances.push(this)
    }
  }

  return {
    RecordSyncController,
    incrementClock: (clock: Record<string, number>, deviceId: string) => ({
      ...clock,
      [deviceId]: (clock[deviceId] ?? 0) + 1
    }),
    withIncrementedClock: (payload: string, deviceId: string) => {
      const parsed = JSON.parse(payload)
      parsed.clock = {
        ...(parsed.clock ?? {}),
        [deviceId]: ((parsed.clock ?? {})[deviceId] ?? 0) + 1
      }
      return JSON.stringify(parsed)
    }
  }
})

function createDb(existing: Record<string, unknown> | null = null) {
  const get = vi.fn(() => existing)
  const run = vi.fn()
  return {
    get,
    run,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ get }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ run }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ run }))
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ run }))
    }))
  }
}

describe('main zero-covered runtime surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.syncControllerOptions = []
    mocks.syncControllerInstances = []
    mocks.db = createDb()
    mocks.getGraphData.mockReturnValue({ nodes: [] })
    mocks.getLocalGraph.mockReturnValue({ nodes: ['local'] })
    mocks.keytarGet.mockResolvedValue(' api-key ')
    mocks.initForNote.mockResolvedValue(undefined)
    mocks.removePendingNoteSyncItems.mockReturnValue(2)
    delete process.env.MEMRY_DEVICE
  })

  it('registers and unregisters graph IPC handlers with database-backed reads', async () => {
    const { GraphChannels } = await import('@memry/contracts/ipc-channels')
    const { registerGraphHandlers, unregisterGraphHandlers } = await import('./ipc/graph-handlers')

    registerGraphHandlers()
    expect(mocks.handle).toHaveBeenCalledWith(
      GraphChannels.invoke.GET_GRAPH_DATA,
      expect.any(Function)
    )
    expect(mocks.handle).toHaveBeenCalledWith(
      GraphChannels.invoke.GET_LOCAL_GRAPH,
      expect.any(Function)
    )

    const getGraph = mocks.handle.mock.calls[0][1]
    const getLocal = mocks.handle.mock.calls[1][1]
    expect(getGraph()).toEqual({ nodes: [] })
    expect(getLocal(null, { noteId: 'note-1' })).toEqual({ nodes: ['local'] })
    expect(mocks.getGraphData).toHaveBeenCalledWith(mocks.indexDb, mocks.dataDb)
    expect(mocks.getLocalGraph).toHaveBeenCalledWith(mocks.indexDb, mocks.dataDb, 'note-1', 2)

    unregisterGraphHandlers()
    expect(mocks.removeHandler).toHaveBeenCalledWith(GraphChannels.invoke.GET_GRAPH_DATA)
    expect(mocks.removeHandler).toHaveBeenCalledWith(GraphChannels.invoke.GET_LOCAL_GRAPH)
  })

  it('wraps voice transcription keychain reads, writes, deletes, and failures', async () => {
    const keychain = await import('./inbox/voice-transcription-keychain')

    await expect(keychain.getVoiceTranscriptionOpenAIApiKey()).resolves.toBe(' api-key ')
    await expect(keychain.hasVoiceTranscriptionOpenAIApiKey()).resolves.toBe(true)
    await keychain.setVoiceTranscriptionOpenAIApiKey('  sk-live  ')
    await keychain.setVoiceTranscriptionOpenAIApiKey('   ')

    expect(mocks.keytarGet).toHaveBeenCalledWith('memry.voice-transcription', 'openai')
    expect(mocks.keytarSet).toHaveBeenCalledWith('memry.voice-transcription', 'openai', 'sk-live')
    expect(mocks.keytarDelete).toHaveBeenCalledWith('memry.voice-transcription', 'openai')

    process.env.MEMRY_DEVICE = 'mac'
    await keychain.setVoiceTranscriptionOpenAIApiKey('sk-device')
    expect(mocks.keytarSet).toHaveBeenCalledWith(
      'memry.voice-transcription',
      'openai-mac',
      'sk-device'
    )

    mocks.keytarGet.mockRejectedValueOnce(new Error('locked'))
    await expect(keychain.getVoiceTranscriptionOpenAIApiKey()).rejects.toThrow(
      'Failed to read voice transcription API key: locked'
    )
  })

  it('syncs note runtime side effects for CRDT metadata, attachments, and local-only state', async () => {
    const notes = await import('./notes/runtime-effects')

    notes.syncNoteCreate('note-1', 'Title', ['tag'])
    notes.syncNoteUpdate('note-1', 'Renamed')
    notes.syncNoteUpdate('note-2')
    notes.syncNoteDelete('note-1')
    notes.emitNoteAttachmentSaved('note-1', 'files/a.pdf')
    notes.setNoteLocalOnlyState('note-1', true)
    notes.setNoteLocalOnlyState('note-1', false)

    expect(mocks.enqueueLocalSyncCreate).toHaveBeenCalledWith('note', 'note-1')
    expect(mocks.initForNote).toHaveBeenCalledWith('note-1', { title: 'Title' }, ['tag'])
    expect(mocks.updateMeta).toHaveBeenCalledWith('note-1', { title: 'Renamed' })
    expect(mocks.enqueueLocalSyncDelete).toHaveBeenCalledWith('note', 'note-1')
    expect(mocks.attachmentEmitSaved).toHaveBeenCalledWith({
      noteId: 'note-1',
      diskPath: 'files/a.pdf'
    })
    expect(mocks.updateNoteMetadata).toHaveBeenCalledWith(mocks.db, 'note-1', {
      localOnly: true,
      syncPolicy: 'local-only'
    })
    expect(mocks.removePendingNoteSyncItems).toHaveBeenCalledWith('note-1')
    expect(mocks.enqueueLocalSyncUpdate).toHaveBeenCalledWith('note', 'note-1')
  })

  it('publishes inbox and tag runtime side effects', async () => {
    const inbox = await import('./inbox/runtime-effects')
    const tags = await import('./tags/runtime-effects')

    inbox.syncInboxCreate('inbox-1')
    inbox.syncInboxUpdate('inbox-1')
    inbox.syncInboxDelete('inbox-1', '{"id":"inbox-1"}')
    inbox.publishInboxUpserted('inbox-2')

    tags.syncTaggedNote('note-1')
    tags.syncTagDefinitionRename('Old', ' New ', { name: 'Old' })
    tags.syncTagDefinitionRename('Ignored', 'Ignored2')
    tags.syncTagDefinitionUpdate('tag')
    tags.syncTagDefinitionDelete('Tag', { name: 'Tag' })
    tags.syncMergedTagDefinitions('source', 'target', { name: 'source' })
    tags.syncTaggedTasks(['task-1', 'task-2'])

    expect(mocks.publishProjectionEvent).toHaveBeenCalledWith({
      type: 'inbox.deleted',
      itemId: 'inbox-1'
    })
    expect(mocks.emitCalendarProjectionChanged).toHaveBeenCalledWith('inbox:inbox-1')
    expect(mocks.scheduleGoogleCalendarSourceSync).toHaveBeenCalledWith({
      sourceType: 'inbox_snooze',
      sourceId: 'inbox-1'
    })
    expect(mocks.enqueueLocalSyncCreate).toHaveBeenCalledWith('tag_definition', 'new')
    expect(mocks.enqueueLocalSyncDelete).toHaveBeenCalledWith(
      'tag_definition',
      'tag',
      '{"name":"Tag"}'
    )
    expect(mocks.enqueueLocalSyncCreate).not.toHaveBeenCalledWith('tag_definition', 'Ignored2')
    expect(mocks.enqueueLocalSyncUpdate).toHaveBeenCalledWith('task', 'task-2')
  })

  it('syncs folder config create, update, rename, and delete mutations', async () => {
    const effects = await import('./notes/folder-config-effects')

    mocks.db = createDb(null)
    effects.syncFolderConfigSet('notes/work', 'briefcase')
    expect(mocks.db.insert).toHaveBeenCalled()
    expect(mocks.enqueueLocalSyncCreate).toHaveBeenCalledWith('folder_config', 'notes/work')

    mocks.db = createDb({ path: 'notes/work', icon: 'briefcase', clock: { device: 1 } })
    effects.syncFolderConfigSet('notes/work', undefined)
    effects.syncFolderConfigRename('notes/work', 'notes/personal')
    effects.syncFolderConfigDelete('notes/personal')

    expect(mocks.db.update).toHaveBeenCalled()
    expect(mocks.db.delete).toHaveBeenCalled()
    expect(mocks.enqueueLocalSyncUpdate).toHaveBeenCalledWith('folder_config', 'notes/work')
    expect(mocks.enqueueLocalSyncDelete).toHaveBeenCalledWith(
      'folder_config',
      'notes/work',
      JSON.stringify({ path: 'notes/work', icon: 'briefcase', clock: { device: 1 } })
    )
    expect(mocks.enqueueLocalSyncCreate).toHaveBeenCalledWith('folder_config', 'notes/personal')
  })

  it('records attachment metadata and delegates saved-filter store calls', async () => {
    const attachmentMetadata = await import('./sync/note-attachment-metadata')
    const store = await import('./settings/saved-filters-store')

    attachmentMetadata.recordUploadedAttachment('note-1', 'att-1')
    attachmentMetadata.recordDownloadedFileSize('note-1', 42)

    expect(mocks.updateNoteCache).toHaveBeenCalledWith(mocks.indexDb, 'note-1', {
      attachmentId: 'att-1'
    })
    expect(mocks.updateNoteMetadata).toHaveBeenCalledWith(mocks.db, 'note-1', {
      attachmentId: 'att-1',
      attachmentReferences: ['att-1']
    })
    expect(mocks.updateNoteCache).toHaveBeenCalledWith(mocks.indexDb, 'note-1', { fileSize: 42 })

    const filter = { id: 'filter-1' }
    store.listSavedFilters(mocks.db)
    store.getNextSavedFilterPosition(mocks.db)
    store.insertSavedFilter(mocks.db, filter as never)
    store.savedFilterExists(mocks.db, 'filter-1')
    store.updateSavedFilter(mocks.db, 'filter-1', filter as never)
    store.getSavedFilterById(mocks.db, 'filter-1')
    store.deleteSavedFilter(mocks.db, 'filter-1')
    store.reorderSavedFilters(mocks.db, ['a'], [1])

    expect(mocks.settingsQueries.listSavedFilters).toHaveBeenCalledWith(mocks.db)
    expect(mocks.settingsQueries.insertSavedFilter).toHaveBeenCalledWith(mocks.db, filter)
    expect(mocks.settingsQueries.reorderSavedFilters).toHaveBeenCalledWith(mocks.db, ['a'], [1])
  })

  it('initializes record sync controllers for tag and calendar sync services', async () => {
    const tagSync = await import('@memry/sync-client/tag-definition-sync')
    const sourceSync = await import('@memry/sync-client/calendar-source-sync')
    const bindingSync = await import('@memry/sync-client/calendar-binding-sync')
    const externalSync = await import('@memry/sync-client/calendar-external-event-sync')

    const deps = { queue: { enqueue: vi.fn() }, db: mocks.db, getDeviceId: () => 'device-1' }
    const services = [
      tagSync.initTagDefinitionSyncService(deps as never),
      sourceSync.initCalendarSourceSyncService(deps as never),
      bindingSync.initCalendarBindingSyncService(deps as never),
      externalSync.initCalendarExternalEventSyncService(deps as never)
    ]

    services.forEach((service: any, index) => {
      service.enqueueCreate(`item-${index}`)
      service.enqueueUpdate(`item-${index}`)
      service.enqueueDelete(`item-${index}`, '{"id":"item","clock":{}}')
    })

    expect(tagSync.getTagDefinitionSyncService()).toBe(services[0])
    expect(sourceSync.getCalendarSourceSyncService()).toBe(services[1])
    expect(bindingSync.getCalendarBindingSyncService()).toBe(services[2])
    expect(externalSync.getCalendarExternalEventSyncService()).toBe(services[3])
    expect(mocks.syncControllerOptions.map((option) => option.type)).toEqual([
      'tag_definition',
      'calendar_source',
      'calendar_binding',
      'calendar_external_event'
    ])
    expect(mocks.syncControllerInstances[0].enqueueDelete).toHaveBeenCalledWith(
      'item-0',
      '{"id":"item","clock":{}}'
    )

    const tagPayload = mocks.syncControllerOptions[0].buildDeletePayload({
      itemId: 'tag-a',
      extra: [],
      deviceId: 'device-1'
    })
    expect(JSON.parse(tagPayload)).toEqual({
      name: 'tag-a',
      color: '',
      clock: { 'device-1': 1 }
    })

    const sourcePayload = mocks.syncControllerOptions[1].buildDeletePayload({
      itemId: 'source-1',
      local: { id: 'source-1', clock: {} },
      extra: [],
      deviceId: 'device-1'
    })
    expect(JSON.parse(sourcePayload)).toEqual({
      id: 'source-1',
      clock: { 'device-1': 1 }
    })

    tagSync.resetTagDefinitionSyncService()
    sourceSync.resetCalendarSourceSyncService()
    bindingSync.resetCalendarBindingSyncService()
    externalSync.resetCalendarExternalEventSyncService()
    expect(tagSync.getTagDefinitionSyncService()).toBeNull()
    expect(sourceSync.getCalendarSourceSyncService()).toBeNull()
  })
})
