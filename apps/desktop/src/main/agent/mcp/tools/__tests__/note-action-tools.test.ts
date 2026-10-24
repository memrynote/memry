import { describe, expect, it, vi } from 'vitest'

import { AgentToolError } from '../../errors'
import {
  buildNoteActionTools,
  type ApproveArgs,
  type NoteActionHandles
} from '../note-action-tools'

const approveAll: ApproveArgs = async (_toolName, args) => args
const ctx = { writeGrant: 'grant', windowId: '7' }

function handles(notes: Partial<NoteActionHandles['notes']> = {}) {
  const insertAtCursor = vi.fn<NoteActionHandles['windows']['insertAtCursor']>(async () => {})
  const full: NoteActionHandles = {
    notes: {
      addTag: async () => {},
      removeTag: async () => {},
      moveToFolder: async () => ({}),
      copy: async ({ id }) => ({ id: `copy-of-${id}` }),
      read: async () => null,
      ...notes
    },
    windows: { insertAtCursor }
  }
  return { full, insertAtCursor }
}

describe('bulk note tools', () => {
  it('tags every note and reports a failing one without stopping the batch', async () => {
    const addTag = vi.fn<NoteActionHandles['notes']['addTag']>(async ({ id }) => {
      if (id === 'bad') throw new Error('Note not found: bad')
    })
    const removeTag = vi.fn<NoteActionHandles['notes']['removeTag']>(async () => {})
    const tools = buildNoteActionTools(handles({ addTag, removeTag }).full, approveAll)

    const reply = await tools.vault_bulk_tag_notes.handler(
      { ids: ['a', 'bad', 'c'], add: ['x'], remove: ['y'] },
      ctx
    )

    expect(reply).toEqual({
      succeeded: 2,
      failed: 1,
      results: [
        { id: 'a', ok: true },
        { id: 'bad', ok: false, error: 'Note not found: bad' },
        { id: 'c', ok: true }
      ]
    })
    expect(addTag).toHaveBeenCalledTimes(3)
    expect(removeTag).toHaveBeenCalledWith({ id: 'c', tag: 'y' })
  })

  it('refuses a bulk tag call that names no tag, before approval', async () => {
    const approve = vi.fn(approveAll)
    const tools = buildNoteActionTools(handles().full, approve as ApproveArgs)

    await expect(tools.vault_bulk_tag_notes.handler({ ids: ['a'] }, ctx)).rejects.toThrow(
      'Invalid tool input'
    )
    expect(approve).not.toHaveBeenCalled()
  })

  it('moves notes to one folder and reports created folders per note', async () => {
    const moveToFolder = vi.fn<NoteActionHandles['notes']['moveToFolder']>(async ({ id }) =>
      id === 'a' ? { created_folders: ['Archive'] } : {}
    )
    const tools = buildNoteActionTools(handles({ moveToFolder }).full, approveAll)

    await expect(
      tools.vault_bulk_move_notes.handler({ ids: ['a', 'b'], folder_path: 'Archive' }, ctx)
    ).resolves.toEqual({
      succeeded: 2,
      failed: 0,
      results: [
        { id: 'a', ok: true, created_folders: ['Archive'] },
        { id: 'b', ok: true }
      ]
    })
  })

  it('copies notes and names each copy', async () => {
    const copy = vi.fn<NoteActionHandles['notes']['copy']>(async ({ id }) => ({
      id: `copy-of-${id}`
    }))
    const tools = buildNoteActionTools(handles({ copy }).full, approveAll)

    await expect(
      tools.vault_copy_notes.handler({ ids: ['a'], folder_path: 'Backup' }, ctx)
    ).resolves.toEqual({
      succeeded: 1,
      failed: 0,
      results: [{ id: 'a', ok: true, copy_id: 'copy-of-a' }]
    })
    expect(copy).toHaveBeenCalledWith({ id: 'a', folder_path: 'Backup' })
  })

  it('writes nothing when the user denies the batch', async () => {
    const moveToFolder = vi.fn<NoteActionHandles['notes']['moveToFolder']>(async () => ({}))
    const tools = buildNoteActionTools(handles({ moveToFolder }).full, async () =>
      Promise.reject(new AgentToolError('PERMISSION_DENIED', 'no'))
    )

    await expect(
      tools.vault_bulk_move_notes.handler({ ids: ['a'], folder_path: 'Archive' }, ctx)
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(moveToFolder).not.toHaveBeenCalled()
  })
})

describe('vault_insert_at_cursor', () => {
  it('turns note links into wiki-link titles and sends them to the window', async () => {
    const { full, insertAtCursor } = handles({
      read: async (id) => ({
        id,
        title: `Title ${id}`,
        content_markdown: '',
        tags: [],
        folder_path: null,
        frontmatter: {},
        file_type: 'markdown'
      })
    })
    const tools = buildNoteActionTools(full, approveAll)

    await expect(
      tools.vault_insert_at_cursor.handler(
        {
          id: 'open',
          items: [
            { type: 'text', text: 'See ' },
            { type: 'note_link', note_id: 'n1' }
          ]
        },
        ctx
      )
    ).resolves.toEqual({ id: 'open', inserted: 2 })
    expect(insertAtCursor).toHaveBeenCalledWith('7', {
      noteId: 'open',
      items: [
        { type: 'text', text: 'See ' },
        { type: 'wikilink', title: 'Title n1' }
      ]
    })
  })

  it('inserts nothing when a linked note does not exist', async () => {
    const { full, insertAtCursor } = handles()
    const tools = buildNoteActionTools(full, approveAll)

    await expect(
      tools.vault_insert_at_cursor.handler(
        { id: 'open', items: [{ type: 'note_link', note_id: 'gone' }] },
        ctx
      )
    ).rejects.toThrow('Note not found: gone')
    expect(insertAtCursor).not.toHaveBeenCalled()
  })
})
