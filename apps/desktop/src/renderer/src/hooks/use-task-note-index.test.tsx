import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

import { useTaskNoteIndex } from './use-task-note-index'
import { NOTE_TREE_PAGE_SIZE } from './use-note-tree-data'

interface NotesListArgs {
  limit?: number
  fields?: string
  enabled?: boolean
}

const useNotesListMock = vi.fn()

vi.mock('@/hooks/use-notes-query', () => ({
  useNotesList: (options: NotesListArgs) => useNotesListMock(options)
}))

const note = (id: string, path: string, title: string) => ({
  id,
  path,
  title,
  created: new Date(),
  modified: new Date(),
  tags: [],
  wordCount: 0
})

describe('useTaskNoteIndex', () => {
  beforeEach(() => {
    useNotesListMock.mockReset()
    useNotesListMock.mockReturnValue({ notes: [], isLoading: false })
  })

  it('should not fetch the notes list until a caller asks for the index', () => {
    // #when
    const { result } = renderHook(() => useTaskNoteIndex(false))

    // #then
    expect(useNotesListMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, fields: 'tree' })
    )
    expect(result.current).toBeUndefined()
  })

  it('should request the same page the sidebar tree does, so the cache is shared', () => {
    // #when
    renderHook(() => useTaskNoteIndex(true))

    // #then
    expect(useNotesListMock).toHaveBeenCalledWith({
      limit: NOTE_TREE_PAGE_SIZE,
      fields: 'tree',
      enabled: true
    })
  })

  it('should stay undefined while the list is loading rather than report everything unfiled', () => {
    // #given
    useNotesListMock.mockReturnValue({ notes: [], isLoading: true })

    // #when
    const { result } = renderHook(() => useTaskNoteIndex(true))

    // #then
    expect(result.current).toBeUndefined()
  })

  it('should map note ids to their title and vault-relative folder', () => {
    // #given
    useNotesListMock.mockReturnValue({
      notes: [
        note('note-msa', 'Acme/Legal/msa.md', 'MSA'),
        note('note-scratch', 'scratch.md', 'Scratch')
      ],
      isLoading: false
    })

    // #when
    const { result } = renderHook(() => useTaskNoteIndex(true))

    // #then
    expect(result.current?.get('note-msa')).toEqual({
      id: 'note-msa',
      title: 'MSA',
      folderPath: 'Acme/Legal'
    })
    expect(result.current?.get('note-scratch')?.folderPath).toBe('')
  })
})
