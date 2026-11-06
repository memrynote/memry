import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'

const commands = vi.hoisted(() => ({
  tagsGetSchemaSnapshot: vi.fn(),
  tagsEditSchema: vi.fn(),
  tagsSearchObjects: vi.fn(),
  tagsGetAllWithCounts: vi.fn(),
  tagsGetNotesByTag: vi.fn(),
  tagsUpdateColor: vi.fn(),
  tagsUpdateIcon: vi.fn(),
  tagsListCategories: vi.fn(),
  tagsCreateCategory: vi.fn(),
  tagsRenameCategory: vi.fn(),
  tagsDeleteCategory: vi.fn(),
  tagsReorder: vi.fn(),
  tagsPinNoteToTag: vi.fn(),
  tagsUnpinNoteFromTag: vi.fn(),
  tagsRename: vi.fn(),
  tagsDelete: vi.fn(),
  tagsRemoveFromNote: vi.fn(),
  tagsMerge: vi.fn()
}))

// Each Rust event's last listener, for a test to send a payload through.
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>())
const events = vi.hoisted(() => {
  const event = (name: string) => ({
    listen: async (handler: (event: { payload: unknown }) => void) => {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    }
  })
  return {
    propertyDefinitionChangedEvent: event('definitions'),
    tagColorUpdatedEvent: event('color'),
    tagCategoriesChangedEvent: event('categories'),
    tagNotesChangedEvent: event('notes'),
    tagRenamedEvent: event('renamed'),
    tagDeletedEvent: event('deleted'),
    tagsProgressEvent: event('progress')
  }
})

vi.mock('../../../generated/bindings', () => ({ commands, events }))

import {
  tagsService,
  onPropertyDefinitionChanged,
  onTagRenamed,
  onTagColorUpdated,
  onTagCategoriesChanged,
  onTagDeleted,
  onTagNotesChanged,
  onTagsProgress
} from './tags-service'

describe('tags-service', () => {
  let api: any

  beforeEach(() => {
    api = createMockApi()
    ;(window as Window & { api: unknown }).api = api
    for (const command of Object.values(commands)) command.mockReset()
  })

  it('reads the tag list and a tag’s notes through the commands, rejecting as Electron rethrows', async () => {
    const tag = {
      name: 'work',
      count: 2,
      color: 'teal',
      icon: null,
      categoryId: null,
      sortOrder: 0
    }
    commands.tagsGetAllWithCounts.mockResolvedValue([tag])
    const notes = { tag: 'work', color: 'teal', count: 0, pinnedNotes: [], unpinnedNotes: [] }
    commands.tagsGetNotesByTag.mockResolvedValue(notes)

    await expect(tagsService.getAllWithCounts()).resolves.toEqual({ tags: [tag] })
    const input = { tag: 'work', sortBy: 'title', sortOrder: 'asc', includeDescendants: true }
    await expect(tagsService.getNotesByTag(input as never)).resolves.toEqual(notes)
    expect(commands.tagsGetNotesByTag).toHaveBeenCalledWith(input)

    commands.tagsGetAllWithCounts.mockRejectedValue({
      kind: 'invalid',
      code: 'no_vault_open',
      message: 'closed'
    })
    await expect(tagsService.getAllWithCounts()).rejects.toMatchObject({ code: 'no_vault_open' })
  })

  it('writes colour, icon and the drag through the commands, a failure answering its message', async () => {
    for (const command of [
      commands.tagsUpdateColor,
      commands.tagsUpdateIcon,
      commands.tagsReorder
    ]) {
      command.mockResolvedValue(null)
    }
    await expect(tagsService.updateTagColor({ tag: 'work', color: 'teal' })).resolves.toEqual({
      success: true
    })
    expect(commands.tagsUpdateColor).toHaveBeenCalledWith('work', 'teal')
    await tagsService.updateTagIcon({ tag: 'work', icon: null })
    expect(commands.tagsUpdateIcon).toHaveBeenCalledWith('work', null)
    const drag = {
      tags: [{ tag: 'work', categoryId: 'cat-1', sortOrder: 2 }],
      categories: [{ id: 'cat-1', sortOrder: 0 }]
    }
    await expect(tagsService.reorder(drag)).resolves.toEqual({ success: true })
    expect(commands.tagsReorder).toHaveBeenCalledWith(drag)

    commands.tagsUpdateColor.mockRejectedValue({
      kind: 'invalid',
      code: 'invalid',
      message: 'a tag needs a name'
    })
    await expect(tagsService.updateTagColor({ tag: ' ', color: 'teal' })).resolves.toEqual({
      success: false,
      error: 'a tag needs a name'
    })
  })

  it('answers the category commands in Electron’s envelope', async () => {
    const row = { id: 'cat-1', name: 'Work', sortOrder: 0, tagCount: 3 }
    commands.tagsListCategories.mockResolvedValue([row])
    commands.tagsCreateCategory.mockResolvedValue(row)
    commands.tagsRenameCategory.mockResolvedValue(null)
    commands.tagsDeleteCategory.mockRejectedValue({
      kind: 'not_found',
      code: 'not_found',
      message: 'gone'
    })

    await expect(tagsService.listCategories()).resolves.toEqual({
      success: true,
      categories: [row]
    })
    await expect(tagsService.createCategory('Work')).resolves.toEqual({
      success: true,
      category: row
    })
    expect(commands.tagsCreateCategory).toHaveBeenCalledWith('Work')
    await expect(tagsService.renameCategory('cat-1', 'Jobs')).resolves.toEqual({ success: true })
    expect(commands.tagsRenameCategory).toHaveBeenCalledWith('cat-1', 'Jobs')
    await expect(tagsService.deleteCategory('cat-1')).resolves.toEqual({
      success: false,
      error: 'gone'
    })
    expect(commands.tagsDeleteCategory).toHaveBeenCalledWith('cat-1')

    commands.tagsListCategories.mockRejectedValue({
      kind: 'storage',
      code: 'storage_failed',
      message: 'disk'
    })
    await expect(tagsService.listCategories()).resolves.toEqual({ success: false, error: 'disk' })
  })

  it('reads and edits tag schemas through the commands, a field rename still on window.api', async () => {
    const snapshot = { tags: {}, objects: {}, presets: [], presetStripDismissed: false }
    commands.tagsGetSchemaSnapshot.mockResolvedValue(snapshot)
    expect(await tagsService.getSchemaSnapshot()).toBe(snapshot)

    const command = { kind: 'remove-field' as const, tag: 'person', name: 'Role' }
    commands.tagsEditSchema.mockResolvedValue({ snapshot })
    expect(await tagsService.editSchema(command)).toEqual({ snapshot })
    expect(commands.tagsEditSchema).toHaveBeenCalledWith(command)
    commands.tagsEditSchema.mockRejectedValue({ kind: 'Invalid', code: 'x', message: 'refused' })
    await expect(tagsService.editSchema(command)).rejects.toMatchObject({ message: 'refused' })

    const rename = { kind: 'rename-field' as const, from: 'Role', to: 'Title', runId: 'r1' }
    api.tags.editSchema = vi.fn().mockResolvedValue({ snapshot })
    await tagsService.editSchema(rename)
    expect(api.tags.editSchema).toHaveBeenCalledWith(rename)
    expect(commands.tagsEditSchema).toHaveBeenCalledTimes(2)

    const changed = vi.fn()
    const stop = onPropertyDefinitionChanged(changed)
    await vi.waitFor(() => expect(listeners.has('definitions')).toBe(true))
    listeners.get('definitions')?.({ payload: { name: 'Role' } })
    expect(changed).toHaveBeenCalledWith({ name: 'Role' })
    stop()
    await vi.waitFor(() => expect(listeners.has('definitions')).toBe(false))
  })

  it('searches objects through the command, never window.api', async () => {
    api.tags.searchObjects = vi.fn()
    const matches = { matches: [], complete: true }
    commands.tagsSearchObjects.mockResolvedValue(matches)
    const input = { query: 'ada', tag: 'person', limit: 8 }
    expect(await tagsService.searchObjects(input)).toBe(matches)
    expect(commands.tagsSearchObjects).toHaveBeenCalledWith(input)
    commands.tagsSearchObjects.mockRejectedValue({ kind: 'Invalid', code: 'x', message: 'bad' })
    await expect(tagsService.searchObjects({ query: '', limit: 0 })).rejects.toMatchObject({
      message: 'bad'
    })
    expect(api.tags.searchObjects).not.toHaveBeenCalled()
  })

  it('pins and unpins through the commands, a failure answering its message', async () => {
    commands.tagsPinNoteToTag.mockResolvedValue(null)
    await expect(tagsService.pinNoteToTag({ noteId: 'note-1', tag: 'focus' })).resolves.toEqual({
      success: true
    })
    expect(commands.tagsPinNoteToTag).toHaveBeenCalledWith('note-1', 'focus')
    commands.tagsUnpinNoteFromTag.mockRejectedValue({
      kind: 'invalid',
      code: 'invalid',
      message: 'Failed to unpin note'
    })
    await expect(tagsService.unpinNoteFromTag({ noteId: 'note-2', tag: 'focus' })).resolves.toEqual(
      { success: false, error: 'Failed to unpin note' }
    )
    expect(commands.tagsUnpinNoteFromTag).toHaveBeenCalledWith('note-2', 'focus')
  })

  it('renames through the command in Electron’s envelope, a refusal answering its words', async () => {
    const view = { affectedNotes: 2, failedNoteIds: ['note-9'], bodySkipped: true }
    commands.tagsRename.mockResolvedValue(view)
    const input = { oldName: 'work', newName: 'job', runId: 'run-1' }
    await expect(tagsService.renameTag(input)).resolves.toEqual({ success: true, ...view })
    expect(commands.tagsRename).toHaveBeenCalledWith(input)

    const message = 'A rename of #old to #new is still running. Try again when it finishes.'
    commands.tagsRename.mockRejectedValue({
      kind: 'invalid',
      code: 'tag_rename_in_progress',
      message
    })
    await expect(tagsService.renameTag(input)).resolves.toEqual({
      success: false,
      error: message,
      code: 'tag_rename_in_progress'
    })
  })

  it('deletes, merges and removes from a note through the commands in Electron’s envelope', async () => {
    const kept = {
      affectedNotes: 3,
      failedNotes: [{ id: 'n9', title: 'Plan' }],
      retryFinishes: false
    }
    commands.tagsDelete.mockResolvedValue(kept)
    await expect(tagsService.deleteTag('new')).resolves.toEqual({ success: true, ...kept })
    expect(commands.tagsDelete).toHaveBeenCalledWith('new')
    commands.tagsMerge.mockResolvedValue({ affectedItems: 2 })
    const merge = { source: 'old', target: 'new' }
    await expect(tagsService.mergeTag(merge)).resolves.toEqual({ success: true, affectedItems: 2 })
    expect(commands.tagsMerge).toHaveBeenCalledWith(merge)
    commands.tagsRemoveFromNote.mockResolvedValue(null)
    const removal = { noteId: 'note-2', tag: 'focus' }
    await expect(tagsService.removeTagFromNote(removal)).resolves.toEqual({ success: true })
    expect(commands.tagsRemoveFromNote).toHaveBeenCalledWith(removal)

    const message = 'Source and target tags are the same'
    commands.tagsMerge.mockRejectedValue({ kind: 'invalid', code: 'tag_merge_same_tag', message })
    await expect(tagsService.mergeTag(merge)).resolves.toEqual({
      success: false,
      error: message,
      code: 'tag_merge_same_tag'
    })
    commands.tagsDelete.mockRejectedValue({
      kind: 'storage',
      code: 'storage_failed',
      message: 'disk'
    })
    await expect(tagsService.deleteTag('new')).resolves.toEqual({
      success: false,
      error: 'disk',
      code: 'storage_failed'
    })
  })

  it('hands the colour, category, tag notes and rename events from Rust on', async () => {
    const color = vi.fn()
    const categories = vi.fn()
    const notes = vi.fn()
    const renamed = vi.fn()
    const progress = vi.fn()
    const stops = [
      onTagColorUpdated(color),
      onTagCategoriesChanged(categories),
      onTagNotesChanged(notes),
      onTagRenamed(renamed),
      onTagsProgress(progress)
    ]
    await vi.waitFor(() => expect(listeners.size).toBe(5))

    const rename = { oldName: 'work', newName: 'job', affectedNotes: 2 }
    listeners.get('renamed')?.({ payload: rename })
    listeners.get('progress')?.({ payload: { runId: 'run-1', done: 1, total: 2 } })
    expect(renamed).toHaveBeenCalledWith(rename)
    expect(progress).toHaveBeenCalledWith({ runId: 'run-1', done: 1, total: 2 })

    listeners.get('color')?.({ payload: { tag: 'work', color: 'teal' } })
    listeners.get('categories')?.({ payload: { categoryId: null } })
    const pinned = { tag: 'work', noteId: 'note-1', action: 'pinned' }
    listeners.get('notes')?.({ payload: pinned })

    expect(color).toHaveBeenCalledWith({ tag: 'work', color: 'teal' })
    expect(notes).toHaveBeenCalledWith(pinned)
    // Electron's callback takes no argument.
    expect(categories).toHaveBeenCalledWith()
    for (const stop of stops) stop()
    await vi.waitFor(() => expect(listeners.size).toBe(0))
  })

  it('hands a deleted tag from Rust on', async () => {
    const deleted = vi.fn()
    const stop = onTagDeleted(deleted)
    await vi.waitFor(() => expect(listeners.has('deleted')).toBe(true))
    listeners.get('deleted')?.({ payload: { tag: 'work', affectedNotes: 2 } })
    expect(deleted).toHaveBeenCalledWith({ tag: 'work', affectedNotes: 2 })
    stop()
  })
})
