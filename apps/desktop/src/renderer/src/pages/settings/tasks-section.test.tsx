import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { TasksSettings } from './tasks-section'
import { renderWithProviders as renderWithQueryProviders } from '@tests/utils/render'
import type { Project, Status } from '@/data/tasks-data'

beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

const TODO_STATUS: Status = { id: 's-todo', name: 'To Do', color: '#666', type: 'todo', order: 0 }
const DONE_STATUS: Status = {
  id: 's-done',
  name: 'Done',
  color: '#0f0',
  type: 'done',
  order: 1
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'personal',
    name: 'Personal',
    description: '',
    icon: 'User',
    color: '#6366f1',
    statuses: [TODO_STATUS, DONE_STATUS],
    isDefault: true,
    isArchived: false,
    createdAt: new Date(),
    taskCount: 0,
    ...overrides
  }
}

const MOCK_PROJECTS: Project[] = [
  makeProject(),
  makeProject({ id: 'work', name: 'Work', color: '#ef4444', isDefault: false }),
  makeProject({
    id: 'archived',
    name: 'Old Project',
    color: '#999',
    isDefault: false,
    isArchived: true
  })
]

const DEFAULTS = {
  defaultProjectId: null,
  defaultSortOrder: 'manual' as const,
  weekStartDay: 'monday' as const,
  staleInboxDays: 7
}

function renderWithProviders(ui: React.ReactElement) {
  return renderWithQueryProviders(ui)
}

describe('TasksSettings', () => {
  beforeEach(() => {
    const settingsMock = window.api.settings as Record<string, unknown>
    settingsMock.getTaskSettings = vi.fn().mockResolvedValue({ ...DEFAULTS })
    settingsMock.setTaskSettings = vi.fn().mockResolvedValue({ success: true })
    ;(window.api.onSettingsChanged as ReturnType<typeof vi.fn>).mockReturnValue(() => {})
    ;(window.api.tasks.listProjects as ReturnType<typeof vi.fn>).mockResolvedValue({
      projects: MOCK_PROJECTS.map((project, index) => ({
        id: project.id,
        name: project.name,
        description: project.description || null,
        icon: project.icon,
        color: project.color,
        position: index,
        isInbox: project.isDefault,
        createdAt: project.createdAt.toISOString(),
        modifiedAt: project.createdAt.toISOString(),
        archivedAt: project.isArchived ? project.createdAt.toISOString() : null,
        taskCount: project.taskCount,
        completedCount: 0,
        overdueCount: 0
      }))
    })
    ;(window.api.tasks.listStatuses as ReturnType<typeof vi.fn>).mockImplementation(
      async (projectId: string) => {
        const project = MOCK_PROJECTS.find((entry) => entry.id === projectId)
        return (
          project?.statuses.map((status, index) => ({
            id: status.id,
            projectId,
            name: status.name,
            color: status.color,
            position: index,
            isDefault: status.type === 'todo',
            isDone: status.type === 'done',
            createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString()
          })) ?? []
        )
      }
    )
  })

  it('renders loading state initially', () => {
    renderWithProviders(<TasksSettings />)
    expect(screen.getByText('Loading settings...')).toBeInTheDocument()
  })

  it('renders all settings sections after load', async () => {
    renderWithProviders(<TasksSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument()
    })

    expect(screen.getByText('Tasks')).toBeInTheDocument()
    expect(screen.getByText('Default Project')).toBeInTheDocument()
    expect(screen.getByText('Default Sort Order')).toBeInTheDocument()
    expect(screen.getByText('Week Starts On')).toBeInTheDocument()
    expect(screen.getByText('Stale Inbox Threshold')).toBeInTheDocument()
  })

  it('shows active projects in dropdown (excludes archived)', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TasksSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument()
    })

    const projectTrigger = screen.getAllByRole('combobox')[0]
    await user.click(projectTrigger)

    await waitFor(() => {
      expect(screen.getByText('Personal')).toBeInTheDocument()
      expect(screen.getByText('Work')).toBeInTheDocument()
    })

    expect(screen.queryByText('Old Project')).not.toBeInTheDocument()
  })

  it('shows "No default" as current selection when defaultProjectId is null', async () => {
    renderWithProviders(<TasksSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument()
    })

    const projectTrigger = screen.getAllByRole('combobox')[0]
    expect(projectTrigger).toHaveTextContent('No default (use Personal)')
  })

  it('calls updateSettings when default project changes', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TasksSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument()
    })

    const projectTrigger = screen.getAllByRole('combobox')[0]
    await user.click(projectTrigger)

    await waitFor(() => {
      expect(screen.getByText('Work')).toBeInTheDocument()
    })
    await user.click(screen.getByText('Work'))

    await waitFor(() => {
      expect(window.api.settings.setTaskSettings).toHaveBeenCalledWith({
        defaultProjectId: 'work'
      })
    })
  })

  it('sends null when "No default" is selected', async () => {
    ;(window.api.settings.getTaskSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULTS,
      defaultProjectId: 'work'
    })

    const user = userEvent.setup()
    renderWithProviders(<TasksSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument()
    })

    const projectTrigger = screen.getAllByRole('combobox')[0]
    await user.click(projectTrigger)

    await waitFor(() => {
      expect(screen.getByText('No default (use Personal)')).toBeInTheDocument()
    })
    await user.click(screen.getByText('No default (use Personal)'))

    await waitFor(() => {
      expect(window.api.settings.setTaskSettings).toHaveBeenCalledWith({
        defaultProjectId: null
      })
    })
  })

  it('calls updateSettings when sort order changes', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TasksSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument()
    })

    const sortTrigger = screen.getAllByRole('combobox')[1]
    await user.click(sortTrigger)

    await waitFor(() => {
      expect(screen.getByText('Due Date')).toBeInTheDocument()
    })
    await user.click(screen.getByText('Due Date'))

    await waitFor(() => {
      expect(window.api.settings.setTaskSettings).toHaveBeenCalledWith({
        defaultSortOrder: 'dueDate'
      })
    })
  })

  it('updates week start day on toggle', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TasksSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument()
    })

    await user.click(screen.getByText('Sunday'))

    await waitFor(() => {
      expect(window.api.settings.setTaskSettings).toHaveBeenCalledWith({
        weekStartDay: 'sunday'
      })
    })
  })

  it('updates stale inbox threshold on input change', async () => {
    renderWithProviders(<TasksSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument()
    })

    const input = screen.getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '14' } })

    await waitFor(() => {
      expect(window.api.settings.setTaskSettings).toHaveBeenCalledWith({
        staleInboxDays: 14
      })
    })
  })

  it('rejects invalid stale inbox values', async () => {
    renderWithProviders(<TasksSettings />)

    await waitFor(() => {
      expect(screen.queryByText('Loading settings...')).not.toBeInTheDocument()
    })

    const input = screen.getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '0' } })

    expect(window.api.settings.setTaskSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ staleInboxDays: 0 })
    )
  })
})
