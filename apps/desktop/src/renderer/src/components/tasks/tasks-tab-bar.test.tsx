import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { TasksTabBar, type TasksInternalTab } from './tasks-tab-bar'
import type { SavedFilter } from '@/data/tasks-data'

const defaultCounts = { today: 3, all: 15, done: 2 }

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

const renderTabBar = (overrides: Partial<Parameters<typeof TasksTabBar>[0]> = {}) => {
  const onTabChange = overrides.onTabChange ?? vi.fn()
  const onApplySavedFilter = overrides.onApplySavedFilter ?? vi.fn()
  const onDeleteSavedFilter = overrides.onDeleteSavedFilter ?? vi.fn()

  return {
    onTabChange,
    onApplySavedFilter,
    onDeleteSavedFilter,
    ...render(
      <TasksTabBar
        activeTab="all"
        onTabChange={onTabChange}
        counts={defaultCounts}
        savedFilters={[]}
        onApplySavedFilter={onApplySavedFilter}
        onDeleteSavedFilter={onDeleteSavedFilter}
        {...overrides}
      />
    )
  }
}

describe('TasksTabBar', () => {
  it('renders three default tabs (Today, All, Done) — no This Week', () => {
    renderTabBar()
    expect(screen.getByRole('tab', { name: /today/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /all/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /done/i })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /this week/i })).not.toBeInTheDocument()
  })

  it('calls onTabChange when a tab is clicked', () => {
    const { onTabChange } = renderTabBar()
    fireEvent.click(screen.getByRole('tab', { name: /today/i }))
    expect(onTabChange).toHaveBeenCalledWith('today')
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

      expect(screen.getByLabelText('Remove High Priority')).toBeInTheDocument()
      expect(screen.getByLabelText('Remove Overdue Work')).toBeInTheDocument()
    })

    it('calls onDeleteSavedFilter with filter id when delete button clicked', () => {
      const filter = makeSavedFilter({ id: 'sf-1', name: 'High Priority' })
      const { onDeleteSavedFilter } = renderTabBar({ savedFilters: [filter] })

      fireEvent.click(screen.getByLabelText('Remove High Priority'))
      expect(onDeleteSavedFilter).toHaveBeenCalledWith('sf-1')
    })

    it('does not trigger onApplySavedFilter when delete button clicked', () => {
      const filter = makeSavedFilter({ id: 'sf-1', name: 'High Priority' })
      const { onApplySavedFilter } = renderTabBar({ savedFilters: [filter] })

      fireEvent.click(screen.getByLabelText('Remove High Priority'))
      expect(onApplySavedFilter).not.toHaveBeenCalled()
    })
  })
})
