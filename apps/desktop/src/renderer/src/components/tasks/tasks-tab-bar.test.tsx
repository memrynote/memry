import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import type { ReactNode } from 'react'
import { createRendererI18n } from '@memry/i18n/renderer'

import { TasksTabBar, type TasksTabCounts } from './tasks-tab-bar'
import type { Project, SavedFilter } from '@/data/tasks-data'

// ProjectPicker's create footer is gated on a tasks context being present.
vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: vi.fn(() => ({ addProject: vi.fn() })),
  useTasksContext: vi.fn()
}))

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

const defaultCounts: TasksTabCounts = { today: 3, tomorrow: 2, next7: 8, all: 15 }

const openWindowPicker = (): void => {
  fireEvent.click(screen.getByRole('combobox', { name: 'Task views' }))
}

const openProjectPicker = (): void => {
  fireEvent.click(screen.getByRole('combobox', { name: 'Select project' }))
}

const makeSavedFilter = (overrides: Partial<SavedFilter> = {}): SavedFilter => ({
  id: 'sf-1',
  name: 'High Priority',
  filters: {
    search: '',
    projectIds: [],
    priorities: ['high'],
    tags: [],
    dueDate: { type: 'any', customStart: null, customEnd: null },
    statusIds: [],
    completion: 'active',
    repeatType: 'all',
    hasTime: 'all'
  },
  starred: true,
  createdAt: new Date('2026-01-01'),
  ...overrides
})

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'project-1',
  name: 'Writing',
  description: '',
  icon: 'Folder',
  color: '#f59e0b',
  statuses: [],
  isDefault: false,
  isArchived: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  taskCount: 3,
  ...overrides
})

const renderTabBar = (overrides: Partial<Parameters<typeof TasksTabBar>[0]> = {}) => {
  const onTabChange = overrides.onTabChange ?? vi.fn()
  const onApplySavedFilter = overrides.onApplySavedFilter ?? vi.fn()
  const onUnstarSavedFilter = overrides.onUnstarSavedFilter ?? vi.fn()

  return {
    onTabChange,
    onApplySavedFilter,
    onUnstarSavedFilter,
    ...render(
      <TasksTabBar
        activeTab="all"
        onTabChange={onTabChange}
        counts={defaultCounts}
        savedFilters={[]}
        onApplySavedFilter={onApplySavedFilter}
        onUnstarSavedFilter={onUnstarSavedFilter}
        {...overrides}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <I18nextProvider i18n={i18nEn}>{children}</I18nextProvider>
        )
      }
    )
  }
}

describe('TasksTabBar', () => {
  it('offers all four due-date scopes in one dropdown', () => {
    renderTabBar()
    openWindowPicker()

    expect(screen.getByRole('option', { name: /^all/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /today/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /tomorrow/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /next 7 days/i })).toBeInTheDocument()
  })

  it('shows the active scope and its count on the trigger', () => {
    renderTabBar({ activeTab: 'tomorrow' })
    const trigger = screen.getByRole('combobox', { name: 'Task views' })

    expect(trigger).toHaveTextContent('Tomorrow')
    expect(trigger).toHaveTextContent('2')
  })

  it('calls onTabChange when another scope is picked', () => {
    const { onTabChange } = renderTabBar()
    openWindowPicker()
    fireEvent.click(screen.getByRole('option', { name: /next 7 days/i }))
    expect(onTabChange).toHaveBeenCalledWith('next7')
  })

  it('does not re-fire onTabChange for the scope already active', () => {
    const { onTabChange } = renderTabBar({ activeTab: 'today' })
    openWindowPicker()
    fireEvent.click(screen.getByRole('option', { name: /today/i }))
    expect(onTabChange).not.toHaveBeenCalled()
  })

  it('renders the project scope picker: filters archived, searches, selects, edits, and offers create', () => {
    const onProjectChange = vi.fn()
    const onProjectEdit = vi.fn()
    const writing = makeProject()
    const work = makeProject({ id: 'project-2', name: 'Work', color: '#3b82f6' })
    const archived = makeProject({ id: 'project-3', name: 'Archive', isArchived: true })

    renderTabBar({
      projects: [writing, work, archived],
      selectedProjectId: 'project-1',
      onProjectChange,
      onProjectEdit
    })

    openProjectPicker()

    expect(screen.getByRole('option', { name: /all projects/i })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /work/i })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /archive/i })).not.toBeInTheDocument()

    // Create-project footer is now available on this dropdown (was missing before).
    expect(screen.getByRole('button', { name: 'Create project' })).toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wo' } })
    expect(screen.getByRole('option', { name: /work/i })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /writing/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('option', { name: /work/i }))
    expect(onProjectChange).toHaveBeenCalledWith('project-2')

    openProjectPicker()
    fireEvent.click(screen.getByLabelText('Edit Work'))
    expect(onProjectEdit).toHaveBeenCalledWith(work)
  })

  it('selects "All projects" to clear the project scope', () => {
    const onProjectChange = vi.fn()
    renderTabBar({
      counts: { today: 0, tomorrow: 0, next7: 0, all: 0 },
      projects: [makeProject()],
      selectedProjectId: 'project-1',
      onProjectChange
    })

    openProjectPicker()
    fireEvent.click(screen.getByRole('option', { name: /all projects/i }))

    expect(onProjectChange).toHaveBeenCalledWith(null)
  })

  describe('saved filter pills', () => {
    it('renders no saved filter pills when savedFilters is empty', () => {
      renderTabBar({ savedFilters: [] })
      expect(screen.queryByTestId('saved-filter-pill')).not.toBeInTheDocument()
    })

    it('renders saved filter pills after the tab bar', () => {
      const filters = [
        makeSavedFilter({ id: 'sf-1', name: 'High Priority' }),
        makeSavedFilter({ id: 'sf-2', name: 'Overdue Work' })
      ]
      renderTabBar({ savedFilters: filters })

      expect(screen.getByRole('button', { name: 'High Priority' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Overdue Work' })).toBeInTheDocument()
    })

    it('calls onApplySavedFilter when a saved filter pill is clicked', () => {
      const filter = makeSavedFilter({ id: 'sf-1', name: 'High Priority' })
      const { onApplySavedFilter } = renderTabBar({ savedFilters: [filter] })

      fireEvent.click(screen.getByRole('button', { name: 'High Priority' }))
      expect(onApplySavedFilter).toHaveBeenCalledWith(filter)
    })

    it('highlights the active saved filter with distinct styling', () => {
      const filter = makeSavedFilter({ id: 'sf-1', name: 'High Priority' })
      renderTabBar({
        savedFilters: [filter],
        activeSavedFilterId: 'sf-1'
      })

      const pill = screen.getByTestId('saved-filter-pill')
      expect(pill.className).toMatch(/saved-filter-active/)
    })

    it('does not highlight saved filter when activeSavedFilterId is null', () => {
      const filter = makeSavedFilter({ id: 'sf-1', name: 'High Priority' })
      renderTabBar({
        savedFilters: [filter],
        activeSavedFilterId: null
      })

      const pill = screen.getByTestId('saved-filter-pill')
      expect(pill.className).not.toMatch(/saved-filter-active/)
    })

    it('marks no scope as selected while a saved filter is active', () => {
      const filter = makeSavedFilter({ id: 'sf-1', name: 'High Priority' })
      renderTabBar({
        activeTab: 'today',
        savedFilters: [filter],
        activeSavedFilterId: 'sf-1'
      })

      openWindowPicker()
      expect(screen.getByRole('option', { name: /today/i })).toHaveAttribute(
        'aria-selected',
        'false'
      )
    })

    it('marks the active scope as selected when no saved filter is active', () => {
      const filter = makeSavedFilter({ id: 'sf-1', name: 'High Priority' })
      renderTabBar({
        activeTab: 'today',
        savedFilters: [filter],
        activeSavedFilterId: null
      })

      openWindowPicker()
      expect(screen.getByRole('option', { name: /today/i })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    })

    it('renders a delete button on each saved filter pill', () => {
      const filters = [
        makeSavedFilter({ id: 'sf-1', name: 'High Priority' }),
        makeSavedFilter({ id: 'sf-2', name: 'Overdue Work' })
      ]
      renderTabBar({ savedFilters: filters })

      expect(screen.getByLabelText('Unstar High Priority')).toBeInTheDocument()
      expect(screen.getByLabelText('Unstar Overdue Work')).toBeInTheDocument()
    })

    it('calls onUnstarSavedFilter with filter id when unstar button clicked', () => {
      const filter = makeSavedFilter({ id: 'sf-1', name: 'High Priority' })
      const { onUnstarSavedFilter } = renderTabBar({ savedFilters: [filter] })

      fireEvent.click(screen.getByLabelText('Unstar High Priority'))
      expect(onUnstarSavedFilter).toHaveBeenCalledWith('sf-1')
    })

    it('does not trigger onApplySavedFilter when unstar button clicked', () => {
      const filter = makeSavedFilter({ id: 'sf-1', name: 'High Priority' })
      const { onApplySavedFilter } = renderTabBar({ savedFilters: [filter] })

      fireEvent.click(screen.getByLabelText('Unstar High Priority'))
      expect(onApplySavedFilter).not.toHaveBeenCalled()
    })
  })
})
