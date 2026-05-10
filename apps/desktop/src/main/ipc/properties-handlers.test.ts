import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PropertiesChannels } from '@memry/contracts/properties-api'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()

  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: unknown, input?: unknown) => unknown) => {
        handlers.set(channel, handler)
      }),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel))
    },
    getDatabase: vi.fn(() => ({ id: 'data-db' })),
    getIndexDatabase: vi.fn(() => ({ id: 'index-db' })),
    getNoteProperties: vi.fn(),
    getNoteCacheById: vi.fn(),
    getJournalEntryByDate: vi.fn(),
    updateNote: vi.fn(),
    readJournalEntry: vi.fn(),
    writeJournalEntryWithContent: vi.fn(),
    getJournalRelativePath: vi.fn((date: string) => `Journal/${date}.md`),
    getCanonicalJournalByDate: vi.fn(),
    enqueueJournalUpdate: vi.fn(),
    syncNoteUpdate: vi.fn(),
    syncJournalCache: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: mocks.ipcMain
}))

vi.mock('../database', () => ({
  getDatabase: mocks.getDatabase,
  getIndexDatabase: mocks.getIndexDatabase
}))

vi.mock('../notes/store', () => ({
  getNoteProperties: mocks.getNoteProperties,
  getNoteCacheById: mocks.getNoteCacheById,
  getJournalEntryByDate: mocks.getJournalEntryByDate
}))

vi.mock('../vault/notes', () => ({
  updateNote: mocks.updateNote
}))

vi.mock('../vault/journal', () => ({
  readJournalEntry: mocks.readJournalEntry,
  writeJournalEntryWithContent: mocks.writeJournalEntryWithContent,
  getJournalRelativePath: mocks.getJournalRelativePath
}))

vi.mock('@memry/domain-notes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@memry/domain-notes')>()),
  getCanonicalJournalByDate: mocks.getCanonicalJournalByDate
}))

vi.mock('../journal/runtime-effects', () => ({
  enqueueJournalUpdate: mocks.enqueueJournalUpdate
}))

vi.mock('../notes/runtime-effects', () => ({
  syncNoteUpdate: mocks.syncNoteUpdate
}))

vi.mock('../vault/journal-cache-sync', () => ({
  syncJournalCache: mocks.syncJournalCache
}))

vi.mock('../lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() })
}))

import { registerPropertiesHandlers, unregisterPropertiesHandlers } from './properties-handlers'

async function invoke(channel: string, input?: unknown) {
  const handler = mocks.handlers.get(channel)
  expect(handler, `missing handler for ${channel}`).toBeTypeOf('function')
  return handler?.({}, input)
}

describe('properties IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.getNoteProperties.mockReturnValue([
      { name: 'Status', value: 'Draft', type: 'text' },
      { name: 'Owner', value: 'Kaan', type: 'text' }
    ])
    mocks.getNoteCacheById.mockReturnValue({ id: 'note-1', path: 'Notes/note.md' })
    mocks.updateNote.mockResolvedValue(undefined)
    mocks.readJournalEntry.mockResolvedValue({
      id: 'journal-cache-id',
      content: 'Today',
      tags: ['journal'],
      path: 'Journal/2026-05-10.md'
    })
    mocks.writeJournalEntryWithContent.mockResolvedValue({
      entry: { id: 'written-journal-id', content: 'Today' },
      fileContent: '---\nStatus: Draft\n---\nToday',
      frontmatter: { Status: 'Draft' }
    })
    mocks.getCanonicalJournalByDate.mockReturnValue({ id: 'canonical-journal-id' })
    mocks.getJournalEntryByDate.mockReturnValue({ id: 'cached-journal-id' })
  })

  it('registers get/set/rename handlers and removes them during cleanup', () => {
    registerPropertiesHandlers()

    expect(mocks.ipcMain.handle).toHaveBeenCalledWith(
      PropertiesChannels.invoke.GET,
      expect.any(Function)
    )
    expect(mocks.ipcMain.handle).toHaveBeenCalledWith(
      PropertiesChannels.invoke.SET,
      expect.any(Function)
    )
    expect(mocks.ipcMain.handle).toHaveBeenCalledWith(
      PropertiesChannels.invoke.RENAME,
      expect.any(Function)
    )

    unregisterPropertiesHandlers()

    expect(mocks.ipcMain.removeHandler).toHaveBeenCalledWith(PropertiesChannels.invoke.GET)
    expect(mocks.ipcMain.removeHandler).toHaveBeenCalledWith(PropertiesChannels.invoke.SET)
    expect(mocks.ipcMain.removeHandler).toHaveBeenCalledWith(PropertiesChannels.invoke.RENAME)
  })

  it('gets note properties and routes note property updates through note storage and sync', async () => {
    registerPropertiesHandlers()

    await expect(invoke(PropertiesChannels.invoke.GET, { entityId: 'note-1' })).resolves.toEqual([
      { name: 'Status', value: 'Draft', type: 'text' },
      { name: 'Owner', value: 'Kaan', type: 'text' }
    ])
    expect(mocks.getNoteProperties).toHaveBeenCalledWith({ id: 'index-db' }, 'note-1')

    await expect(
      invoke(PropertiesChannels.invoke.SET, {
        entityId: 'note-1',
        properties: { Status: 'Done' }
      })
    ).resolves.toEqual({ success: true })

    expect(mocks.updateNote).toHaveBeenCalledWith({
      id: 'note-1',
      properties: { Status: 'Done' }
    })
    expect(mocks.syncNoteUpdate).toHaveBeenCalledWith('note-1')
  })

  it('routes journal property updates through journal file write and cache sync', async () => {
    registerPropertiesHandlers()
    mocks.getNoteCacheById.mockReturnValue({
      id: 'journal-cache-id',
      date: '2026-05-10',
      path: 'Journal/2026-05-10.md'
    })

    await expect(
      invoke(PropertiesChannels.invoke.SET, {
        entityId: 'journal-cache-id',
        properties: { Status: 'Draft' }
      })
    ).resolves.toEqual({ success: true })

    expect(mocks.writeJournalEntryWithContent).toHaveBeenCalledWith(
      '2026-05-10',
      'Today',
      ['journal'],
      expect.objectContaining({ id: 'journal-cache-id' }),
      { Status: 'Draft' }
    )
    expect(mocks.syncJournalCache).toHaveBeenCalledWith(
      { id: 'index-db' },
      expect.objectContaining({
        id: 'canonical-journal-id',
        path: 'Journal/2026-05-10.md',
        parsedContent: 'Today'
      }),
      { isNew: false }
    )
    expect(mocks.enqueueJournalUpdate).toHaveBeenCalledWith('journal-cache-id', '2026-05-10')
  })

  it('renames properties with missing, duplicate, note, and journal outcomes', async () => {
    registerPropertiesHandlers()

    mocks.getNoteCacheById.mockReturnValueOnce(null)
    await expect(
      invoke(PropertiesChannels.invoke.SET, { entityId: 'missing', properties: {} })
    ).resolves.toEqual({ success: false, error: 'Entity not found' })

    mocks.getNoteCacheById.mockReturnValue({ id: 'note-1', path: 'Notes/note.md' })
    await expect(
      invoke(PropertiesChannels.invoke.RENAME, {
        entityId: 'note-1',
        oldName: 'Missing',
        newName: 'Stage'
      })
    ).resolves.toEqual({ success: false, error: 'Property "Missing" not found' })

    await expect(
      invoke(PropertiesChannels.invoke.RENAME, {
        entityId: 'note-1',
        oldName: 'Status',
        newName: 'Owner'
      })
    ).resolves.toEqual({ success: false, error: 'Property "Owner" already exists' })

    await expect(
      invoke(PropertiesChannels.invoke.RENAME, {
        entityId: 'note-1',
        oldName: 'Status',
        newName: 'Stage'
      })
    ).resolves.toEqual({ success: true })
    expect(mocks.updateNote).toHaveBeenLastCalledWith({
      id: 'note-1',
      properties: { Stage: 'Draft', Owner: 'Kaan' }
    })

    mocks.getNoteCacheById.mockReturnValue({
      id: 'journal-cache-id',
      date: '2026-05-10',
      path: 'Journal/2026-05-10.md'
    })
    await expect(
      invoke(PropertiesChannels.invoke.RENAME, {
        entityId: 'journal-cache-id',
        oldName: 'Status',
        newName: 'Stage'
      })
    ).resolves.toEqual({ success: true })
    expect(mocks.enqueueJournalUpdate).toHaveBeenLastCalledWith('journal-cache-id', '2026-05-10')
  })
})
