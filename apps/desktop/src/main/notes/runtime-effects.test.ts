import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  initForNote: vi.fn(async () => ({}) as never),
  setNoteLocalOnly: vi.fn(),
  purge: vi.fn(async () => undefined),
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  removePendingNoteSyncItems: vi.fn(),
  recordPendingCrdtNotes: vi.fn(),
  clearPendingCrdtNotes: vi.fn()
}))

vi.mock('../sync/crdt-provider', () => ({
  getCrdtProvider: () => ({
    initForNote: mocks.initForNote,
    setNoteLocalOnly: mocks.setNoteLocalOnly,
    purge: mocks.purge
  })
}))

vi.mock('../sync/crdt-pending-notes', () => ({
  recordPendingCrdtNotes: mocks.recordPendingCrdtNotes,
  clearPendingCrdtNotes: mocks.clearPendingCrdtNotes
}))

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: mocks.enqueueLocalSyncCreate,
  enqueueLocalSyncDelete: mocks.enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate: mocks.enqueueLocalSyncUpdate,
  removePendingNoteSyncItems: mocks.removePendingNoteSyncItems
}))

vi.mock('@memry/storage-data', () => ({ updateNoteMetadata: vi.fn() }))
vi.mock('@main/database/queries/notes', () => ({ updateNoteCache: vi.fn() }))
vi.mock('../database', () => ({ getDatabase: vi.fn(), getIndexDatabase: vi.fn() }))
vi.mock('@memry/sync-client/attachment-events', () => ({ attachmentEvents: { emit: vi.fn() } }))
vi.mock('../tasks/domain', () => ({ createDesktopTasksDomain: vi.fn() }))
vi.mock('../tasks/publisher', () => ({ createTasksPublisher: vi.fn() }))
vi.mock('../lib/id', () => ({ generateId: vi.fn(() => 'generated-id') }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))

import { setNoteLocalOnlyState, syncNoteCreate, syncNoteDelete } from './runtime-effects'

describe('syncNoteCreate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('gives a new note a CRDT doc and a sync item by default', () => {
    // #when
    syncNoteCreate('note-1', 'Title', ['alpha'])

    // #then
    expect(mocks.initForNote).toHaveBeenCalledWith('note-1', { title: 'Title' }, ['alpha'])
    expect(mocks.enqueueLocalSyncCreate).toHaveBeenCalledWith('note', 'note-1')
  })

  it('skips the CRDT doc when the caller says the file is large-file class', () => {
    // #when — what the vault watcher does for a log dump
    syncNoteCreate('big-note', 'Server Log', [], { sizeClass: 'large-file' })

    // #then — no Y.Doc, so the BlockNote markdown parse never starts
    expect(mocks.initForNote).not.toHaveBeenCalled()
  })

  it('enqueues no sync item for a large-file-class file', () => {
    // #given a large-file-class file has no CRDT body, so the row another
    // device would draw from a note sync item could never be opened there. A
    // row that cannot be opened is worse than no row at all.
    syncNoteCreate('big-note', 'Server Log', [], { sizeClass: 'large-file' })

    // #then
    expect(mocks.enqueueLocalSyncCreate).not.toHaveBeenCalled()
  })

  it('still enqueues a note-class file for sync', () => {
    // #then the guard must cost note-class files nothing
    syncNoteCreate('note-1', 'Title', ['alpha'], { sizeClass: 'note' })

    expect(mocks.enqueueLocalSyncCreate).toHaveBeenCalledWith('note', 'note-1')
    expect(mocks.initForNote).toHaveBeenCalledWith('note-1', { title: 'Title' }, ['alpha'])
  })
})

describe('setNoteLocalOnlyState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('tells the CRDT provider, so an open doc stops pushing its body immediately', () => {
    // The provider caches the flag per open doc — `onDocUpdate` runs per
    // keystroke and cannot afford a database read — so without this the note
    // keeps pushing until it is closed and reopened.
    setNoteLocalOnlyState('note-1', true)

    expect(mocks.setNoteLocalOnly).toHaveBeenCalledWith('note-1', true)
    expect(mocks.removePendingNoteSyncItems).toHaveBeenCalledWith('note-1')
    expect(mocks.clearPendingCrdtNotes).toHaveBeenCalledWith(['note-1'])
    expect(mocks.recordPendingCrdtNotes).not.toHaveBeenCalled()
  })

  it('owes the server the whole body again when local-only is cleared', () => {
    // The metadata `update` this raises carries `content: null`, and the push
    // coordinator only pushes a CRDT snapshot for `operation === 'create'`. So
    // without the pending record the note would resume syncing its metadata
    // with its body frozen wherever the server last saw it.
    setNoteLocalOnlyState('note-1', false)

    expect(mocks.setNoteLocalOnly).toHaveBeenCalledWith('note-1', false)
    expect(mocks.enqueueLocalSyncUpdate).toHaveBeenCalledWith('note', 'note-1')
    expect(mocks.recordPendingCrdtNotes).toHaveBeenCalledWith(['note-1'])
    expect(mocks.clearPendingCrdtNotes).not.toHaveBeenCalled()
  })
})

describe('syncNoteDelete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("purges the note's CRDT doc, so nothing downstream can rebuild the note from it", async () => {
    // A doc left in the provider's map is swept every 5 minutes, pulled with a
    // network origin, and written back — and with no index row left, write-back
    // re-creates the note in the default folder.
    syncNoteDelete('note-1')
    await vi.waitFor(() => expect(mocks.purge).toHaveBeenCalledWith('note-1'))
  })

  it('enqueues the tombstone before the doc is purged', () => {
    syncNoteDelete('note-1')

    expect(mocks.enqueueLocalSyncDelete).toHaveBeenCalledWith('note', 'note-1')
    expect(mocks.enqueueLocalSyncDelete.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.purge.mock.invocationCallOrder[0]
    )
  })

  it('drops the note from the pending-CRDT set the replay drains', () => {
    // The drain merges remote state per pending id, which is a second route
    // into the same write-back that re-creates the note.
    syncNoteDelete('note-1')

    expect(mocks.clearPendingCrdtNotes).toHaveBeenCalledWith(['note-1'])
  })
})
