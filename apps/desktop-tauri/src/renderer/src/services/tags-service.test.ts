import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'

const commands = vi.hoisted(() => ({
  tagsGetAllWithCounts: vi.fn(),
  tagsGetNotesByTag: vi.fn(),
  tagsUpdateColor: vi.fn(),
  tagsUpdateIcon: vi.fn(),
  tagsListCategories: vi.fn(),
  tagsCreateCategory: vi.fn(),
  tagsRenameCategory: vi.fn(),
  tagsDeleteCategory: vi.fn(),
  tagsReorder: vi.fn()
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
    tagColorUpdatedEvent: event('color'),
    tagCategoriesChangedEvent: event('categories')
  }
})

vi.mock('../../../generated/bindings', () => ({ commands, events }))

import {
  tagsService,
  onTagRenamed,
  onTagColorUpdated,
  onTagCategoriesChanged,
  onTagDeleted,
  onTagNotesChanged
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

    commands.tagsListCategories.mockRejectedValue({
      kind: 'storage',
      code: 'storage_failed',
      message: 'disk'
    })
    await expect(tagsService.listCategories()).resolves.toEqual({ success: false, error: 'disk' })
  })

  it('forwards the methods later steps port to window.api.tags', async () => {
    api.tags.pinNoteToTag = vi.fn().mockResolvedValue({ success: true })
    api.tags.renameTag = vi.fn().mockResolvedValue({ success: true, affectedNotes: 0 })
    api.tags.mergeTag = vi.fn().mockResolvedValue({ success: true, affectedItems: 0 })

    await tagsService.pinNoteToTag({ noteId: 'note-1', tag: 'focus' })
    expect(api.tags.pinNoteToTag).toHaveBeenCalledWith({ noteId: 'note-1', tag: 'focus' })
    await tagsService.renameTag({ oldName: 'old', newName: 'new' })
    expect(api.tags.renameTag).toHaveBeenCalledWith({ oldName: 'old', newName: 'new' })
    await tagsService.mergeTag({ source: 'old', target: 'new' })
    expect(api.tags.mergeTag).toHaveBeenCalledWith({ source: 'old', target: 'new' })
  })

  it('hands the colour and category events from Rust on', async () => {
    const color = vi.fn()
    const categories = vi.fn()
    const stops = [onTagColorUpdated(color), onTagCategoriesChanged(categories)]
    await vi.waitFor(() => expect(listeners.size).toBe(2))

    listeners.get('color')?.({ payload: { tag: 'work', color: 'teal' } })
    listeners.get('categories')?.({ payload: { categoryId: null } })

    expect(color).toHaveBeenCalledWith({ tag: 'work', color: 'teal' })
    // Electron's callback takes no argument.
    expect(categories).toHaveBeenCalledWith()
    for (const stop of stops) stop()
    await vi.waitFor(() => expect(listeners.size).toBe(0))
  })

  it('registers the tag subscriptions not yet ported on window.api', () => {
    const unsubscribe = vi.fn()
    api.onTagRenamed = vi.fn(() => unsubscribe)
    api.onTagDeleted = vi.fn(() => unsubscribe)
    api.onTagNotesChanged = vi.fn(() => unsubscribe)

    expect(onTagRenamed(vi.fn())).toBe(unsubscribe)
    expect(onTagDeleted(vi.fn())).toBe(unsubscribe)
    expect(onTagNotesChanged(vi.fn())).toBe(unsubscribe)
  })
})
