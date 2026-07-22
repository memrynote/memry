import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AddEventToProjectDialog } from './add-event-to-project-dialog'

const { mockListProjects, mockLinkProjectItem } = vi.hoisted(() => ({
  mockListProjects: vi.fn(),
  mockLinkProjectItem: vi.fn()
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listProjects: mockListProjects,
    linkProjectItem: mockLinkProjectItem
  }
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

const project = {
  id: 'p1',
  name: 'Launch',
  description: null,
  color: '#ff671a',
  icon: null,
  position: 0,
  isInbox: false,
  createdAt: '',
  modifiedAt: '',
  archivedAt: null,
  taskCount: 0,
  completedCount: 0,
  overdueCount: 0
}

describe('AddEventToProjectDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists active projects and links the event to the chosen one', async () => {
    mockListProjects.mockResolvedValue({ projects: [project] })
    mockLinkProjectItem.mockResolvedValue({ success: true })

    render(<AddEventToProjectDialog open eventId="e1" onOpenChange={vi.fn()} />)

    expect(await screen.findByText('Launch')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Launch'))

    await waitFor(() =>
      expect(mockLinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'calendar_event',
        itemId: 'e1'
      })
    )
  })

  it('closes the dialog after a successful link', async () => {
    mockListProjects.mockResolvedValue({ projects: [project] })
    mockLinkProjectItem.mockResolvedValue({ success: true })
    const onOpenChange = vi.fn()

    render(<AddEventToProjectDialog open eventId="e1" onOpenChange={onOpenChange} />)

    fireEvent.click(await screen.findByText('Launch'))

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('filters out archived projects', async () => {
    mockListProjects.mockResolvedValue({
      projects: [project, { ...project, id: 'p2', name: 'Archived', archivedAt: '2026-01-01' }]
    })

    render(<AddEventToProjectDialog open eventId="e1" onOpenChange={vi.fn()} />)

    expect(await screen.findByText('Launch')).toBeInTheDocument()
    expect(screen.queryByText('Archived')).not.toBeInTheDocument()
  })
})
