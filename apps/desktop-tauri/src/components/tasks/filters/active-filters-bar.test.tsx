import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

import { ActiveFiltersBar } from './active-filters-bar'
import type { TaskFilters, Project } from '@/data/tasks-data'
import { defaultFilters } from '@/data/tasks-data'

const mockProjects: Project[] = [
  {
    id: 'proj-1',
    name: 'Work',
    color: '#3B82F6',
    icon: 'briefcase',
    isArchived: false,
    statuses: [],
    position: 0
  }
]

const filtersWithPriority: TaskFilters = {
  ...defaultFilters,
  priorities: ['high', 'urgent']
}

const renderBar = (
  overrides: Partial<{
    filters: TaskFilters
    projects: Project[]
    onUpdateFilters: (u: Partial<TaskFilters>) => void
    onClearAll: () => void
    onSaveFilter: () => void
    isSaved: boolean
  }> = {}
) => {
  const onUpdateFilters = overrides.onUpdateFilters ?? vi.fn()
  const onClearAll = overrides.onClearAll ?? vi.fn()
  const onSaveFilter = overrides.onSaveFilter ?? undefined
  const isSaved = overrides.isSaved ?? false

  return {
    onUpdateFilters,
    onClearAll,
    onSaveFilter,
    ...render(
      <ActiveFiltersBar
        filters={overrides.filters ?? filtersWithPriority}
        projects={overrides.projects ?? mockProjects}
        onUpdateFilters={onUpdateFilters}
        onClearAll={onClearAll}
        onSaveFilter={onSaveFilter}
        isSaved={isSaved}
      />
    )
  }
}

describe('ActiveFiltersBar', () => {
  describe('existing behavior', () => {
    it('renders filter pills for active priorities', () => {
      renderBar()
      expect(screen.getByText('High, Urgent')).toBeInTheDocument()
    })

    it('renders Clear all button', () => {
      renderBar()
      expect(screen.getByText('Clear all')).toBeInTheDocument()
    })

    it('calls onClearAll when Clear all is clicked', () => {
      const onClearAll = vi.fn()
      renderBar({ onClearAll })
      fireEvent.click(screen.getByText('Clear all'))
      expect(onClearAll).toHaveBeenCalledTimes(1)
    })

    it('returns null when no filters are active', () => {
      const { container } = render(
        <ActiveFiltersBar
          filters={defaultFilters}
          projects={mockProjects}
          onUpdateFilters={vi.fn()}
          onClearAll={vi.fn()}
        />
      )
      expect(container.firstChild).toBeNull()
    })
  })

  describe('save filter button (Option A)', () => {
    it('shows Save button when onSaveFilter is provided', () => {
      renderBar({ onSaveFilter: vi.fn() })
      expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument()
    })

    it('does not show Save button when onSaveFilter is not provided', () => {
      renderBar({ onSaveFilter: undefined })
      expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument()
    })

    it('calls onSaveFilter when Save button is clicked', () => {
      const onSaveFilter = vi.fn()
      renderBar({ onSaveFilter })
      fireEvent.click(screen.getByRole('button', { name: /save/i }))
      expect(onSaveFilter).toHaveBeenCalledTimes(1)
    })

    it('shows filled star icon when isSaved is true', () => {
      renderBar({ onSaveFilter: vi.fn(), isSaved: true })
      expect(screen.getByRole('button', { name: /saved/i })).toBeInTheDocument()
    })

    it('shows outline star icon when isSaved is false', () => {
      renderBar({ onSaveFilter: vi.fn(), isSaved: false })
      expect(screen.getByRole('button', { name: /save filter/i })).toBeInTheDocument()
    })

    it('positions Save button before Clear all', () => {
      renderBar({ onSaveFilter: vi.fn() })
      const saveBtn = screen.getByRole('button', { name: /save/i })
      const clearBtn = screen.getByText('Clear all')
      const parent = saveBtn.parentElement!
      const children = Array.from(parent.children)
      const saveIdx = children.indexOf(saveBtn)
      const clearIdx = children.indexOf(clearBtn)
      expect(saveIdx).toBeLessThan(clearIdx)
    })
  })
})
