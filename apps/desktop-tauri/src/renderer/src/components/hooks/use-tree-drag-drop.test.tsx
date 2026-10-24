import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getMockApi } from '@tests/utils/render'
import type { NoteListItem } from '@/hooks/use-notes-query'
import type { TreeStructure } from '@/lib/virtualized-tree-utils'
import { useTreeDragDrop } from './use-tree-drag-drop'

const note = (id: string, path: string): NoteListItem =>
  ({
    id,
    title: id,
    path,
    modified: new Date('2026-01-01T00:00:00.000Z'),
    created: new Date('2026-01-01T00:00:00.000Z'),
    tags: []
  }) as NoteListItem

const noteA = note('note-a', 'A/A.md')
const noteB = note('note-b', 'A/B.md')
const rootNote = note('note-root', 'Root.md')

const tree: TreeStructure = {
  rootNotes: [rootNote],
  folders: [
    {
      name: 'A',
      path: 'A',
      children: [{ name: 'Child', path: 'A/Child', children: [], notes: [] }],
      notes: [noteA, noteB]
    },
    { name: 'B', path: 'B', children: [], notes: [] }
  ]
}

function setup(selectedIds: string[] = []) {
  const setSelectedIds = vi.fn()
  const setNotePositions = vi.fn()
  const moveNoteMutateAsync = vi.fn().mockResolvedValue(undefined)
  const refreshFolders = vi.fn().mockResolvedValue(undefined)
  const noteMap = new Map([
    ['note-a', noteA],
    ['note-b', noteB],
    ['note-root', rootNote]
  ])

  const rendered = renderHook(() =>
    useTreeDragDrop({
      tree,
      noteMap,
      selectedIds,
      setSelectedIds,
      setNotePositions,
      moveNoteMutateAsync,
      refreshFolders
    })
  )

  return {
    ...rendered,
    setSelectedIds,
    setNotePositions,
    moveNoteMutateAsync,
    refreshFolders
  }
}

describe('useTreeDragDrop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const api = getMockApi() as {
      notes: {
        renameFolder: ReturnType<typeof vi.fn>
        reorder: ReturnType<typeof vi.fn>
        getAllPositions: ReturnType<typeof vi.fn>
      }
    }
    api.notes.renameFolder.mockResolvedValue({ success: true })
    api.notes.reorder.mockResolvedValue({ success: true })
    api.notes.getAllPositions.mockResolvedValue({
      success: true,
      positions: { 'A/B.md': 0, 'A/A.md': 1 }
    })
  })

  it('moves a note into the target folder and skips no-op same-folder moves', async () => {
    const { result, moveNoteMutateAsync } = setup()

    await act(async () => {
      await result.current.handleMove({
        draggedId: 'note-a',
        targetId: 'folder-B',
        position: 'inside'
      })
    })

    expect(moveNoteMutateAsync).toHaveBeenCalledWith({ id: 'note-a', newFolder: 'B' })

    await act(async () => {
      await result.current.handleMove({
        draggedId: 'note-a',
        targetId: 'note-b',
        position: 'inside'
      })
    })

    expect(moveNoteMutateAsync).toHaveBeenCalledTimes(1)
  })

  it('reorders notes inside the same folder and refreshes note positions', async () => {
    const api = getMockApi() as {
      notes: {
        reorder: ReturnType<typeof vi.fn>
      }
    }
    const { result, setNotePositions, moveNoteMutateAsync } = setup()

    await act(async () => {
      await result.current.handleMove({
        draggedId: 'note-a',
        targetId: 'note-b',
        position: 'after'
      })
    })

    expect(api.notes.reorder).toHaveBeenCalledWith('A', ['A/B.md', 'A/A.md'])
    expect(setNotePositions).toHaveBeenCalledWith({ 'A/B.md': 0, 'A/A.md': 1 })
    expect(moveNoteMutateAsync).not.toHaveBeenCalled()
  })

  it('reorders sibling folders and prevents moving a folder into its descendant', async () => {
    const api = getMockApi() as {
      notes: {
        renameFolder: ReturnType<typeof vi.fn>
        reorder: ReturnType<typeof vi.fn>
      }
    }
    const { result } = setup()

    await act(async () => {
      await result.current.handleMove({
        draggedId: 'folder-A',
        targetId: 'folder-B',
        position: 'after'
      })
    })

    expect(api.notes.reorder).toHaveBeenCalledWith('', ['B', 'A'])

    await act(async () => {
      await result.current.handleMove({
        draggedId: 'folder-A',
        targetId: 'folder-A/Child',
        position: 'inside'
      })
    })

    expect(api.notes.renameFolder).not.toHaveBeenCalled()
  })

  it('moves multiple selected items and clears the selection after the batch', async () => {
    const { result, moveNoteMutateAsync, setSelectedIds } = setup(['note-a', 'note-root'])

    await act(async () => {
      await result.current.handleMove({
        draggedId: 'note-a',
        targetId: 'folder-B',
        position: 'inside'
      })
    })

    expect(moveNoteMutateAsync).toHaveBeenCalledWith({ id: 'note-a', newFolder: 'B' })
    expect(moveNoteMutateAsync).toHaveBeenCalledWith({ id: 'note-root', newFolder: 'B' })
    expect(setSelectedIds).toHaveBeenCalledWith([])
  })
})
