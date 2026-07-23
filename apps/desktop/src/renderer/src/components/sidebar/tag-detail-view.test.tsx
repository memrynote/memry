import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { TagDetailView } from './tag-detail-view'

const {
  mockRenameTag,
  mockDeleteTag,
  mockUpdateTagColor,
  mockGetNotesByTag,
  mockPinNoteToTag,
  mockUnpinNoteFromTag,
  mockRemoveTagFromNote,
  mockGetAllWithCounts,
  mockMergeTag,
  mockOnTagRenamed,
  mockOnTagDeleted,
  mockOnTagNotesChanged,
  mockOnTagColorUpdated,
  mockToastSuccess,
  mockToastError,
  mockGoBack,
  mockOpenSidebarItem,
  mockListTasks,
  mockOnTaskCreated,
  mockOnTaskUpdated,
  mockOnTaskDeleted,
  mockOnTaskCompleted,
  mockUseTaskWorkspaceData
} = vi.hoisted(() => ({
  mockRenameTag: vi.fn(),
  mockDeleteTag: vi.fn(),
  mockUpdateTagColor: vi.fn(),
  mockGetNotesByTag: vi.fn(),
  mockPinNoteToTag: vi.fn(),
  mockUnpinNoteFromTag: vi.fn(),
  mockRemoveTagFromNote: vi.fn(),
  mockGetAllWithCounts: vi.fn(),
  mockMergeTag: vi.fn(),
  mockOnTagRenamed: vi.fn(() => () => {}),
  mockOnTagDeleted: vi.fn(() => () => {}),
  mockOnTagNotesChanged: vi.fn(() => () => {}),
  mockOnTagColorUpdated: vi.fn(() => () => {}),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockGoBack: vi.fn(),
  mockOpenSidebarItem: vi.fn(),
  mockListTasks: vi.fn(),
  mockOnTaskCreated: vi.fn(() => () => {}),
  mockOnTaskUpdated: vi.fn(() => () => {}),
  mockOnTaskDeleted: vi.fn(() => () => {}),
  mockOnTaskCompleted: vi.fn(() => () => {}),
  mockUseTaskWorkspaceData: vi.fn()
}))

vi.mock('@/services/tags-service', () => ({
  tagsService: {
    getNotesByTag: mockGetNotesByTag,
    pinNoteToTag: mockPinNoteToTag,
    unpinNoteFromTag: mockUnpinNoteFromTag,
    renameTag: mockRenameTag,
    updateTagColor: mockUpdateTagColor,
    deleteTag: mockDeleteTag,
    removeTagFromNote: mockRemoveTagFromNote,
    getAllWithCounts: mockGetAllWithCounts,
    mergeTag: mockMergeTag
  },
  onTagRenamed: mockOnTagRenamed,
  onTagDeleted: mockOnTagDeleted,
  onTagNotesChanged: mockOnTagNotesChanged,
  onTagColorUpdated: mockOnTagColorUpdated
}))

vi.mock('sonner', () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError
  }
}))

vi.mock('@/contexts/sidebar-drill-down', () => ({
  useSidebarDrillDown: () => ({
    viewStack: [],
    currentView: { type: 'tag', tag: 'react', color: 'blue' },
    isAtMain: false,
    animationDirection: null,
    openTag: vi.fn(),
    goBack: mockGoBack,
    resetToMain: vi.fn()
  })
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({
    openSidebarItem: mockOpenSidebarItem
  })
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    list: mockListTasks
  },
  onTaskCreated: mockOnTaskCreated,
  onTaskUpdated: mockOnTaskUpdated,
  onTaskDeleted: mockOnTaskDeleted,
  onTaskCompleted: mockOnTaskCompleted
}))

vi.mock('@/features/tasks/use-task-queries', () => ({
  useTaskWorkspaceData: mockUseTaskWorkspaceData
}))

const defaultNotesResponse = {
  tag: 'react',
  color: 'blue',
  count: 0,
  pinnedNotes: [],
  unpinnedNotes: []
}

const success = { success: true as const }

describe('TagDetailView rename + delete actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetNotesByTag.mockResolvedValue(defaultNotesResponse)
    mockRenameTag.mockResolvedValue(success)
    mockDeleteTag.mockResolvedValue(success)
    mockUpdateTagColor.mockResolvedValue(success)
    mockPinNoteToTag.mockResolvedValue(success)
    mockUnpinNoteFromTag.mockResolvedValue(success)
    mockRemoveTagFromNote.mockResolvedValue(success)
    mockGetAllWithCounts.mockResolvedValue({ tags: [] })
    mockListTasks.mockResolvedValue({ tasks: [], total: 0, hasMore: false })
    mockUseTaskWorkspaceData.mockReturnValue({
      projects: [],
      tasks: [],
      isLoading: false,
      error: null,
      refetch: vi.fn()
    })
    ;(mockOnTagRenamed as Mock).mockReturnValue(() => {})
    ;(mockOnTagDeleted as Mock).mockReturnValue(() => {})
    ;(mockOnTagNotesChanged as Mock).mockReturnValue(() => {})
    ;(mockOnTagColorUpdated as Mock).mockReturnValue(() => {})
  })

  const renderView = async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } }
    })
    const view = render(
      <QueryClientProvider client={queryClient}>
        <TagDetailView tag="react" color="blue" />
      </QueryClientProvider>
    )
    // Wait for the initial load to finish
    await waitFor(() => expect(mockGetNotesByTag).toHaveBeenCalled())
    return view
  }

  const openOverflow = async (user: ReturnType<typeof userEvent.setup>) => {
    const trigger = screen.getByRole('button', { name: 'Tag actions' })
    await user.click(trigger)
  }

  describe('rename', () => {
    it('opens dialog prefilled with current tag name', async () => {
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)

      await user.click(await screen.findByText('Rename tag'))

      const input = await screen.findByLabelText('New name')
      expect(input).toHaveValue('react')
    })

    it('calls renameTag with trimmed new name and closes on success', async () => {
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)
      await user.click(await screen.findByText('Rename tag'))

      const input = await screen.findByLabelText('New name')
      await user.clear(input)
      await user.type(input, '  typescript  ')
      await user.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() =>
        expect(mockRenameTag).toHaveBeenCalledWith({ oldName: 'react', newName: 'typescript' })
      )
      expect(mockToastSuccess).toHaveBeenCalledWith('Renamed "react" to "typescript"')
      expect(mockGoBack).toHaveBeenCalled()
    })

    it('refuses empty input', async () => {
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)
      await user.click(await screen.findByText('Rename tag'))

      const input = await screen.findByLabelText('New name')
      await user.clear(input)
      await user.click(screen.getByRole('button', { name: 'Save' }))

      expect(await screen.findByText('Tag name cannot be empty')).toBeInTheDocument()
      expect(mockRenameTag).not.toHaveBeenCalled()
    })

    it('toasts error and keeps dialog open on failure', async () => {
      mockRenameTag.mockResolvedValueOnce({ success: false, error: 'Tag already exists' })
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)
      await user.click(await screen.findByText('Rename tag'))

      const input = await screen.findByLabelText('New name')
      await user.clear(input)
      await user.type(input, 'typescript')
      await user.click(screen.getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Tag already exists'))
      expect(mockGoBack).not.toHaveBeenCalled()
      expect(await screen.findByLabelText('New name')).toBeInTheDocument()
    })
  })

  describe('delete', () => {
    it('calls deleteTag and navigates back on confirm', async () => {
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)

      await user.click(await screen.findByText('Delete tag'))
      expect(await screen.findByText(/Delete tag #react\?/i)).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Delete tag' }))

      await waitFor(() => expect(mockDeleteTag).toHaveBeenCalledWith('react'))
      expect(mockToastSuccess).toHaveBeenCalledWith('Deleted "react" from 0 items')
      expect(mockGoBack).toHaveBeenCalled()
    })

    it('toasts error when delete fails', async () => {
      mockDeleteTag.mockResolvedValueOnce({ success: false, error: 'Permission denied' })
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)
      await user.click(await screen.findByText('Delete tag'))
      await user.click(screen.getByRole('button', { name: 'Delete tag' }))

      await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Permission denied'))
      expect(mockGoBack).not.toHaveBeenCalled()
    })

    it('cancel closes dialog without calling deleteTag', async () => {
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)
      await user.click(await screen.findByText('Delete tag'))

      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(mockDeleteTag).not.toHaveBeenCalled()
    })
  })

  describe('event subscriptions', () => {
    it('subscribes to onTagRenamed and onTagDeleted on mount', async () => {
      await renderView()
      expect(mockOnTagRenamed).toHaveBeenCalled()
      expect(mockOnTagDeleted).toHaveBeenCalled()
    })
  })

  describe('note list interactions', () => {
    beforeEach(() => {
      mockGetNotesByTag.mockResolvedValue({
        tag: 'react',
        color: 'blue',
        count: 2,
        pinnedNotes: [
          {
            id: 'note-pinned',
            title: 'Pinned Note',
            path: '/notes/pinned.md',
            emoji: 'P',
            modified: new Date().toISOString()
          }
        ],
        unpinnedNotes: [
          {
            id: 'note-loose',
            title: 'Loose Note',
            path: '/notes/loose.md',
            emoji: null,
            modified: new Date(Date.now() - 86400_000).toISOString()
          }
        ]
      })
    })

    it('opens notes and pins and unpins rows', async () => {
      const user = userEvent.setup()
      await renderView()

      await user.click(await screen.findByText('Pinned Note'))
      expect(mockOpenSidebarItem).toHaveBeenCalledWith({
        type: 'note',
        title: 'Pinned Note',
        path: '/notes/pinned.md',
        entityId: 'note-pinned',
        emoji: 'P'
      })

      await user.click(screen.getByRole('button', { name: 'Unpin from tag' }))
      expect(mockUnpinNoteFromTag).toHaveBeenCalledWith({ noteId: 'note-pinned', tag: 'react' })

      await user.click(screen.getByRole('button', { name: 'Pin to tag' }))
      expect(mockPinNoteToTag).toHaveBeenCalledWith({ noteId: 'note-loose', tag: 'react' })
    })

    it('opens the color picker menu', async () => {
      const user = userEvent.setup()
      await renderView()
      await openOverflow(user)

      await user.click(await screen.findByText('Change color'))
      expect(screen.getByTitle('sage')).toBeInTheDocument()
    })
  })

  describe('task list section', () => {
    const baseTask = {
      id: 'task-1',
      projectId: 'proj-1',
      statusId: null,
      parentId: null,
      description: null,
      priority: 0 as const,
      position: 0,
      dueDate: null,
      dueTime: null,
      startDate: null,
      repeatConfig: null,
      repeatFrom: null,
      sourceNoteId: null,
      completedAt: null,
      archivedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z'
    }

    it('shows tasks tagged with the exact tag or a descendant, not an unrelated prefix', async () => {
      mockListTasks.mockResolvedValue({
        tasks: [
          { ...baseTask, id: 'task-exact', title: 'Exact match task', tags: ['react'] },
          { ...baseTask, id: 'task-descendant', title: 'Descendant task', tags: ['react/hooks'] },
          { ...baseTask, id: 'task-unrelated', title: 'Unrelated prefix task', tags: ['reactive'] }
        ],
        total: 3,
        hasMore: false
      })

      await renderView()
      await waitFor(() => expect(mockListTasks).toHaveBeenCalled())

      expect(await screen.findByText('Exact match task')).toBeInTheDocument()
      expect(await screen.findByText('Descendant task')).toBeInTheDocument()
      expect(screen.queryByText('Unrelated prefix task')).not.toBeInTheDocument()
    })

    it('shows each task status with the shared status indicator, not a binary checkbox', async () => {
      mockUseTaskWorkspaceData.mockReturnValue({
        projects: [
          {
            id: 'proj-1',
            statuses: [
              { id: 'st-todo', name: 'To Do', type: 'todo', color: '#94a3b8', order: 0 },
              {
                id: 'st-prog',
                name: 'In Progress',
                type: 'in_progress',
                color: '#f59e0b',
                order: 1
              },
              { id: 'st-done', name: 'Done', type: 'done', color: '#22c55e', order: 2 }
            ]
          }
        ],
        tasks: [],
        isLoading: false,
        error: null,
        refetch: vi.fn()
      })
      mockListTasks.mockResolvedValue({
        tasks: [
          { ...baseTask, id: 'task-prog', title: 'Wip task', tags: ['react'], statusId: 'st-prog' },
          {
            ...baseTask,
            id: 'task-done',
            title: 'Finished task',
            tags: ['react'],
            statusId: 'st-done',
            completedAt: '2026-01-02T00:00:00.000Z'
          }
        ],
        total: 2,
        hasMore: false
      })

      await renderView()
      await waitFor(() => expect(mockListTasks).toHaveBeenCalled())

      expect(await screen.findByText('Wip task')).toBeInTheDocument()
      expect(screen.getByTitle('In Progress')).toBeInTheDocument()
      expect(screen.getByTitle('Done')).toBeInTheDocument()
    })

    it('opens the task detail drawer on click', async () => {
      mockListTasks.mockResolvedValue({
        tasks: [{ ...baseTask, id: 'task-exact', title: 'Exact match task', tags: ['react'] }],
        total: 1,
        hasMore: false
      })

      const user = userEvent.setup()
      await renderView()
      await waitFor(() => expect(mockListTasks).toHaveBeenCalled())

      await user.click(await screen.findByText('Exact match task'))

      expect(mockOpenSidebarItem).toHaveBeenCalledWith({
        type: 'tasks',
        title: 'Tasks',
        icon: 'CheckSquare',
        path: '/tasks',
        viewState: {
          openTaskId: 'task-exact',
          selectedProjectId: 'proj-1',
          activeInternalTab: 'all',
          activeTab: 'all'
        }
      })
    })

    it('refreshes the task list on task CRUD events', async () => {
      await renderView()
      await waitFor(() => expect(mockListTasks).toHaveBeenCalledTimes(1))

      const createdCallback = mockOnTaskCreated.mock.calls[0][0]
      await act(async () => {
        createdCallback({ task: { ...baseTask, title: 'New task', tags: [] } })
      })

      await waitFor(() => expect(mockListTasks).toHaveBeenCalledTimes(2))
    })

    it('refreshes tasks (not just notes) when a different tag is renamed or deleted', async () => {
      await renderView()
      await waitFor(() => expect(mockListTasks).toHaveBeenCalledTimes(1))

      const renamedCallback = mockOnTagRenamed.mock.calls[0][0]
      await act(async () => {
        renamedCallback({ oldName: 'other-tag', newName: 'renamed-tag', affectedNotes: 0 })
      })
      await waitFor(() => expect(mockListTasks).toHaveBeenCalledTimes(2))

      const deletedCallback = mockOnTagDeleted.mock.calls[0][0]
      await act(async () => {
        deletedCallback({ tag: 'other-tag', affectedNotes: 0 })
      })
      await waitFor(() => expect(mockListTasks).toHaveBeenCalledTimes(3))

      expect(mockGoBack).not.toHaveBeenCalled()
    })
  })
})
