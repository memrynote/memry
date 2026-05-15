import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { i18n as I18nInstance } from 'i18next'
import type { ReactNode } from 'react'
import { createRendererI18n } from '@memry/i18n/renderer'

import { TasksTabBar, type TasksInternalTab } from './tasks-tab-bar'
import type { Project, SavedFilter } from '@/data/tasks-data'

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

const defaultCounts = { today: 3, all: 15 }

const makeSavedFilter = (overrides: Partial<SavedFilter> = {}): SavedFilter => ({
  id: 'sf-1',
  name: 'High Priority',
  filters: {
    search: '',
    projectIds: [],
    priorities: ['high'],
    dueDate: { type: 'any', customStart: null, customEnd: null },
    statusIds: [],
    completion: 'active',
    repeatType: 'all',
    hasTime: 'all'
  },
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
  it('renders two default tabs (Today, All)', () => {
    renderTabBar()
    expect(screen.getByRole('tab', { name: /today/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /all/i })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /done/i })).not.toBeInTheDocument()
  })

  it('calls onTabChange when a tab is clicked', () => {
    const { onTabChange } = renderTabBar()
    fireEvent.click(screen.getByRole('tab', { name: /today/i }))
    expect(onTabChange).toHaveBeenCalledWith('today')
  })

  it('supports roving tab keyboard navigation', () => {
    const { onTabChange } = renderTabBar({ activeTab: 'today' })
    const today = screen.getByRole('tab', { name: /today/i })
    const all = screen.getByRole('tab', { name: /all/i })

    fireEvent.keyDown(today, { key: 'ArrowRight' })
    expect(onTabChange).toHaveBeenCalledWith('all')
    expect(all).toHaveFocus()

    fireEvent.keyDown(all, { key: 'ArrowLeft' })
    expect(onTabChange).toHaveBeenCalledWith('today')
    expect(today).toHaveFocus()

    fireEvent.keyDown(today, { key: 'End' })
    expect(onTabChange).toHaveBeenCalledWith('all')
    fireEvent.keyDown(all, { key: 'Home' })
    expect(onTabChange).toHaveBeenCalledWith('today')
  })

  it('renders the project dropdown, filters archived projects, searches, selects, and edits', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /writing/i }))

    expect(document.body.querySelector('[data-state="open"][data-side]')).toHaveClass(
      'floating-content-motion'
    )
    expect(screen.getAllByText('All projects').length).toBeGreaterThan(0)
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.queryByText('Archive')).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'wo' } })
    expect(screen.getAllByText('Writing')).toHaveLength(1)
    expect(screen.getByText('Work')).toBeInTheDocument()

    const workRow = screen.getByText('Work').closest('[role="button"]')!
    fireEvent.keyDown(workRow, { key: 'Enter' })
    expect(onProjectChange).toHaveBeenCalledWith('project-2')

    fireEvent.click(screen.getByRole('button', { name: /writing/i }))
    fireEvent.click(screen.getByLabelText('Edit Work'))
    expect(onProjectEdit).toHaveBeenCalledWith(work)
  })

  it('clears project scope and renders the empty project trigger state', () => {
    const onProjectChange = vi.fn()
    renderTabBar({
      counts: { today: 0, all: 0 },
      projects: [makeProject()],
      selectedProjectId: null,
      onProjectChange
    })

    fireEvent.click(screen.getByRole('button', { name: /all projects/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /all projects/i }).at(-1)!)

    expect(onProjectChange).toHaveBeenCalledWith(null)
    expect(screen.getByRole('tab', { name: /^today/i })).toHaveAttribute('aria-selected', 'false')
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

    it('deactivates built-in tab styling when a saved filter is active', () => {
      const filter = makeSavedFilter({ id: 'sf-1', name: 'High Priority' })
      renderTabBar({
        activeTab: 'today',
        savedFilters: [filter],
        activeSavedFilterId: 'sf-1'
      })

      const todayTab = screen.getByRole('tab', { name: /today/i })
      expect(todayTab.className).not.toMatch(/bg-foreground/)
    })

    it('keeps built-in tab styling when no saved filter is active', () => {
      const filter = makeSavedFilter({ id: 'sf-1', name: 'High Priority' })
      renderTabBar({
        activeTab: 'today',
        savedFilters: [filter],
        activeSavedFilterId: null
      })

      const todayTab = screen.getByRole('tab', { name: /today/i })
      expect(todayTab.className).toMatch(/bg-foreground/)
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
