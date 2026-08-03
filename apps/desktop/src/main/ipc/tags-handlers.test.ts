/**
 * Tags IPC handlers tests
 *
 * @module ipc/tags-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { TagsChannels } from '@memry/contracts/ipc-channels'

const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []
const mockSend = vi.fn()
const fileMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  toAbsolutePath: vi.fn(),
  parseNote: vi.fn(),
  serializeNote: vi.fn(),
  serializeParsedNote: vi.fn(),
  atomicWrite: vi.fn(),
  syncMergedTagDefinitions: vi.fn(),
  syncTaggedNote: vi.fn(),
  syncTaggedTasks: vi.fn(),
  syncTagDefinitionDelete: vi.fn(),
  syncTagDefinitionRename: vi.fn(),
  syncTagDefinitionUpdate: vi.fn(),
  syncTagCategoryCreate: vi.fn(),
  syncTagCategoryUpdate: vi.fn(),
  syncTagCategoryDelete: vi.fn()
}))

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
    getAllWindows: vi.fn(() => [
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mockSend } }
    ])
  }
}))

vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))

vi.mock('fs/promises', () => ({
  readFile: fileMocks.readFile
}))

vi.mock('@main/database/queries/notes', () => ({
  findNotesWithTagInfo: vi.fn(),
  pinNoteToTag: vi.fn(),
  unpinNoteFromTag: vi.fn(),
  renameTag: vi.fn(),
  renameTagDefinition: vi.fn(),
  deleteTag: vi.fn(),
  deleteTagDefinition: vi.fn(),
  removeTagFromNote: vi.fn(),
  getOrCreateTag: vi.fn(),
  updateTagColor: vi.fn(),
  updateTagIcon: vi.fn(),
  getNoteTags: vi.fn(),
  getNoteCacheById: vi.fn()
}))

vi.mock('@main/database/queries/tags', () => ({
  getAllTagsWithCounts: vi.fn(),
  mergeTagInNotes: vi.fn(),
  mergeTagInTasks: vi.fn()
}))

vi.mock('@main/database/queries/tag-categories', () => ({
  listTagCategories: vi.fn(),
  createTagCategory: vi.fn(),
  renameTagCategory: vi.fn(),
  deleteTagCategory: vi.fn(),
  reorderTags: vi.fn(),
  reorderCategories: vi.fn()
}))

vi.mock('../vault/notes', () => ({
  toAbsolutePath: fileMocks.toAbsolutePath
}))

vi.mock('../vault/frontmatter', () => ({
  parseNote: fileMocks.parseNote,
  serializeNote: fileMocks.serializeNote,
  serializeParsedNote: fileMocks.serializeParsedNote
}))

vi.mock('../vault/file-ops', () => ({
  atomicWrite: fileMocks.atomicWrite
}))

vi.mock('../tags/runtime-effects', () => ({
  syncMergedTagDefinitions: fileMocks.syncMergedTagDefinitions,
  syncTaggedNote: fileMocks.syncTaggedNote,
  syncTaggedTasks: fileMocks.syncTaggedTasks,
  syncTagDefinitionDelete: fileMocks.syncTagDefinitionDelete,
  syncTagDefinitionRename: fileMocks.syncTagDefinitionRename,
  syncTagDefinitionUpdate: fileMocks.syncTagDefinitionUpdate,
  syncTagCategoryCreate: fileMocks.syncTagCategoryCreate,
  syncTagCategoryUpdate: fileMocks.syncTagCategoryUpdate,
  syncTagCategoryDelete: fileMocks.syncTagCategoryDelete
}))

import { registerTagsHandlers, unregisterTagsHandlers } from './tags-handlers'
import { getIndexDatabase, getDatabase, requireDatabase } from '../database'
import * as notesQueries from '@main/database/queries/notes'
import * as tagQueries from '@main/database/queries/tags'
import * as tagCategoryQueries from '@main/database/queries/tag-categories'

function createDbMock(options?: { allResult?: unknown[]; getResult?: unknown }) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          all: vi.fn(() => options?.allResult ?? []),
          get: vi.fn(() => options?.getResult)
        }))
      }))
    }))
  }
}

describe('tags-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    mockSend.mockClear()
    ;(getIndexDatabase as Mock).mockReturnValue(createDbMock())
    ;(getDatabase as Mock).mockReturnValue(createDbMock())
    ;(requireDatabase as Mock).mockReturnValue(createDbMock())
    fileMocks.readFile.mockResolvedValue('---\ntags: [old, keep]\n---\nBody')
    fileMocks.toAbsolutePath.mockImplementation((notePath: string) => `/vault/${notePath}`)
    fileMocks.parseNote.mockReturnValue({
      frontmatter: { tags: ['old', 'keep'] },
      content: 'Body'
    })
    fileMocks.serializeNote.mockReturnValue('serialized note')
    fileMocks.serializeParsedNote.mockReturnValue('serialized note')
    fileMocks.atomicWrite.mockResolvedValue(undefined)
    ;(notesQueries.getNoteCacheById as Mock).mockReturnValue(undefined)
  })

  afterEach(() => {
    mockSend.mockClear()
  })

  it('lists notes by tag with pinned separation', async () => {
    registerTagsHandlers()
    ;(notesQueries.getOrCreateTag as Mock).mockReturnValue({ name: 'focus', color: 'blue' })
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
    expect(notesQueries.pinNoteToTag).toHaveBeenCalledWith(expect.any(Object), 'note-1', 'focus')
    expect(mockSend).toHaveBeenCalledWith(
      TagsChannels.events.NOTES_CHANGED,
      expect.objectContaining({ action: 'pinned' })
    )

    await invokeHandler(TagsChannels.invoke.UNPIN_NOTE_FROM_TAG, { noteId: 'note-1', tag: 'focus' })
    expect(notesQueries.unpinNoteFromTag).toHaveBeenCalledWith(
      expect.any(Object),
      'note-1',
      'focus'
    )
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
    expect(notesQueries.renameTagDefinition).toHaveBeenCalledWith(expect.any(Object), 'old', 'new')
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
    expect(notesQueries.getOrCreateTag).toHaveBeenCalledWith(expect.any(Object), 'new')
    expect(notesQueries.updateTagColor).toHaveBeenCalledWith(expect.any(Object), 'new', '#ff0000')
    expect(mockSend).toHaveBeenCalledWith('notes:tags-changed', {})
    ;(notesQueries.deleteTag as Mock).mockReturnValue(5)
    const deleteResult = await invokeHandler(TagsChannels.invoke.DELETE_TAG, 'new')
    expect(deleteResult).toEqual({ success: true, affectedNotes: 5 })
    expect(notesQueries.deleteTagDefinition).toHaveBeenCalledWith(expect.any(Object), 'new')
    expect(mockSend).toHaveBeenCalledWith(
      TagsChannels.events.DELETED,
      expect.objectContaining({ tag: 'new', affectedNotes: 5 })
    )
    expect(mockSend).toHaveBeenCalledWith('notes:tags-changed', {})
  })

  it('sets and clears a tag icon, emitting a change event for refetch', async () => {
    registerTagsHandlers()

    const setResult = await invokeHandler(TagsChannels.invoke.UPDATE_TAG_ICON, {
      tag: 'focus',
      icon: '📚'
    })
    expect(setResult).toEqual({ success: true })
    expect(notesQueries.getOrCreateTag).toHaveBeenCalledWith(expect.any(Object), 'focus')
    expect(notesQueries.updateTagIcon).toHaveBeenCalledWith(expect.any(Object), 'focus', '📚')
    expect(fileMocks.syncTagDefinitionUpdate).toHaveBeenCalledWith('focus')
    // use-tags refetches on this event; without it the new icon never shows.
    expect(mockSend).toHaveBeenCalledWith('notes:tags-changed', {})

    const clearResult = await invokeHandler(TagsChannels.invoke.UPDATE_TAG_ICON, {
      tag: 'focus',
      icon: null
    })
    expect(clearResult).toEqual({ success: true })
    expect(notesQueries.updateTagIcon).toHaveBeenCalledWith(expect.any(Object), 'focus', null)
  })

  it('removes a tag from a note and emits change events', async () => {
    registerTagsHandlers()

    const result = await invokeHandler(TagsChannels.invoke.REMOVE_TAG_FROM_NOTE, {
      noteId: 'note-1',
      tag: 'focus'
    })

    expect(result).toEqual({ success: true })
    expect(notesQueries.removeTagFromNote).toHaveBeenCalledWith(
      expect.any(Object),
      'note-1',
      'focus'
    )
    expect(mockSend).toHaveBeenCalledWith(
      TagsChannels.events.NOTES_CHANGED,
      expect.objectContaining({ action: 'removed', tag: 'focus', noteId: 'note-1' })
    )
    expect(mockSend).toHaveBeenCalledWith('notes:tags-changed', {})
  })

  it('updates markdown frontmatter and sync metadata when renaming or deleting tags', async () => {
    const indexDb = createDbMock({ allResult: [{ noteId: 'note-1' }] })
    const dataDb = createDbMock({ getResult: { name: 'old', color: 'red' } })
    ;(getIndexDatabase as Mock).mockReturnValue(indexDb)
    ;(requireDatabase as Mock).mockReturnValue(dataDb)
    ;(notesQueries.getNoteCacheById as Mock).mockReturnValue({ path: 'notes/a.md' })
    ;(notesQueries.renameTag as Mock).mockReturnValue(1)
    registerTagsHandlers()

    const renameResult = await invokeHandler(TagsChannels.invoke.RENAME_TAG, {
      oldName: ' old ',
      newName: ' New '
    })

    expect(renameResult).toEqual({ success: true, affectedNotes: 1 })
    expect(fileMocks.toAbsolutePath).toHaveBeenCalledWith('notes/a.md')
    expect(fileMocks.readFile).toHaveBeenCalledWith('/vault/notes/a.md', 'utf-8')
    expect(fileMocks.serializeParsedNote).toHaveBeenCalledWith(
      expect.objectContaining({ frontmatter: { tags: ['New', 'keep'] } }),
      'Body',
      { frontmatterEdited: true }
    )
    expect(fileMocks.atomicWrite).toHaveBeenCalledWith('/vault/notes/a.md', 'serialized note')
    expect(fileMocks.syncTaggedNote).toHaveBeenCalledWith('note-1')
    expect(fileMocks.syncTagDefinitionRename).toHaveBeenCalledWith(' old ', ' New ', {
      name: 'old',
      color: 'red'
    })

    fileMocks.parseNote.mockReturnValueOnce({
      frontmatter: { tags: ['old'] },
      content: 'Body'
    })
    ;(notesQueries.deleteTag as Mock).mockReturnValue(1)

    const deleteResult = await invokeHandler(TagsChannels.invoke.DELETE_TAG, ' old ')

    expect(deleteResult).toEqual({ success: true, affectedNotes: 1 })
    expect(fileMocks.serializeParsedNote).toHaveBeenLastCalledWith(
      expect.objectContaining({ frontmatter: {} }),
      'Body',
      { frontmatterEdited: true }
    )
    expect(fileMocks.syncTagDefinitionDelete).toHaveBeenCalledWith('old', {
      name: 'old',
      color: 'red'
    })
  })

  it('aggregates, merges, and unregisters tag handlers', async () => {
    const indexDb = createDbMock({ allResult: [{ noteId: 'note-1' }] })
    const dataDb = createDbMock({ getResult: { name: 'source', color: 'blue' } })
    ;(getIndexDatabase as Mock).mockReturnValue(indexDb)
    ;(requireDatabase as Mock).mockReturnValue(dataDb)
    ;(notesQueries.getNoteCacheById as Mock).mockReturnValue({ path: 'notes/a.md' })
    ;(tagQueries.getAllTagsWithCounts as Mock).mockReturnValue([{ name: 'focus', count: 2 }])
    ;(tagQueries.mergeTagInNotes as Mock).mockReturnValue({
      affected: 2,
      noteIds: ['note-1']
    })
    ;(tagQueries.mergeTagInTasks as Mock).mockReturnValue({
      affected: 1,
      taskIds: ['task-1']
    })
    registerTagsHandlers()

    expect(await invokeHandler(TagsChannels.invoke.GET_ALL_WITH_COUNTS)).toEqual({
      tags: [{ name: 'focus', count: 2 }]
    })

    expect(
      await invokeHandler(TagsChannels.invoke.MERGE_TAG, {
        source: 'Focus',
        target: ' focus '
      })
    ).toEqual({ success: false, error: 'Source and target tags are the same' })

    fileMocks.parseNote.mockReturnValueOnce({
      frontmatter: { tags: ['source', 'target'] },
      content: 'Body'
    })
    const mergeResult = await invokeHandler(TagsChannels.invoke.MERGE_TAG, {
      source: ' source ',
      target: ' target '
    })

    expect(mergeResult).toEqual({ success: true, affectedItems: 3 })
    expect(fileMocks.serializeParsedNote).toHaveBeenCalledWith(
      expect.objectContaining({ frontmatter: { tags: ['target'] } }),
      'Body',
      { frontmatterEdited: true }
    )
    expect(fileMocks.syncMergedTagDefinitions).toHaveBeenCalledWith('source', 'target', {
      name: 'source',
      color: 'blue'
    })
    expect(fileMocks.syncTaggedTasks).toHaveBeenCalledWith(['task-1'])

    unregisterTagsHandlers()
    expect(removeHandlerCalls).toEqual(Object.values(TagsChannels.invoke))
  })
})

describe('tag category handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0
    mockSend.mockClear()
    ;(getIndexDatabase as Mock).mockReturnValue(createDbMock())
    ;(getDatabase as Mock).mockReturnValue(createDbMock())
    ;(requireDatabase as Mock).mockReturnValue(createDbMock())
  })

  it('lists categories', async () => {
    registerTagsHandlers()
    ;(tagCategoryQueries.listTagCategories as Mock).mockReturnValue([
      { id: 'cat-1', name: 'Work', sortOrder: 0, tagCount: 2 }
    ])

    const result = await invokeHandler(TagsChannels.invoke.LIST_CATEGORIES)

    expect(result).toEqual({
      success: true,
      categories: [{ id: 'cat-1', name: 'Work', sortOrder: 0, tagCount: 2 }]
    })
  })

  it('rejects a blank category name', async () => {
    registerTagsHandlers()

    const result = await invokeHandler(TagsChannels.invoke.CREATE_CATEGORY, { name: '   ' })

    expect(result).toEqual({ success: false, error: 'Category name is required' })
    expect(tagCategoryQueries.createTagCategory).not.toHaveBeenCalled()
  })

  it('creates a category, enqueues a sync create, and emits categories-changed', async () => {
    registerTagsHandlers()
    ;(tagCategoryQueries.createTagCategory as Mock).mockReturnValue({
      id: 'cat-1',
      name: 'Work',
      sortOrder: 0,
      tagCount: 0
    })

    const result = await invokeHandler(TagsChannels.invoke.CREATE_CATEGORY, { name: 'Work' })

    expect(result).toEqual({
      success: true,
      category: { id: 'cat-1', name: 'Work', sortOrder: 0, tagCount: 0 }
    })
    expect(fileMocks.syncTagCategoryCreate).toHaveBeenCalledWith('cat-1')
    expect(mockSend).toHaveBeenCalledWith(
      TagsChannels.events.CATEGORIES_CHANGED,
      expect.objectContaining({ categoryId: 'cat-1' })
    )
  })

  it('renames a category, enqueues a sync update, and emits categories-changed', async () => {
    registerTagsHandlers()

    const result = await invokeHandler(TagsChannels.invoke.RENAME_CATEGORY, {
      id: 'cat-1',
      name: 'Personal'
    })

    expect(result).toEqual({ success: true })
    expect(tagCategoryQueries.renameTagCategory).toHaveBeenCalledWith(
      expect.any(Object),
      'cat-1',
      'Personal'
    )
    expect(fileMocks.syncTagCategoryUpdate).toHaveBeenCalledWith('cat-1')
    expect(mockSend).toHaveBeenCalledWith(
      TagsChannels.events.CATEGORIES_CHANGED,
      expect.objectContaining({ categoryId: 'cat-1' })
    )
  })

  it('rejects a blank rename', async () => {
    registerTagsHandlers()

    const result = await invokeHandler(TagsChannels.invoke.RENAME_CATEGORY, {
      id: 'cat-1',
      name: '   '
    })

    expect(result).toEqual({ success: false, error: 'Category name is required' })
    expect(tagCategoryQueries.renameTagCategory).not.toHaveBeenCalled()
  })

  it('deletes a category, enqueues a sync delete, and emits categories-changed', async () => {
    registerTagsHandlers()

    const result = await invokeHandler(TagsChannels.invoke.DELETE_CATEGORY, { id: 'cat-1' })

    expect(result).toEqual({ success: true })
    expect(tagCategoryQueries.deleteTagCategory).toHaveBeenCalledWith(expect.any(Object), 'cat-1')
    expect(fileMocks.syncTagCategoryDelete).toHaveBeenCalledWith('cat-1')
    expect(mockSend).toHaveBeenCalledWith(
      TagsChannels.events.CATEGORIES_CHANGED,
      expect.objectContaining({ categoryId: 'cat-1' })
    )
  })

  it('applies tags and categories in a single reorder call, enqueuing both types', async () => {
    registerTagsHandlers()

    const result = await invokeHandler(TagsChannels.invoke.REORDER, {
      tags: [{ tag: 'Meetings', categoryId: 'cat-1', sortOrder: 0 }],
      categories: [{ id: 'cat-1', sortOrder: 0 }]
    })

    expect(result).toEqual({ success: true })
    expect(tagCategoryQueries.reorderTags).toHaveBeenCalledWith(expect.any(Object), [
      { tag: 'Meetings', categoryId: 'cat-1', sortOrder: 0 }
    ])
    expect(tagCategoryQueries.reorderCategories).toHaveBeenCalledWith(expect.any(Object), [
      { id: 'cat-1', sortOrder: 0 }
    ])
    expect(fileMocks.syncTagDefinitionUpdate).toHaveBeenCalledWith('meetings')
    expect(fileMocks.syncTagCategoryUpdate).toHaveBeenCalledWith('cat-1')
    expect(mockSend).toHaveBeenCalledWith(TagsChannels.events.CATEGORIES_CHANGED, expect.anything())
  })

  it('emits tags:categories-changed after a reorder', async () => {
    registerTagsHandlers()

    const result = await invokeHandler(TagsChannels.invoke.REORDER, { tags: [], categories: [] })

    expect(result).toEqual({ success: true })
    expect(mockSend).toHaveBeenCalledWith(TagsChannels.events.CATEGORIES_CHANGED, expect.anything())
    expect(fileMocks.syncTagDefinitionUpdate).not.toHaveBeenCalled()
    expect(fileMocks.syncTagCategoryUpdate).not.toHaveBeenCalled()
  })
})
