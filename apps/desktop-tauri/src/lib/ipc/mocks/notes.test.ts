import { describe, it, expect } from 'vitest'

import { notesRoutes } from './notes'

describe('notesRoutes', () => {
  it('notes_list returns NoteListResponse with 12 non-deleted notes', async () => {
    // #given list of 12 fixtures, none deleted
    // #when listing
    const res = (await notesRoutes.notes_list!(undefined)) as {
      notes: Array<{ path: string; modified: Date }>
      total: number
      hasMore: boolean
    }
    // #then
    expect(res.notes).toHaveLength(12)
    expect(res.total).toBe(12)
    expect(res.hasMore).toBe(false)
    // Every item must have NoteListItem-shaped fields the renderer tree sorts by
    expect(res.notes.every((n) => typeof n.path === 'string' && n.modified instanceof Date)).toBe(
      true
    )
  })

  it('notes_list_by_folder filters to the requested folder', async () => {
    const res = (await notesRoutes.notes_list_by_folder!({ folderId: 'folder-1' })) as {
      notes: Array<{ path: string }>
    }
    expect(res.notes.length).toBeGreaterThanOrEqual(4)
  })

  it('notes_get returns the internal note record for a known id', async () => {
    const note = (await notesRoutes.notes_get!({ id: 'note-1' })) as {
      id: string
      title: string
    }
    expect(note.id).toBe('note-1')
    expect(note.title).toBeDefined()
  })

  it('notes_get rejects with a not-found error when id is unknown', async () => {
    await expect(notesRoutes.notes_get!({ id: 'note-missing' })).rejects.toThrow(/not found/i)
  })

  it('notes_create wraps a new note in NoteCreateResponse with generated id + content', async () => {
    const result = (await notesRoutes.notes_create!({
      title: 'New mock note',
      content: 'Body',
      folderId: 'folder-1'
    })) as {
      success: boolean
      note: {
        id: string
        title: string
        path: string
        content: string
        folderId: string | null
        createdAt: number
        updatedAt: number
        deletedAt: number | null
      }
    }
    expect(result.success).toBe(true)
    expect(result.note.id).toMatch(/^note-\d+/)
    expect(result.note.title).toBe('New mock note')
    expect(result.note.content).toBe('Body')
    expect(result.note.folderId).toBe('folder-1')
    expect(result.note.path).toContain('folder-1')
    expect(result.note.createdAt).toBeGreaterThan(0)
    expect(result.note.updatedAt).toBe(result.note.createdAt)
    expect(result.note.deletedAt).toBeNull()

    const list = (await notesRoutes.notes_list!(undefined)) as {
      notes: Array<{ id: string }>
    }
    expect(list.notes.some((n) => n.id === result.note.id)).toBe(true)
  })

  it('notes_update wraps the mutated note in NoteUpdateResponse and bumps updatedAt', async () => {
    const before = (await notesRoutes.notes_get!({ id: 'note-2' })) as {
      updatedAt: number
    }
    const updated = (await notesRoutes.notes_update!({
      id: 'note-2',
      title: 'Renamed'
    })) as {
      success: boolean
      note: { id: string; title: string; updatedAt: number }
    }
    expect(updated.success).toBe(true)
    expect(updated.note.id).toBe('note-2')
    expect(updated.note.title).toBe('Renamed')
    expect(updated.note.updatedAt).toBeGreaterThanOrEqual(before.updatedAt)
  })

  it('notes_update rejects when id is unknown', async () => {
    await expect(notesRoutes.notes_update!({ id: 'note-missing', title: 'x' })).rejects.toThrow(
      /not found/i
    )
  })

  it('notes_delete soft-deletes the note (sets deletedAt) and returns success', async () => {
    const created = (await notesRoutes.notes_create!({ title: 'Doomed' })) as {
      note: { id: string }
    }
    const result = (await notesRoutes.notes_delete!({ id: created.note.id })) as {
      success: boolean
    }
    expect(result.success).toBe(true)
    const list = (await notesRoutes.notes_list!(undefined)) as {
      notes: Array<{ id: string }>
    }
    expect(list.notes.some((n) => n.id === created.note.id)).toBe(false)
  })

  it('notes_delete returns success:false for an unknown id', async () => {
    const result = (await notesRoutes.notes_delete!({ id: 'note-missing' })) as {
      success: boolean
    }
    expect(result.success).toBe(false)
  })

  it('includes a note with Turkish characters to cover UTF-8 handling', async () => {
    const list = (await notesRoutes.notes_list!(undefined)) as {
      notes: Array<{ title: string }>
    }
    expect(list.notes.some((n) => /[ğüşıöçĞÜŞİÖÇ]/.test(n.title))).toBe(true)
  })
})
