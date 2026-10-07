import { describe, expect, it } from 'vitest'
import type { AgentMcpDesktopWriteOperation } from '@memry/contracts/agent-mcp-channels'

import { desktopWriteReadback } from '../desktop-api-readback'

function readBack(operation: AgentMcpDesktopWriteOperation, args: unknown[], data: unknown) {
  const readback = desktopWriteReadback({ operation, args })
  if (!readback) throw new Error(`${operation} has no read-back`)
  return { request: readback.request, stored: readback.select(data) }
}

describe('desktop write read-backs', () => {
  const tags = { tags: [{ name: 'work', color: 'blue', count: 2 }] }

  it('find a tag the agent named in another case or with padding, as the tag writers store it', () => {
    expect(readBack('tags.updateTagColor', [{ tag: 'WORK', color: 'blue' }], tags).stored).toEqual(
      tags.tags[0]
    )
    expect(readBack('tags.updateTagIcon', [{ tag: ' Work ', icon: null }], tags).stored).toEqual(
      tags.tags[0]
    )
    expect(
      readBack('tags.renameTag', [{ oldName: 'job', newName: '  Work ' }], tags).stored
    ).toEqual(tags.tags[0])
  })

  it('read back the folder view config and the saved view', () => {
    const config = { config: { path: 'work', views: [] }, isDefault: false }
    expect(readBack('folderView.setConfig', ['work', { views: [] }], config)).toEqual({
      request: { operation: 'folderView.getConfig', args: ['work'] },
      stored: config
    })

    const scope = { kind: 'folder', path: 'work' }
    const board = { name: 'Board', type: 'table' }
    expect(
      readBack('folderView.setView', [scope, board, undefined], {
        views: [{ name: 'All', type: 'table' }, board],
        defaultIndex: 0
      })
    ).toEqual({ request: { operation: 'folderView.getViews', args: [scope] }, stored: board })
  })

  it('read back whether a note is pinned to a tag', () => {
    const notes = {
      tag: 'work',
      color: 'blue',
      count: 2,
      pinnedNotes: [{ id: 'n1', title: 'Pinned', isPinned: true }],
      unpinnedNotes: [{ id: 'n2', title: 'Loose', isPinned: false }]
    }
    expect(readBack('tags.pinNoteToTag', [{ noteId: 'n1', tag: 'work' }], notes)).toEqual({
      request: { operation: 'tags.getNotesByTag', args: [{ tag: 'work' }] },
      stored: notes.pinnedNotes[0]
    })
    expect(
      readBack('tags.unpinNoteFromTag', [{ noteId: 'n2', tag: 'work' }], notes).stored
    ).toEqual(notes.unpinnedNotes[0])
  })

  it("read back a note's tags after a tag is removed from it", () => {
    const note = { id: 'n1', title: 'Plan', content: 'long body', tags: ['home'] }
    expect(readBack('tags.removeTagFromNote', [{ noteId: 'n1', tag: 'work' }], note)).toEqual({
      request: { operation: 'notes.get', args: ['n1'] },
      stored: { id: 'n1', tags: ['home'] }
    })
  })

  it('read back a created or renamed folder', () => {
    const folders = [{ path: 'work' }, { path: 'work/plans', icon: null }]
    expect(readBack('notes.createFolder', ['work/plans'], folders)).toEqual({
      request: { operation: 'notes.getFolders', args: [] },
      stored: folders[1]
    })
    expect(readBack('notes.renameFolder', ['old', 'work/plans'], folders).stored).toEqual(
      folders[1]
    )
  })

  it('read back the inbox item after an undo', () => {
    const item = { id: 'i1', title: 'Back in the inbox' }
    for (const operation of ['inbox.undoFile', 'inbox.undoArchive'] as const) {
      expect(readBack(operation, ['i1'], item)).toEqual({
        request: { operation: 'inbox.get', args: ['i1'] },
        stored: item
      })
    }
  })
})
