import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { useTaskWorkspaceData } from './use-task-queries'
import { createTestQueryClient } from '@tests/utils/hook-test-wrapper'

describe('useTaskWorkspaceData', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = createTestQueryClient()
  })

  afterEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )

  it('loads projects with statuses and the full task list', async () => {
    ;(window.api.tasks.listProjects as ReturnType<typeof vi.fn>).mockResolvedValue({
      projects: [
        {
          id: 'project-1',
          name: 'Inbox',
          description: null,
          color: '#123456',
          icon: null,
          position: 0,
          isInbox: true,
          createdAt: '2026-04-08T10:00:00.000Z',
          modifiedAt: '2026-04-08T10:00:00.000Z',
          archivedAt: null,
          taskCount: 2,
          completedCount: 0,
          overdueCount: 0
        }
      ]
    })
    ;(window.api.tasks.listStatuses as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'status-1',
        projectId: 'project-1',
        name: 'To Do',
        color: '#999999',
        position: 0,
        isDefault: true,
        isDone: false,
        createdAt: '2026-04-08T10:00:00.000Z'
      }
    ])
    ;(window.api.tasks.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      tasks: [
        {
          id: 'task-1',
          projectId: 'project-1',
          statusId: 'status-1',
          parentId: null,
          title: 'Task 1',
          description: null,
          priority: 0,
          position: 0,
          dueDate: null,
          dueTime: null,
          startDate: null,
          repeatConfig: null,
          repeatFrom: null,
          sourceNoteId: null,
          completedAt: null,
          archivedAt: null,
          createdAt: '2026-04-08T10:00:00.000Z',
          modifiedAt: '2026-04-08T10:00:00.000Z',
          tags: [],
          linkedNoteIds: [],
          hasSubtasks: false,
          subtaskCount: 0,
          completedSubtaskCount: 0
        }
      ],
      total: 1,
      hasMore: false
    })

    const { result } = renderHook(() => useTaskWorkspaceData({ enabled: true }), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(window.api.tasks.listProjects).toHaveBeenCalledTimes(1)
    expect(window.api.tasks.listStatuses).toHaveBeenCalledWith('project-1')
    expect(window.api.tasks.list).toHaveBeenCalledWith({
      includeCompleted: true,
      includeArchived: true,
      limit: 1000
    })
    expect(result.current.projects).toHaveLength(1)
    expect(result.current.projects[0]?.statuses).toHaveLength(1)
    expect(result.current.tasks).toHaveLength(1)
  })
})
