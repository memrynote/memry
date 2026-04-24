import { describe, it, expect } from 'vitest'

import { notesRoutes } from './notes'

describe('notesRoutes', () => {
  it('notes_list returns only non-deleted notes (12 fixtures)', async () => {
    const list = (await notesRoutes.notes_list!(undefined)) as Array<{ deletedAt: number | null }>
    expect(list).toHaveLength(12)
    expect(list.every((n) => n.deletedAt === null)).toBe(true)
  })

  it('notes_list_by_folder filters notes to that folder', async () => {
    const list = (await notesRoutes.notes_list_by_folder!({ folderId: 'folder-1' })) as Array<{
      folderId: string | null
    }>
    expect(list.length).toBeGreaterThanOrEqual(4)
    expect(list.every((n) => n.folderId === 'folder-1')).toBe(true)
  })

  it('notes_get returns the note when it exists', async () => {
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

  it('notes_create appends a new note with generated id and timestamps', async () => {
    const created = (await notesRoutes.notes_create!({
      title: 'New mock note',
      body: 'Body',
      folderId: 'folder-1'
    })) as {
      id: string
      title: string
      body: string
      folderId: string | null
      createdAt: number
      updatedAt: number
      deletedAt: number | null
    }
    expect(created.id).toMatch(/^note-\d+/)
    expect(created.title).toBe('New mock note')
    expect(created.body).toBe('Body')
    expect(created.folderId).toBe('folder-1')
    expect(created.createdAt).toBeGreaterThan(0)
    expect(created.updatedAt).toBe(created.createdAt)
    expect(created.deletedAt).toBeNull()

    const list = (await notesRoutes.notes_list!(undefined)) as Array<{ id: string }>
    expect(list.some((n) => n.id === created.id)).toBe(true)
  })

  it('notes_update mutates the note in place and bumps updatedAt', async () => {
    const before = (await notesRoutes.notes_get!({ id: 'note-2' })) as {
      updatedAt: number
    }
    const updated = (await notesRoutes.notes_update!({
      id: 'note-2',
      title: 'Renamed'
    })) as { id: string; title: string; updatedAt: number }
    expect(updated.id).toBe('note-2')
    expect(updated.title).toBe('Renamed')
    expect(updated.updatedAt).toBeGreaterThanOrEqual(before.updatedAt)
  })

  it('notes_update rejects when id is unknown', async () => {
    await expect(
      notesRoutes.notes_update!({ id: 'note-missing', title: 'x' })
    ).rejects.toThrow(/not found/i)
  })

  it('notes_delete soft-deletes the note (sets deletedAt) and returns ok', async () => {
    const created = (await notesRoutes.notes_create!({ title: 'Doomed' })) as { id: string }
    const result = (await notesRoutes.notes_delete!({ id: created.id })) as { ok: boolean }
    expect(result.ok).toBe(true)
    const list = (await notesRoutes.notes_list!(undefined)) as Array<{ id: string }>
    expect(list.some((n) => n.id === created.id)).toBe(false)
  })

  it('notes_delete returns ok:false for an unknown id', async () => {
    const result = (await notesRoutes.notes_delete!({ id: 'note-missing' })) as { ok: boolean }
    expect(result.ok).toBe(false)
  })

  it('includes a note with Turkish characters to cover UTF-8 handling', async () => {
    const list = (await notesRoutes.notes_list!(undefined)) as Array<{ title: string }>
    expect(list.some((n) => /[ğüşıöçĞÜŞİÖÇ]/.test(n.title))).toBe(true)
  })
})
