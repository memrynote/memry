/**
 * Folder view IPC handlers tests
 *
 * @module ipc/folder-view-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { FolderViewChannels } from '@memry/contracts/ipc-channels'
import { noteCache, noteTags, noteProperties } from '@memry/db-schema/schema/notes-cache'
import { createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'

const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    })
  }
}))

vi.mock('../database', () => ({
  getIndexDatabase: vi.fn()
}))

vi.mock('../vault/folders', () => ({
  readFolderConfig: vi.fn(),
  writeFolderConfig: vi.fn()
}))

vi.mock('../inbox/suggestions', () => ({
  getNoteFolderSuggestions: vi.fn()
}))

import { registerFolderViewHandlers, unregisterFolderViewHandlers } from './folder-view-handlers'
import { getIndexDatabase } from '../database'
import * as folderFiles from '../vault/folders'
import * as suggestions from '../inbox/suggestions'

describe('folder-view-handlers', () => {
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0

    indexDb = createTestIndexDb()
    ;(getIndexDatabase as Mock).mockReturnValue(indexDb.db)
  })

  afterEach(() => {
    unregisterFolderViewHandlers()
    indexDb.close()
  })

  it('returns default config and views when none exist', async () => {
    registerFolderViewHandlers()
    ;(folderFiles.readFolderConfig as Mock).mockResolvedValue(null)

    const config = await invokeHandler(FolderViewChannels.invoke.GET_CONFIG, {
      folderPath: 'projects'
    })
    expect(config.isDefault).toBe(true)
    expect(config.config.views).toHaveLength(1)

    const views = await invokeHandler(FolderViewChannels.invoke.GET_VIEWS, {
      folderPath: 'projects'
    })
    expect(views.views).toHaveLength(1)
    expect(views.defaultIndex).toBe(0)
  })

  it('sets config and returns success', async () => {
    registerFolderViewHandlers()
    ;(folderFiles.readFolderConfig as Mock).mockResolvedValue({ views: [] })

    const result = await invokeHandler(FolderViewChannels.invoke.SET_CONFIG, {
      folderPath: 'projects',
      config: { views: [] }
    })
    expect(result).toEqual({ success: true })
    expect(folderFiles.writeFolderConfig).toHaveBeenCalled()
  })

  it('adds or updates a view and enforces default selection', async () => {
    registerFolderViewHandlers()
    ;(folderFiles.readFolderConfig as Mock).mockResolvedValue({
      views: [{ name: 'Default', type: 'table', default: true }]
    })

    const result = await invokeHandler(FolderViewChannels.invoke.SET_VIEW, {
      folderPath: 'projects',
      view: { name: 'Kanban', type: 'kanban', default: true }
    })

    expect(result).toEqual({ success: true })
    expect(folderFiles.writeFolderConfig).toHaveBeenCalledWith(
      'projects',
      expect.objectContaining({
        views: [
          expect.objectContaining({ name: 'Default', default: false }),
          expect.objectContaining({ name: 'Kanban', default: true })
        ]
      })
    )
  })

  it('deletes views and restores defaults as needed', async () => {
    registerFolderViewHandlers()
    ;(folderFiles.readFolderConfig as Mock).mockResolvedValue({
      views: [{ name: 'Only', type: 'table', default: true }]
    })
    const deleteAll = await invokeHandler(FolderViewChannels.invoke.DELETE_VIEW, {
      folderPath: 'projects',
      viewName: 'Only'
    })
    expect(deleteAll).toEqual({ success: true })
    expect(folderFiles.writeFolderConfig).toHaveBeenCalledWith(
      'projects',
      expect.objectContaining({ views: undefined })
    )
    ;(folderFiles.readFolderConfig as Mock).mockResolvedValue({
      views: [
        { name: 'Default', type: 'table', default: true },
        { name: 'Alt', type: 'list', default: false }
      ]
    })
    const deleteDefault = await invokeHandler(FolderViewChannels.invoke.DELETE_VIEW, {
      folderPath: 'projects',
      viewName: 'Default'
    })
    expect(deleteDefault).toEqual({ success: true })
    expect(folderFiles.writeFolderConfig).toHaveBeenCalledWith(
      'projects',
      expect.objectContaining({
        views: [expect.objectContaining({ name: 'Alt', default: true })]
      })
    )
  })

  it('lists notes with tags and properties', async () => {
    registerFolderViewHandlers()

    const now = new Date().toISOString()
    indexDb.db
      .insert(noteCache)
      .values({
        id: 'note-1',
        path: 'notes/projects/2024/note.md',
        title: 'Note',
        contentHash: 'hash',
        wordCount: 5,
        characterCount: 20,
        createdAt: now,
        modifiedAt: now
      })
      .run()

    indexDb.db
      .insert(noteTags)
      .values({
        noteId: 'note-1',
        tag: 'alpha',
        pinnedAt: null
      })
      .run()

    indexDb.db
      .insert(noteProperties)
      .values({
        noteId: 'note-1',
        name: 'status',
        value: JSON.stringify('open'),
        type: 'text'
      })
      .run()

    const result = await invokeHandler(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, {
      folderPath: 'projects',
      properties: ['status'],
      limit: 10,
      offset: 0
    })

    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]?.folder).toBe('/2024')
    expect(result.notes[0]?.tags).toEqual(['alpha'])
    expect(result.notes[0]?.properties).toEqual({ status: 'open' })
  })

  it('returns available properties and folder suggestions', async () => {
    registerFolderViewHandlers()

    const now = new Date().toISOString()
    indexDb.db
      .insert(noteCache)
      .values({
        id: 'note-2',
        path: 'notes/projects/note.md',
        title: 'Note',
        contentHash: 'hash',
        wordCount: 2,
        characterCount: 10,
        createdAt: now,
        modifiedAt: now
      })
      .run()
    indexDb.db
      .insert(noteProperties)
      .values({
        noteId: 'note-2',
        name: 'priority',
        value: JSON.stringify(1),
        type: 'number'
      })
      .run()
    ;(folderFiles.readFolderConfig as Mock).mockResolvedValue({ formulas: { score: '1+1' } })
    const props = await invokeHandler(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, {
      folderPath: 'projects'
    })
    expect(props.properties).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'priority', type: 'number' })])
    )
    ;(suggestions.getNoteFolderSuggestions as Mock).mockResolvedValue([
      { path: 'projects', confidence: 0.5, reason: 'History' }
    ])
    const suggestionResult = await invokeHandler(FolderViewChannels.invoke.GET_FOLDER_SUGGESTIONS, {
      noteId: 'note-2'
    })
    expect(suggestionResult.suggestions).toHaveLength(1)
  })
})
