import { describe, expect, it, vi } from 'vitest'
import type { AgentMcpDesktopWriteOperation } from '@memry/contracts/agent-mcp-channels'

import { desktopWriteReadback, writeAndReadBack } from '../desktop-api-readback'

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

  it('read back the merge target tag and the renamed property record', () => {
    expect(readBack('tags.mergeTag', [{ source: 'job', target: 'Work' }], tags).stored).toEqual(
      tags.tags[0]
    )
    const properties = { status: 'done' }
    expect(readBack('properties.rename', ['n1', 'state', 'status'], properties)).toEqual({
      request: { operation: 'properties.get', args: ['n1'] },
      stored: properties
    })
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
    expect(readBack('notes.createFolder', ['/work/plans/'], folders)).toEqual({
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

  it("reply to a status update with the status as the project's status list stores it", async () => {
    const replies: Record<string, unknown> = {
      'tasks.updateStatus': { success: true, status: { id: 's1', projectId: 'p1', name: 'Old' } },
      'tasks.listStatuses': [
        { id: 's0', projectId: 'p1', name: 'Todo' },
        { id: 's1', projectId: 'p1', name: 'Doing' }
      ]
    }
    const invoke = vi.fn(async (request: { operation: string }) => replies[request.operation])
    const reply = await writeAndReadBack(
      { operation: 'tasks.updateStatus', args: ['s1', { name: 'Doing' }] },
      invoke,
      async () => ({})
    )
    expect(invoke).toHaveBeenLastCalledWith({ operation: 'tasks.listStatuses', args: ['p1'] })
    expect(reply).toMatchObject({ stored: { id: 's1', projectId: 'p1', name: 'Doing' } })
  })

  it('reply to filing an inbox item with the filed item', async () => {
    const filed = { id: 'i1', filedTo: 'work', filedAction: 'folder' }
    const invoke = vi.fn(async (request: { operation: string }) =>
      request.operation === 'inbox.file' ? { success: true, filedTo: 'work', noteId: 'n1' } : filed
    )
    const reply = await writeAndReadBack(
      {
        operation: 'inbox.file',
        args: [{ itemId: 'i1', destination: { type: 'folder', path: 'work' } }]
      },
      invoke,
      async () => ({})
    )
    expect(invoke).toHaveBeenLastCalledWith({ operation: 'inbox.get', args: ['i1'] })
    expect(reply).toEqual({ success: true, filedTo: 'work', noteId: 'n1', stored: filed })
  })
})
