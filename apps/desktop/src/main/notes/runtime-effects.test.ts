import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  initForNote: vi.fn(async () => ({}) as never),
  enqueueLocalSyncCreate: vi.fn()
}))

vi.mock('../sync/crdt-provider', () => ({
  getCrdtProvider: () => ({ initForNote: mocks.initForNote })
}))

vi.mock('../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: mocks.enqueueLocalSyncCreate,
  enqueueLocalSyncDelete: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  removePendingNoteSyncItems: vi.fn()
}))

vi.mock('@memry/storage-data', () => ({ updateNoteMetadata: vi.fn() }))
vi.mock('@main/database/queries/notes', () => ({ updateNoteCache: vi.fn() }))
vi.mock('../database', () => ({ getDatabase: vi.fn(), getIndexDatabase: vi.fn() }))
vi.mock('../sync/attachment-events', () => ({ attachmentEvents: { emit: vi.fn() } }))
vi.mock('../tasks/domain', () => ({ createDesktopTasksDomain: vi.fn() }))
vi.mock('../tasks/publisher', () => ({ createTasksPublisher: vi.fn() }))
vi.mock('../lib/id', () => ({ generateId: vi.fn(() => 'generated-id') }))
vi.mock('../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))

import { syncNoteCreate } from './runtime-effects'

describe('syncNoteCreate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('gives a new note a CRDT doc by default', () => {
    // #when
    syncNoteCreate('note-1', 'Title', ['alpha'])

    // #then
    expect(mocks.initForNote).toHaveBeenCalledWith('note-1', { title: 'Title' }, ['alpha'])
  })

  it('skips the CRDT doc when the caller says the file is large-file class', () => {
    // #when — what the vault watcher does for a log dump
    syncNoteCreate('big-note', 'Server Log', [], { initCrdt: false })

    // #then — no Y.Doc, so the BlockNote markdown parse never starts
    expect(mocks.initForNote).not.toHaveBeenCalled()
  })

  it('still enqueues the note for sync when the CRDT doc is skipped', () => {
    // #given large-file class is a body decision, not a "forget this file"
    // decision — #1461 is what stops it syncing.
    syncNoteCreate('big-note', 'Server Log', [], { initCrdt: false })

    // #then
    expect(mocks.enqueueLocalSyncCreate).toHaveBeenCalledWith('note', 'big-note')
  })
})
