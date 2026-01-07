import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
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
    api.tags.getNotesByTag = vi
      .fn()
      .mockResolvedValue({ tag: 'focus', count: 0, pinnedNotes: [], unpinnedNotes: [] })
    api.tags.pinNoteToTag = vi.fn().mockResolvedValue({ success: true })
    api.tags.unpinNoteFromTag = vi.fn().mockResolvedValue({ success: true })
    api.tags.renameTag = vi.fn().mockResolvedValue({ success: true, affectedNotes: 0 })
    api.tags.updateTagColor = vi.fn().mockResolvedValue({ success: true })
    api.tags.deleteTag = vi.fn().mockResolvedValue({ success: true, affectedNotes: 0 })
    api.tags.removeTagFromNote = vi.fn().mockResolvedValue({ success: true })

    api.onTagRenamed = vi.fn().mockReturnValue(() => {})
    api.onTagColorUpdated = vi.fn().mockReturnValue(() => {})
    api.onTagDeleted = vi.fn().mockReturnValue(() => {})
    api.onTagNotesChanged = vi.fn().mockReturnValue(() => {})
    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards tag operations to window.api.tags', async () => {
    await tagsService.getNotesByTag({ tag: 'focus', sortBy: 'modified' })
    expect(api.tags.getNotesByTag).toHaveBeenCalledWith({ tag: 'focus', sortBy: 'modified' })

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
