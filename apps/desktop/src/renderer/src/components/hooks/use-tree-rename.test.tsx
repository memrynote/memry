import { act, renderHook } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTreeRename } from './use-tree-rename'
import { notesService } from '@/services/notes-service'
import { toast } from 'sonner'

vi.mock('@/services/notes-service', () => ({
  notesService: {
    renameFolder: vi.fn()
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn()
  })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

function renderRenameHook(overrides: Partial<Parameters<typeof useTreeRename>[0]> = {}) {
  const queryClient = {
    setQueryData: vi.fn()
  } as unknown as QueryClient
  const options = {
    renameNoteMutateAsync: vi.fn().mockResolvedValue({ ok: true }),
    updateTabTitleByEntityId: vi.fn(),
    queryClient,
    refreshFolders: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }

  return { ...renderHook(() => useTreeRename(options)), options }
}

describe('useTreeRename', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
  })

  it('starts note rename and keeps tab/cache title optimistic while typing', () => {
    const { result, options } = renderRenameHook()

    act(() => {
      result.current.handleRenameClick({ id: 'note-1', path: 'Projects/Old title.md' } as never)
    })

    expect(result.current.renamingNoteId).toBe('note-1')
    expect(result.current.renameValue).toBe('Old title')

    act(() => {
      result.current.handleRenameInputChange('note-1', '')
    })

    expect(options.updateTabTitleByEntityId).toHaveBeenCalledWith('note-1', 'Untitled')
    expect(options.queryClient.setQueryData).toHaveBeenCalled()
  })

  it('submits changed note names and cancels unchanged or empty edits', async () => {
    const { result, options } = renderRenameHook()

    act(() => {
      result.current.handleRenameClick({ id: 'note-1', path: 'Old title.md' } as never)
      result.current.handleRenameInputChange('note-1', 'New title')
    })
    await act(async () => {
      await result.current.handleRenameSubmit('note-1', 'Old title.md')
    })

    expect(options.renameNoteMutateAsync).toHaveBeenCalledWith({
      id: 'note-1',
      newTitle: 'New title'
    })
    expect(result.current.renamingNoteId).toBeNull()

    vi.mocked(options.renameNoteMutateAsync).mockClear()
    act(() => {
      result.current.handleRenameClick({ id: 'note-1', path: 'Same.md' } as never)
      result.current.handleRenameInputChange('note-1', 'Same')
    })
    await act(async () => {
      await result.current.handleRenameSubmit('note-1', 'Same.md')
    })
    expect(options.renameNoteMutateAsync).not.toHaveBeenCalled()

    act(() => {
      result.current.handleRenameInputChange('note-1', '   ')
    })
    await act(async () => {
      await result.current.handleRenameSubmit('note-1', 'Same.md')
    })
    expect(options.renameNoteMutateAsync).not.toHaveBeenCalled()
  })

  it('reverts optimistic note rename and shows a toast on failure', async () => {
    const error = new Error('rename failed')
    const { result, options } = renderRenameHook({
      renameNoteMutateAsync: vi.fn().mockRejectedValue(error)
    })

    act(() => {
      result.current.handleRenameClick({ id: 'note-1', path: 'Old.md' } as never)
      result.current.handleRenameInputChange('note-1', 'New')
    })
    await act(async () => {
      await result.current.handleRenameSubmit('note-1', 'Old.md')
    })

    expect(options.updateTabTitleByEntityId).toHaveBeenLastCalledWith('note-1', 'Old')
    expect(toast.error).toHaveBeenCalledWith('rename failed')
    expect(result.current.isRenaming).toBe(false)
  })

  it('renames folders, refreshes folder data, and supports cancel/no-op branches', async () => {
    const { result, options } = renderRenameHook()
    vi.mocked(notesService.renameFolder).mockResolvedValue({ ok: true } as never)

    act(() => {
      result.current.handleRenameFolderClick('Work/Old')
      result.current.setFolderRenameValue('New')
    })
    await act(async () => {
      await result.current.handleFolderRenameSubmit('Work/Old')
    })

    expect(notesService.renameFolder).toHaveBeenCalledWith('Work/Old', 'Work/New')
    expect(options.refreshFolders).toHaveBeenCalled()
    expect(result.current.renamingFolderPath).toBeNull()

    vi.mocked(notesService.renameFolder).mockClear()
    act(() => {
      result.current.handleRenameFolderClick('Inbox')
    })
    await act(async () => {
      await result.current.handleFolderRenameSubmit('Inbox')
    })
    expect(notesService.renameFolder).not.toHaveBeenCalled()

    act(() => {
      result.current.handleRenameFolderClick('Inbox')
      result.current.handleFolderRenameCancel()
    })
    expect(result.current.renamingFolderPath).toBeNull()
    expect(result.current.folderRenameValue).toBe('')
  })

  it('shows a toast when folder rename fails', async () => {
    const { result } = renderRenameHook()
    vi.mocked(notesService.renameFolder).mockRejectedValue(new Error('folder failed'))

    act(() => {
      result.current.handleRenameFolderClick('Old')
      result.current.setFolderRenameValue('New')
    })
    await act(async () => {
      await result.current.handleFolderRenameSubmit('Old')
    })

    expect(toast.error).toHaveBeenCalledWith('folder failed')
    expect(result.current.isFolderRenaming).toBe(false)
    expect(result.current.renamingFolderPath).toBeNull()
  })
})
