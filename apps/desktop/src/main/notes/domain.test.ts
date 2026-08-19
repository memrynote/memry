import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('../vault/notes', () => ({
  createNote: vi.fn(),
  updateNote: vi.fn(),
  renameNote: vi.fn(),
  moveNote: vi.fn(),
  deleteNote: vi.fn(),
  getNoteById: vi.fn()
}))

vi.mock('./runtime-effects', () => ({
  syncNoteCreate: vi.fn(),
  syncNoteUpdate: vi.fn(),
  syncNoteDelete: vi.fn(),
  setNoteLocalOnlyState: vi.fn(),
  cleanupProjectLinksForDeletedNote: vi.fn()
}))

import {
  createNoteCommand,
  updateNoteCommand,
  renameNoteCommand,
  moveNoteCommand,
  deleteNoteCommand,
  setNoteLocalOnlyCommand
} from './domain'
import * as noteVault from '../vault/notes'
import * as runtimeEffects from './runtime-effects'

describe('notes domain adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatches sync and CRDT side effects after creating a note', async () => {
    // `tags` is what the index holds — the frontmatter tag PLUS the body's
    // `#inline`. Only the declared one may reach the CRDT tag array, which
    // write-back serializes back into the file's `tags:` block (#1454).
    const note = {
      id: 'note-1',
      title: 'Test Note',
      tags: ['focus', 'inline'],
      frontmatter: { tags: ['focus'] }
    }
    vi.mocked(noteVault.createNote).mockResolvedValue(
      note as Awaited<ReturnType<typeof noteVault.createNote>>
    )

    const result = await createNoteCommand({
      title: 'Test Note',
      content: 'Hello world #inline'
    })

    expect(result).toBe(note)
    expect(noteVault.createNote).toHaveBeenCalledWith({
      title: 'Test Note',
      content: 'Hello world #inline'
    })
    expect(runtimeEffects.syncNoteCreate).toHaveBeenCalledWith('note-1', 'Test Note', ['focus'])
  })

  it('routes local-only changes through the notes domain adapter', async () => {
    const note = {
      id: 'note-1',
      title: 'Test Note'
    }
    vi.mocked(noteVault.getNoteById).mockResolvedValue(
      note as Awaited<ReturnType<typeof noteVault.getNoteById>>
    )

    const result = await setNoteLocalOnlyCommand({
      id: 'note-1',
      localOnly: true
    })

    expect(result).toBe(note)
    // localOnly is sidecar-only state — never written to file frontmatter
    expect(noteVault.updateNote).not.toHaveBeenCalled()
    expect(runtimeEffects.setNoteLocalOnlyState).toHaveBeenCalledWith('note-1', true)
    expect(noteVault.getNoteById).toHaveBeenCalledWith('note-1')
  })

  it('keeps note mutation sync orchestration out of IPC handlers', async () => {
    const note = {
      id: 'note-1',
      title: 'Renamed Note'
    }
    vi.mocked(noteVault.renameNote).mockResolvedValue(
      note as Awaited<ReturnType<typeof noteVault.renameNote>>
    )

    const result = await renameNoteCommand('note-1', 'Renamed Note')

    expect(result).toBe(note)
    expect(noteVault.renameNote).toHaveBeenCalledWith('note-1', 'Renamed Note')
    expect(runtimeEffects.syncNoteUpdate).toHaveBeenCalledWith('note-1', 'Renamed Note')
  })

  it('preserves update behavior while dispatching sync through the adapter', async () => {
    const note = {
      id: 'note-1',
      title: 'Updated Note'
    }
    vi.mocked(noteVault.updateNote).mockResolvedValue(
      note as Awaited<ReturnType<typeof noteVault.updateNote>>
    )

    const result = await updateNoteCommand({
      id: 'note-1',
      title: 'Updated Note',
      content: 'Updated content'
    })

    expect(result).toBe(note)
    expect(runtimeEffects.syncNoteUpdate).toHaveBeenCalledWith('note-1', 'Updated Note')
  })

  it('dispatches sync after moving a note', async () => {
    const movedNote = {
      id: 'note-1',
      path: 'notes/archive/Test Note.md'
    }
    vi.mocked(noteVault.moveNote).mockResolvedValue(
      movedNote as Awaited<ReturnType<typeof noteVault.moveNote>>
    )

    const moved = await moveNoteCommand('note-1', 'archive')

    expect(moved).toBe(movedNote)
    expect(noteVault.moveNote).toHaveBeenCalledWith('note-1', 'archive')
    expect(runtimeEffects.syncNoteUpdate).toHaveBeenCalledWith('note-1')
  })

  it('enqueues sync delete before removing the note', async () => {
    vi.mocked(noteVault.deleteNote).mockResolvedValue(
      undefined as Awaited<ReturnType<typeof noteVault.deleteNote>>
    )

    await deleteNoteCommand('note-1')

    expect(runtimeEffects.syncNoteDelete).toHaveBeenCalledWith('note-1')
    expect(noteVault.deleteNote).toHaveBeenCalledWith('note-1')
  })

  it('cleans up project links + home notes after deleting a note', async () => {
    vi.mocked(noteVault.deleteNote).mockResolvedValue(
      undefined as Awaited<ReturnType<typeof noteVault.deleteNote>>
    )

    await deleteNoteCommand('note-1')

    expect(runtimeEffects.cleanupProjectLinksForDeletedNote).toHaveBeenCalledWith('note-1')
  })

  it('does not clean up project links when the note delete fails', async () => {
    vi.mocked(noteVault.deleteNote).mockRejectedValue(new Error('locked'))

    await expect(deleteNoteCommand('note-1')).rejects.toThrow('locked')
    expect(runtimeEffects.cleanupProjectLinksForDeletedNote).not.toHaveBeenCalled()
  })

  it('does not call syncNoteUpdate when only content changes', async () => {
    const note = { id: 'note-1', title: 'Title' }
    vi.mocked(noteVault.updateNote).mockResolvedValue(
      note as Awaited<ReturnType<typeof noteVault.updateNote>>
    )

    await updateNoteCommand({ id: 'note-1', content: 'new content' })

    expect(runtimeEffects.syncNoteUpdate).not.toHaveBeenCalled()
  })

  it('propagates vault error from createNoteCommand without calling syncNoteCreate', async () => {
    vi.mocked(noteVault.createNote).mockRejectedValue(new Error('disk full'))

    await expect(createNoteCommand({ title: 'T', content: '' })).rejects.toThrow('disk full')
    expect(runtimeEffects.syncNoteCreate).not.toHaveBeenCalled()
  })

  it('still calls syncNoteDelete when deleteNote rejects (delete-before-remove contract)', async () => {
    vi.mocked(noteVault.deleteNote).mockRejectedValue(new Error('locked'))

    await expect(deleteNoteCommand('note-1')).rejects.toThrow('locked')
    expect(runtimeEffects.syncNoteDelete).toHaveBeenCalledWith('note-1')
  })
})
