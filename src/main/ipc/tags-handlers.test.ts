/**
 * Tags IPC handlers tests
 *
 * @module ipc/tags-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { TagsChannels } from '@shared/ipc-channels'

const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []
const mockSend = vi.fn()

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
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [{ webContents: { send: mockSend } }])
  }
}))

vi.mock('../database', () => ({
  getIndexDatabase: vi.fn()
}))

vi.mock('@shared/db/queries/notes', () => ({
  findNotesWithTagInfo: vi.fn(),
  pinNoteToTag: vi.fn(),
  unpinNoteFromTag: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
  removeTagFromNote: vi.fn(),
  getTagDefinition: vi.fn(),
  updateTagColor: vi.fn(),
  getNoteTags: vi.fn()
}))

import { registerTagsHandlers } from './tags-handlers'
import { getIndexDatabase } from '../database'
import * as notesQueries from '@shared/db/queries/notes'

describe('tags-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    mockSend.mockClear()

    ;(getIndexDatabase as Mock).mockReturnValue({})
  })

  afterEach(() => {
    mockSend.mockClear()
  })

  it('lists notes by tag with pinned separation', async () => {
    registerTagsHandlers()

    ;(notesQueries.getTagDefinition as Mock).mockReturnValue({ color: 'blue' })
    ;(notesQueries.findNotesWithTagInfo as Mock).mockReturnValue([
      {
        id: 'note-1',
        path: 'notes/a.md',
        title: 'Note A',
        createdAt: '2025-01-01',
        modifiedAt: '2025-01-01',
        wordCount: 2,
        isPinned: true,
        pinnedAt: '2025-01-02',
        emoji: null
      },
      {
        id: 'note-2',
        path: 'notes/b.md',
        title: 'Note B',
        createdAt: '2025-01-01',
        modifiedAt: '2025-01-01',
        wordCount: 3,
        isPinned: false,
        pinnedAt: null,
        emoji: null
      }
    ])
    ;(notesQueries.getNoteTags as Mock).mockReturnValue(['focus'])

    const result = await invokeHandler(TagsChannels.invoke.GET_NOTES_BY_TAG, {
      tag: 'focus'
    })

    expect(result).toEqual(
      expect.objectContaining({
        tag: 'focus',
        color: 'blue',
        pinnedNotes: [expect.objectContaining({ id: 'note-1' })],
        unpinnedNotes: [expect.objectContaining({ id: 'note-2' })]
      })
    )
  })

  it('pins and unpins notes, emitting events', async () => {
    registerTagsHandlers()

    await invokeHandler(TagsChannels.invoke.PIN_NOTE_TO_TAG, { noteId: 'note-1', tag: 'focus' })
    expect(notesQueries.pinNoteToTag).toHaveBeenCalledWith({}, 'note-1', 'focus')
    expect(mockSend).toHaveBeenCalledWith(
      TagsChannels.events.NOTES_CHANGED,
      expect.objectContaining({ action: 'pinned' })
    )

    await invokeHandler(TagsChannels.invoke.UNPIN_NOTE_FROM_TAG, { noteId: 'note-1', tag: 'focus' })
    expect(notesQueries.unpinNoteFromTag).toHaveBeenCalledWith({}, 'note-1', 'focus')
    expect(mockSend).toHaveBeenCalledWith(
      TagsChannels.events.NOTES_CHANGED,
      expect.objectContaining({ action: 'unpinned' })
    )
  })

  it('renames, updates color, and deletes tags', async () => {
    registerTagsHandlers()

    ;(notesQueries.renameTag as Mock).mockReturnValue(3)
    const renameResult = await invokeHandler(TagsChannels.invoke.RENAME_TAG, {
      oldName: 'old',
      newName: 'new'
    })
    expect(renameResult).toEqual({ success: true, affectedNotes: 3 })
    expect(mockSend).toHaveBeenCalledWith(
      TagsChannels.events.RENAMED,
      expect.objectContaining({ oldName: 'old', newName: 'new' })
    )
    expect(mockSend).toHaveBeenCalledWith('notes:tags-changed', {})

    const colorResult = await invokeHandler(TagsChannels.invoke.UPDATE_TAG_COLOR, {
      tag: 'new',
      color: '#ff0000'
    })
    expect(colorResult).toEqual({ success: true })
    expect(notesQueries.updateTagColor).toHaveBeenCalledWith({}, 'new', '#ff0000')
    expect(mockSend).toHaveBeenCalledWith('notes:tags-changed', {})

    ;(notesQueries.deleteTag as Mock).mockReturnValue(5)
    const deleteResult = await invokeHandler(TagsChannels.invoke.DELETE_TAG, 'new')
    expect(deleteResult).toEqual({ success: true, affectedNotes: 5 })
    expect(mockSend).toHaveBeenCalledWith(
      TagsChannels.events.DELETED,
      expect.objectContaining({ tag: 'new', affectedNotes: 5 })
    )
    expect(mockSend).toHaveBeenCalledWith('notes:tags-changed', {})
  })

  it('removes a tag from a note and emits change events', async () => {
    registerTagsHandlers()

    const result = await invokeHandler(TagsChannels.invoke.REMOVE_TAG_FROM_NOTE, {
      noteId: 'note-1',
      tag: 'focus'
    })

    expect(result).toEqual({ success: true })
    expect(notesQueries.removeTagFromNote).toHaveBeenCalledWith({}, 'note-1', 'focus')
    expect(mockSend).toHaveBeenCalledWith(
      TagsChannels.events.NOTES_CHANGED,
      expect.objectContaining({ action: 'removed', tag: 'focus', noteId: 'note-1' })
    )
    expect(mockSend).toHaveBeenCalledWith('notes:tags-changed', {})
  })
})
