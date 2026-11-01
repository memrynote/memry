import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'

const commands = vi.hoisted(() => ({
  tagsGetAllWithCounts: vi.fn(),
  tagsGetNotesByTag: vi.fn()
}))

vi.mock('../../../generated/bindings', () => ({ commands }))

import {
  tagsService,
  onTagRenamed,
  onTagColorUpdated,
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

  it('forwards the methods later steps port to window.api.tags', async () => {
    api.tags.pinNoteToTag = vi.fn().mockResolvedValue({ success: true })
    api.tags.unpinNoteFromTag = vi.fn().mockResolvedValue({ success: true })
    api.tags.renameTag = vi.fn().mockResolvedValue({ success: true, affectedNotes: 0 })
    api.tags.updateTagColor = vi.fn().mockResolvedValue({ success: true })
    api.tags.deleteTag = vi.fn().mockResolvedValue({ success: true, affectedNotes: 0 })
    api.tags.removeTagFromNote = vi.fn().mockResolvedValue({ success: true })
    api.tags.mergeTag = vi.fn().mockResolvedValue({ success: true, affectedNotes: 0 })

    await tagsService.pinNoteToTag({ noteId: 'note-1', tag: 'focus' })
    expect(api.tags.pinNoteToTag).toHaveBeenCalledWith({ noteId: 'note-1', tag: 'focus' })

    await tagsService.unpinNoteFromTag({ noteId: 'note-1', tag: 'focus' })
    expect(api.tags.unpinNoteFromTag).toHaveBeenCalledWith({ noteId: 'note-1', tag: 'focus' })

    await tagsService.renameTag({ oldName: 'old', newName: 'new' })
    expect(api.tags.renameTag).toHaveBeenCalledWith({ oldName: 'old', newName: 'new' })

    await tagsService.updateTagColor({ tag: 'new', color: '#fff' })
    expect(api.tags.updateTagColor).toHaveBeenCalledWith({ tag: 'new', color: '#fff' })

    await tagsService.deleteTag('new')
    expect(api.tags.deleteTag).toHaveBeenCalledWith('new')

    await tagsService.removeTagFromNote({ noteId: 'note-2', tag: 'focus' })
    expect(api.tags.removeTagFromNote).toHaveBeenCalledWith({ noteId: 'note-2', tag: 'focus' })

    await tagsService.mergeTag({ source: 'old', target: 'new' })
    expect(api.tags.mergeTag).toHaveBeenCalledWith({ source: 'old', target: 'new' })
  })

  it('registers tag event subscriptions', () => {
    const unsubscribe = vi.fn()
    api.onTagRenamed = vi.fn(() => unsubscribe)
    api.onTagColorUpdated = vi.fn(() => unsubscribe)
    api.onTagDeleted = vi.fn(() => unsubscribe)
    api.onTagNotesChanged = vi.fn(() => unsubscribe)

    expect(onTagRenamed(vi.fn())).toBe(unsubscribe)
    expect(onTagColorUpdated(vi.fn())).toBe(unsubscribe)
    expect(onTagDeleted(vi.fn())).toBe(unsubscribe)
    expect(onTagNotesChanged(vi.fn())).toBe(unsubscribe)
  })
})
