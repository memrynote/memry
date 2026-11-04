import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { useTreeDelete } from './use-tree-delete'

const deleteFolder = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/services/notes-service', () => ({ notesService: { deleteFolder } }))

function render() {
  const setSelectedIds = vi.fn()
  const refreshFolders = vi.fn().mockResolvedValue(undefined)
  const hook = renderHook(() =>
    useTreeDelete({
      selectedIds: ['folder-Work'],
      setSelectedIds,
      noteMap: new Map(),
      deleteNoteMutateAsync: vi.fn().mockResolvedValue({ success: true }),
      closeTab: vi.fn(),
      refreshFolders
    })
  )
  return { hook, setSelectedIds, refreshFolders }
}

describe('useTreeDelete', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says why a folder the app could not delete stays, and keeps the dialog open', async () => {
    deleteFolder.mockResolvedValueOnce({
      success: false,
      error: 'The OS trash refused the folder'
    })
    const { hook, setSelectedIds } = render()

    act(() => hook.result.current.handleBulkDelete())
    expect(hook.result.current.foldersToDelete).toEqual(['Work'])
    await act(async () => {
      await hook.result.current.handleDeleteConfirm()
    })

    expect(deleteFolder).toHaveBeenCalledWith('Work')
    expect(toast.error).toHaveBeenCalledWith('The OS trash refused the folder')
    expect(hook.result.current.isDeleteDialogOpen).toBe(true)
    expect(setSelectedIds).not.toHaveBeenCalled()
  })

  it('closes the dialog once the folder is deleted', async () => {
    deleteFolder.mockResolvedValueOnce({ success: true })
    const { hook, refreshFolders } = render()

    act(() => hook.result.current.handleBulkDelete())
    await act(async () => {
      await hook.result.current.handleDeleteConfirm()
    })

    expect(refreshFolders).toHaveBeenCalled()
    expect(hook.result.current.isDeleteDialogOpen).toBe(false)
    expect(toast.error).not.toHaveBeenCalled()
  })
})
