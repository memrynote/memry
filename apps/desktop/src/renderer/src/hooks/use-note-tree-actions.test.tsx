import type React from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { useNoteTreeActions, type NoteTreeActionsDeps } from './use-note-tree-actions'
import type { NoteListItem } from './use-notes-query'
import { buildTreeFromNotes } from '@/components/notes-tree-utils'
import { notesService } from '@/services/notes-service'

const mocks = vi.hoisted(() => ({
  createInSelectedFolder: true,
  openTab: vi.fn(),
  closeTab: vi.fn(),
  updateTabTitleByEntityId: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn()
  })
}))

vi.mock('@/lib/ipc-error', () => ({
  extractErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({
    settings: { createInSelectedFolder: mocks.createInSelectedFolder }
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabActions: () => ({
    openTab: mocks.openTab,
    closeTab: mocks.closeTab,
    updateTabTitleByEntityId: mocks.updateTabTitleByEntityId
  })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    getFolderTemplate: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    getFolderConfig: vi.fn(),
    setFolderConfig: vi.fn(),
    reorder: vi.fn(),
    getAllPositions: vi.fn(),
    openExternal: vi.fn(),
    revealInFinder: vi.fn()
  }
}))

const createNote = (id: string, path: string, overrides: Partial<NoteListItem> = {}) =>
  ({
    id,
    path,
    title:
      path
        .split('/')
        .pop()
        ?.replace(/\.[^.]+$/, '') ?? id,
    emoji: null,
    fileType: 'markdown',
    created: new Date('2026-01-01T00:00:00.000Z'),
    modified: new Date(`2026-01-0${id.endsWith('a') ? 1 : id.endsWith('b') ? 2 : 3}T00:00:00.000Z`),
    tags: [],
    properties: {},
    ...overrides
  }) as NoteListItem

const rootNote = createNote('root', 'notes/Root.md')
const workA = createNote('work-a', 'notes/Work/A.md')
const workB = createNote('work-b', 'notes/Work/B.md')
const otherNote = createNote('other', 'notes/Other/C.pdf', { fileType: 'pdf' })

const folders = [{ path: 'Work' }, { path: 'Other' }, { path: 'Work/Nested' }] as any[]
const allNotes = [rootNote, workA, workB, otherNote]
const noteMap = new Map(allNotes.map((note) => [note.id, note]))
const tree = buildTreeFromNotes(
  allNotes,
  folders,
  {
    'notes/Work/A.md': 1,
    'notes/Work/B.md': 2,
    Work: 1,
    Other: 2
  },
  'notes'
)

const createMutations = () =>
  ({
    createNote: {
      mutateAsync: vi.fn().mockResolvedValue({
        success: true,
        note: createNote('new-note', 'notes/Work/Untitled.md')
      })
    },
    renameNote: { mutateAsync: vi.fn().mockResolvedValue({ success: true }) },
    deleteNote: { mutateAsync: vi.fn().mockResolvedValue({ success: true }) },
    moveNote: { mutateAsync: vi.fn().mockResolvedValue({ success: true }) }
  }) as any

const renderActions = (overrides: Partial<NoteTreeActionsDeps> = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 }
    }
  })
  const mutations = overrides.mutations ?? createMutations()
  const deps: NoteTreeActionsDeps = {
    noteMap,
    tree,
    folders,
    notePositions: {},
    setNotePositions: vi.fn(),
    folderTemplateNames: new Map(),
    setFolderTemplateNames: vi.fn(),
    createFolderMutation: vi.fn().mockResolvedValue(true),
    refreshFolders: vi.fn().mockResolvedValue(undefined),
    setFolderIcon: vi.fn().mockResolvedValue(true),
    mutations,
    selectedIds: ['folder-Work'],
    setSelectedIds: vi.fn(),
    computeTargetFolder: vi.fn().mockReturnValue('Work'),
    expandFolderPath: vi.fn(),
    ...overrides
  }

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  return {
    ...renderHook(() => useNoteTreeActions(deps), { wrapper }),
    deps,
    mutations,
    queryClient
  }
}

describe('useNoteTreeActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createInSelectedFolder = true
    window.api.templates.list.mockResolvedValue({
      success: true,
      templates: [{ id: 'tpl-1', name: 'Meeting note' }]
    })
    vi.mocked(notesService.getFolderTemplate).mockResolvedValue('tpl-1')
    vi.mocked(notesService.renameFolder).mockResolvedValue(true)
    vi.mocked(notesService.deleteFolder).mockResolvedValue(true)
    vi.mocked(notesService.setFolderConfig).mockResolvedValue({ success: true })
    vi.mocked(notesService.reorder).mockResolvedValue({ success: true })
    vi.mocked(notesService.getAllPositions).mockResolvedValue({
      success: true,
      positions: { 'notes/Work/B.md': 1 }
    })
    vi.mocked(notesService.openExternal).mockResolvedValue(undefined)
    vi.mocked(notesService.revealInFinder).mockResolvedValue(undefined)
  })

  it('opens selected notes, folders, and creates notes/folders in the selected folder', async () => {
    const { result, deps, mutations } = renderActions()

    act(() => result.current.handleSelectionChange(['work-a']))
    expect(deps.setSelectedIds).toHaveBeenCalledWith(['work-a'])
    expect(mocks.openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'note',
        title: 'A',
        path: '/notes/work-a',
        entityId: 'work-a'
      })
    )

    act(() => result.current.handleSelectionChange(['other']))
    expect(mocks.openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'file',
        title: 'C',
        path: '/file/other',
        entityId: 'other'
      })
    )

    act(() => result.current.handleOpenFolderView('Work/Nested'))
    expect(mocks.openTab).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'folder', title: 'Nested', path: '/folder/Work%2FNested' })
    )

    await act(async () => {
      await result.current.handleCreateNote()
    })
    expect(deps.expandFolderPath).toHaveBeenCalledWith('Work')
    expect(notesService.getFolderTemplate).toHaveBeenCalledWith('Work')
    expect(mutations.createNote.mutateAsync).toHaveBeenCalledWith({
      title: 'Untitled',
      folder: 'Work',
      template: 'tpl-1'
    })
    expect(result.current.renamingNoteId).toBe('new-note')

    await act(async () => {
      await result.current.handleCreateFolder()
    })
    expect(deps.createFolderMutation).toHaveBeenCalledWith('Work/Untitled Folder')
    expect(deps.refreshFolders).toHaveBeenCalled()
    expect(result.current.renamingFolderPath).toBe('Work/Untitled Folder')

    await act(async () => {
      await result.current.handleCreateSubfolder('Work')
    })
    expect(deps.createFolderMutation).toHaveBeenCalledWith('Work/Untitled Folder')
  })

  it('handles optimistic note rename, cancel, submit, and failure rollback', async () => {
    const mutations = createMutations()
    const { result, queryClient } = renderActions({ mutations })
    queryClient.setQueryData(['notes', 'note', 'work-a'], { id: 'work-a', title: 'A' })

    act(() => result.current.handleRenameClick(workA))
    expect(result.current.renamingNoteId).toBe('work-a')
    expect(result.current.renameValue).toBe('A')

    act(() => result.current.handleRenameInputChange('work-a', 'Renamed'))
    expect(mocks.updateTabTitleByEntityId).toHaveBeenLastCalledWith('work-a', 'Renamed')
    expect(queryClient.getQueryData<any>(['notes', 'note', 'work-a'])?.title).toBe('Renamed')

    await act(async () => {
      await result.current.handleRenameSubmit('work-a', workA.path)
    })
    expect(mutations.renameNote.mutateAsync).toHaveBeenCalledWith({
      id: 'work-a',
      newTitle: 'Renamed'
    })
    expect(result.current.renamingNoteId).toBeNull()

    mutations.renameNote.mutateAsync.mockRejectedValueOnce(new Error('rename failed'))
    act(() => result.current.handleRenameClick(workA))
    act(() => result.current.handleRenameInputChange('work-a', 'Broken'))
    await act(async () => {
      await result.current.handleRenameSubmit('work-a', workA.path)
    })
    expect(mocks.updateTabTitleByEntityId).toHaveBeenLastCalledWith('work-a', 'A')
    expect(toast.error).toHaveBeenCalledWith('rename failed')

    act(() => result.current.handleRenameClick(workA))
    act(() => result.current.handleRenameCancel('work-a'))
    expect(result.current.renamingNoteId).toBeNull()
    expect(result.current.renameValue).toBe('')
  })

  it('renames folders, deletes notes and folders, and invokes external file actions', async () => {
    const { result, deps, mutations } = renderActions({
      selectedIds: ['work-a', 'folder-Work/Nested']
    })

    act(() => result.current.handleRenameFolderClick('Work/Nested'))
    act(() => result.current.setFolderRenameValue('Ideas'))
    await act(async () => {
      await result.current.handleFolderRenameSubmit('Work/Nested')
    })
    expect(notesService.renameFolder).toHaveBeenCalledWith('Work/Nested', 'Work/Ideas')
    expect(deps.refreshFolders).toHaveBeenCalled()

    act(() => result.current.handleDeleteClick(workA))
    expect(result.current.notesToDelete).toEqual([workA])
    expect(result.current.foldersToDelete).toEqual([])

    act(() => result.current.handleBulkDelete())
    expect(result.current.notesToDelete).toEqual([workA])
    expect(result.current.foldersToDelete).toEqual(['Work/Nested'])

    await act(async () => {
      await result.current.handleDeleteConfirm()
    })
    expect(mutations.deleteNote.mutateAsync).toHaveBeenCalledWith('work-a')
    expect(notesService.deleteFolder).toHaveBeenCalledWith('Work/Nested')
    expect(mocks.closeTab).toHaveBeenCalledWith('/notes/work-a')
    expect(deps.setSelectedIds).toHaveBeenLastCalledWith([])

    await act(async () => {
      await result.current.handleOpenExternal(workA)
      await result.current.handleRevealInFinder(workA)
    })
    expect(notesService.openExternal).toHaveBeenCalledWith('work-a')
    expect(notesService.revealInFinder).toHaveBeenCalledWith('work-a')
  })

  it('sets and clears folder templates preserving the existing folder config', async () => {
    const setFolderTemplateNames = vi.fn(
      (updater: (prev: Map<string, string>) => Map<string, string>) => updater(new Map())
    )
    vi.mocked(notesService.getFolderConfig).mockResolvedValue({ icon: '📁', template: 'old-tpl' })
    const { result } = renderActions({ setFolderTemplateNames })

    act(() => result.current.handleSetFolderTemplate('Work'))
    expect(result.current.folderToConfigureTemplate).toBe('Work')

    await act(async () => {
      await result.current.handleFolderTemplateSelect('tpl-1')
    })
    expect(notesService.setFolderConfig).toHaveBeenCalledWith('Work', {
      icon: '📁',
      template: 'tpl-1',
      inherit: true
    })
    expect(setFolderTemplateNames).toHaveBeenCalled()
    expect(toast.success).toHaveBeenCalledWith('phaseI.toasts.defaultTemplateSet')
    expect(result.current.folderToConfigureTemplate).toBeNull()

    await act(async () => {
      await result.current.handleClearFolderTemplate('Work')
    })
    const clearArg = vi.mocked(notesService.setFolderConfig).mock.lastCall?.[1]
    expect(clearArg).toEqual({ icon: '📁', inherit: true })
    expect(clearArg && 'template' in clearArg).toBe(false)
    expect(toast.success).toHaveBeenCalledWith('phaseI.toasts.defaultTemplateCleared')
  })

  it('handles note reorders, folder reorders, folder moves, and multi-selection moves', async () => {
    const { result, deps, mutations } = renderActions()

    await act(async () => {
      await result.current.handleMove({
        draggedId: 'work-a',
        targetId: 'work-b',
        position: 'after'
      })
    })
    expect(notesService.reorder).toHaveBeenCalledWith('Work', [
      'notes/Work/B.md',
      'notes/Work/A.md'
    ])
    expect(deps.setNotePositions).toHaveBeenCalledWith({ 'notes/Work/B.md': 1 })
    expect(mutations.moveNote.mutateAsync).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.handleMove({
        draggedId: 'folder-Work',
        targetId: 'folder-Other',
        position: 'after'
      })
    })
    expect(notesService.reorder).toHaveBeenLastCalledWith('', ['Other', 'Work'])

    await act(async () => {
      await result.current.handleMove({
        draggedId: 'folder-Other',
        targetId: 'folder-Work',
        position: 'inside'
      })
    })
    expect(notesService.renameFolder).toHaveBeenCalledWith('Other', 'Work/Other')

    const selected = renderActions({
      selectedIds: ['work-a', 'work-b'],
      mutations: createMutations()
    })
    await act(async () => {
      await selected.result.current.handleMove({
        draggedId: 'work-a',
        targetId: 'folder-Other',
        position: 'inside'
      })
    })
    expect(selected.mutations.moveNote.mutateAsync).toHaveBeenCalledWith({
      id: 'work-a',
      newFolder: 'Other'
    })
    expect(selected.mutations.moveNote.mutateAsync).toHaveBeenCalledWith({
      id: 'work-b',
      newFolder: 'Other'
    })
    expect(selected.deps.setSelectedIds).toHaveBeenCalledWith([])

    await waitFor(() => expect(result.current.isMoving).toBe(false))
  })

  it('handles no-op and failure paths without leaving transient state stuck', async () => {
    mocks.createInSelectedFolder = false
    const mutations = createMutations()
    const { result, deps } = renderActions({
      folders: [
        ...folders,
        { path: 'Untitled Folder' },
        { path: 'Untitled Folder 1' },
        { path: 'Work/Untitled Folder' }
      ] as any,
      mutations
    })

    mutations.createNote.mutateAsync.mockRejectedValueOnce(new Error('create failed'))
    await act(async () => {
      await result.current.handleCreateNote()
    })
    expect(toast.error).toHaveBeenCalledWith('create failed')
    expect(deps.expandFolderPath).toHaveBeenCalledWith('')

    await act(async () => {
      await result.current.handleCreateNoteInFolder('Other')
    })
    expect(mutations.createNote.mutateAsync).toHaveBeenLastCalledWith({
      title: 'Untitled',
      folder: 'Other',
      template: 'tpl-1'
    })

    await act(async () => {
      await result.current.handleCreateFolder()
    })
    expect(deps.createFolderMutation).toHaveBeenCalledWith('Untitled Folder 2')

    act(() => result.current.handleRenameClick(workA))
    act(() => result.current.handleRenameInputChange('work-a', '   '))
    await act(async () => {
      await result.current.handleRenameSubmit('work-a', workA.path)
    })
    expect(result.current.renamingNoteId).toBeNull()

    act(() => result.current.handleRenameFolderClick('Work/Nested'))
    act(() => result.current.setFolderRenameValue('Nested'))
    await act(async () => {
      await result.current.handleFolderRenameSubmit('Work/Nested')
    })
    expect(notesService.renameFolder).not.toHaveBeenCalledWith('Work/Nested', 'Work/Nested')

    act(() => result.current.handleRenameFolderClick('Work/Nested'))
    act(() => result.current.handleFolderRenameCancel())
    expect(result.current.renamingFolderPath).toBeNull()

    await act(async () => {
      await result.current.handleDeleteConfirm()
    })
    expect(mutations.deleteNote.mutateAsync).not.toHaveBeenCalled()
  })

  it('surfaces folder template and drag move failures without throwing', async () => {
    const setFolderTemplateNames = vi.fn(
      (updater: (prev: Map<string, string>) => Map<string, string>) =>
        updater(new Map([['Work', 'Meeting note']]))
    )
    const mutations = createMutations()
    const { result } = renderActions({
      setFolderTemplateNames,
      mutations,
      selectedIds: ['folder-Work']
    })

    act(() => result.current.handleSetFolderTemplate('Work'))
    await act(async () => {
      await result.current.handleFolderTemplateSelect(null)
    })
    expect(result.current.folderToConfigureTemplate).toBeNull()

    vi.mocked(notesService.setFolderConfig).mockRejectedValueOnce(new Error('template failed'))
    act(() => result.current.handleSetFolderTemplate('Work'))
    await act(async () => {
      await result.current.handleFolderTemplateSelect('tpl-1')
    })
    expect(toast.error).toHaveBeenCalledWith('phaseI.toasts.failedToSetDefaultTemplate')

    vi.mocked(notesService.setFolderConfig).mockRejectedValueOnce(new Error('clear failed'))
    await act(async () => {
      await result.current.handleClearFolderTemplate('Work')
    })
    expect(toast.error).toHaveBeenCalledWith('phaseI.toasts.failedToClearDefaultTemplate')

    await act(async () => {
      await result.current.handleMove({
        draggedId: 'folder-Work',
        targetId: 'folder-Work/Nested',
        position: 'inside'
      })
    })
    expect(notesService.renameFolder).not.toHaveBeenCalledWith('Work', 'Work/Nested/Work')

    mutations.moveNote.mutateAsync.mockRejectedValueOnce(new Error('move failed'))
    await act(async () => {
      await result.current.handleMove({
        draggedId: 'work-a',
        targetId: 'folder-Other',
        position: 'inside'
      })
    })
    expect(result.current.isMoving).toBe(false)
  })
})
