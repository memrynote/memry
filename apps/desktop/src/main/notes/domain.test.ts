import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('../vault/notes', () => ({
  createNote: vi.fn(),
  updateNote: vi.fn(),
  renameNote: vi.fn(),
  moveNote: vi.fn(),
  deleteNote: vi.fn(),
  getNoteById: vi.fn()
}))

// No index row: every note here is a plain note, never a journal entry.
vi.mock('../database', () => ({ getIndexDatabase: vi.fn(() => ({})) }))
vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: vi.fn(() => undefined),
  extractDateFromPath: vi.fn(() => null)
}))

vi.mock('./runtime-effects', () => ({
  syncNoteCreate: vi.fn(),
  syncNoteUpdate: vi.fn(),
  syncNoteDelete: vi.fn(),
  setNoteLocalOnlyState: vi.fn(),
  cleanupProjectLinksForDeletedNote: vi.fn(),
  unlinkTasksFromDeletedNote: vi.fn(),
  queueEmbeddedVaultFiles: vi.fn()
}))

vi.mock('../sync/crdt-external-feed', () => ({ feedExternalEditToCrdt: vi.fn() }))

vi.mock('../vault-locks/registry', () => ({
  assertNoteWritable: vi.fn((noteId: string) => {
    if (noteId === 'locked-note') throw new Error('The owner made this note read-only.')
  })
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
import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'

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

  it.each([true, false])(
    'refuses a local-only change to a locked note (localOnly %s, #2606)',
    async (localOnly) => {
      await expect(setNoteLocalOnlyCommand({ id: 'locked-note', localOnly })).rejects.toThrow(
        'The owner made this note read-only.'
      )
      expect(runtimeEffects.setNoteLocalOnlyState).not.toHaveBeenCalled()
    }
  )

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

  it("drops the deleted note from its tasks' links, keeping the tasks", async () => {
    vi.mocked(noteVault.deleteNote).mockResolvedValue(
      undefined as Awaited<ReturnType<typeof noteVault.deleteNote>>
    )

    await deleteNoteCommand('note-1')

    expect(runtimeEffects.unlinkTasksFromDeletedNote).toHaveBeenCalledWith('note-1')
  })

  it('does not clean up project links when the note delete fails', async () => {
    vi.mocked(noteVault.deleteNote).mockRejectedValue(new Error('locked'))

    await expect(deleteNoteCommand('note-1')).rejects.toThrow('locked')
    expect(runtimeEffects.cleanupProjectLinksForDeletedNote).not.toHaveBeenCalled()
    expect(runtimeEffects.unlinkTasksFromDeletedNote).not.toHaveBeenCalled()
  })

  it('does not call syncNoteUpdate when only content changes', async () => {
    const note = { id: 'note-1', title: 'Title' }
    vi.mocked(noteVault.updateNote).mockResolvedValue(
      note as Awaited<ReturnType<typeof noteVault.updateNote>>
    )

    await updateNoteCommand({ id: 'note-1', content: 'new content' })

    expect(runtimeEffects.syncNoteUpdate).not.toHaveBeenCalled()
  })

  // `updateNote` moves the index hash to the new bytes, so nothing else feeds
  // the body to the note's CRDT doc (#2646). The file's `writing` frontmatter
  // is not passed, so an open doc keeps its own alternatives.
  it("feeds a body edit, and only a body edit, to the note's CRDT doc", async () => {
    const note = {
      id: 'note-1',
      title: 'Title',
      frontmatter: { writing: { alternatives: {}, overflow: [{ text: 'Cut line.' }] } }
    }
    vi.mocked(noteVault.updateNote).mockResolvedValue(
      note as unknown as Awaited<ReturnType<typeof noteVault.updateNote>>
    )

    await updateNoteCommand({ id: 'note-1', tags: ['focus'] })
    await updateNoteCommand({ id: 'note-1', content: 'new content' })

    expect(vi.mocked(feedExternalEditToCrdt).mock.calls).toEqual([['note-1', 'new content']])
  })

  // A body that embeds a vault file is the moment that file needs to reach the
  // server; waiting for the next backfill pass left it on this device (#2651).
  it('offers the files a written body embeds for upload, on create and on a body edit', async () => {
    vi.mocked(noteVault.createNote).mockResolvedValue({
      id: 'note-1',
      title: 'Title',
      content: '![shot](images/shot.png)',
      frontmatter: {}
    } as unknown as Awaited<ReturnType<typeof noteVault.createNote>>)
    vi.mocked(noteVault.updateNote).mockResolvedValue({
      id: 'note-1',
      title: 'Title'
    } as Awaited<ReturnType<typeof noteVault.updateNote>>)

    await createNoteCommand({ title: 'Title', content: '![shot](images/shot.png)' })
    await updateNoteCommand({ id: 'note-1', tags: ['focus'] })
    await updateNoteCommand({ id: 'note-1', content: 'now ![other](images/other.png)' })

    expect(vi.mocked(runtimeEffects.queueEmbeddedVaultFiles).mock.calls).toEqual([
      ['note-1', '![shot](images/shot.png)'],
      ['note-1', 'now ![other](images/other.png)']
    ])
  })

  it('saves the note and pushes its metadata when the CRDT feed throws', async () => {
    const note = { id: 'note-1', title: 'Renamed' }
    vi.mocked(noteVault.updateNote).mockResolvedValue(
      note as Awaited<ReturnType<typeof noteVault.updateNote>>
    )
    vi.mocked(feedExternalEditToCrdt).mockRejectedValueOnce(new Error('converter failed'))

    const saved = await updateNoteCommand({ id: 'note-1', title: 'Renamed', content: 'body' })

    expect(saved).toEqual({ id: 'note-1', title: 'Renamed' })
    expect(vi.mocked(runtimeEffects.syncNoteUpdate).mock.calls).toEqual([['note-1', 'Renamed']])
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
