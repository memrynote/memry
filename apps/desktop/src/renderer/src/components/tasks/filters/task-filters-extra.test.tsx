import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { Project, Status, TaskFilters } from '@/data/tasks-data'
import { defaultFilters } from '@/data/tasks-data'
import { DueDateFilter } from './due-date-filter'
import { FilterEmptyState } from './filter-empty-state'
import { FilterDropdown } from './filter-dropdown'
import { MoreFiltersDropdown } from './more-filters-dropdown'
import { PriorityFilter } from './priority-filter'
import { ProjectFilter } from './project-filter'
import { QuickFilters } from './quick-filters'
import { SaveFilterDialog } from './save-filter-dialog'
import { SearchInput } from './search-input'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

const statuses: Status[] = [
  { id: 'todo', name: 'Todo', color: '#6b7280', type: 'todo', order: 0 },
  { id: 'done', name: 'Done', color: '#10b981', type: 'done', order: 1 }
]

const projects: Project[] = [
  {
    id: 'work',
    name: 'Work',
    description: '',
    icon: 'Folder',
    color: '#3b82f6',
    statuses,
    isDefault: false,
    isArchived: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    taskCount: 4
  },
  {
    id: 'archive',
    name: 'Archived',
    description: '',
    icon: '',
    color: '#6b7280',
    statuses: [],
    isDefault: false,
    isArchived: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    taskCount: 9
  }
]

const richFilters: TaskFilters = {
  ...defaultFilters,
  search: 'launch',
  projectIds: ['work'],
  priorities: ['urgent', 'high'],
  dueDate: {
    type: 'custom',
    customStart: new Date('2026-05-01T00:00:00Z'),
    customEnd: new Date('2026-05-03T00:00:00Z')
  },
  repeatType: 'repeating',
  hasTime: 'with-time'
}

describe('task filter surfaces', () => {
  it('applies and clears quick presets', () => {
    const onApply = vi.fn()
    const { rerender } = render(<QuickFilters filters={defaultFilters} onApply={onApply} />)

    fireEvent.click(screen.getByText('High Priority'))
    expect(onApply).toHaveBeenCalledWith({
      ...defaultFilters,
      priorities: ['urgent', 'high']
    })

    rerender(
      <QuickFilters
        filters={{ ...defaultFilters, priorities: ['urgent', 'high'] }}
        onApply={onApply}
      />
    )
    fireEvent.click(screen.getByText('High Priority'))
    expect(onApply).toHaveBeenLastCalledWith(defaultFilters)
  })

  it('edits search text and clears it from button or Escape', () => {
    const onChange = vi.fn()
    const inputRef = { current: null as HTMLInputElement | null }
    const { rerender } = render(<SearchInput ref={inputRef} value="" onChange={onChange} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'roadmap' } })
    expect(onChange).toHaveBeenCalledWith('roadmap')

    rerender(<SearchInput ref={inputRef} value="roadmap" onChange={onChange} />)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'phaseF.componentsTasksFiltersSearchInput.clearSearch'
      })
    )
    expect(onChange).toHaveBeenLastCalledWith('')

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('summarizes active filters and clears empty results', () => {
    const onClearFilters = vi.fn()
    render(
      <FilterEmptyState filters={richFilters} projects={projects} onClearFilters={onClearFilters} />
    )

    expect(screen.getByText(/launch/)).toBeInTheDocument()
    expect(screen.getByText(/Work/)).toBeInTheDocument()
    expect(screen.getByText(/Urgent, High/)).toBeInTheDocument()
    expect(screen.getByText(/Repeating/)).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'phaseF.componentsTasksFiltersFilterEmptyState.clearAllFilters'
      })
    )
    expect(onClearFilters).toHaveBeenCalledTimes(1)
  })

  it('saves named filters only when there is an active filter summary', () => {
    const onClose = vi.fn()
    const onSave = vi.fn()
    render(
      <SaveFilterDialog
        isOpen
        onClose={onClose}
        onSave={onSave}
        filters={richFilters}
        projects={projects}
      />
    )

    expect(screen.getByText(/Search: "launch"/)).toBeInTheDocument()
    expect(screen.getByText(/Project: Work/)).toBeInTheDocument()
    expect(screen.getByText(/Priority: Urgent, High/)).toBeInTheDocument()
    expect(screen.getByText(/Due: May 1 - May 3/)).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'phaseF.componentsTasksFiltersSaveFilterDialog.saveFilter2'
      })
    )
    expect(screen.getByText('Please enter a name for this filter')).toBeInTheDocument()

    fireEvent.change(
      screen.getByLabelText('phaseF.componentsTasksFiltersSaveFilterDialog.filterName'),
      {
        target: { value: 'Launch filters' }
      }
    )
    fireEvent.keyDown(
      screen.getByLabelText('phaseF.componentsTasksFiltersSaveFilterDialog.filterName'),
      { key: 'Enter' }
    )
    expect(onSave).toHaveBeenCalledWith('Launch filters')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('filters projects, hides archived projects, and clears selection', () => {
    const onChange = vi.fn()
    render(
      <ProjectFilter
        projects={projects}
        selectedIds={['work']}
        onChange={onChange}
        taskCountByProject={{ work: 7 }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /filterByProject/ }))
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.queryByText('Archived')).not.toBeInTheDocument()
    expect(screen.getByText('7')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Work'))
    expect(onChange).toHaveBeenCalledWith([])

    fireEvent.click(
      screen.getByRole('button', { name: 'phaseF.componentsTasksFiltersProjectFilter.clear' })
    )
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('toggles priorities from picker content', () => {
    const onChange = vi.fn()
    render(
      <PriorityFilter
        selectedPriorities={['urgent']}
        onChange={onChange}
        taskCountByPriority={{ urgent: 2, high: 3, medium: 0, low: 1, none: 4 }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /filterByPriority/ }))
    fireEvent.click(screen.getByRole('option', { name: /High/ }))
    expect(onChange).toHaveBeenCalledWith(['urgent', 'high'])

    fireEvent.click(screen.getByRole('option', { name: /Urgent/ }))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('changes due-date presets and clears selected ranges', () => {
    const onChange = vi.fn()
    render(
      <DueDateFilter
        value={{
          type: 'custom',
          customStart: new Date(2026, 4, 1),
          customEnd: new Date(2026, 4, 3)
        }}
        onChange={onChange}
        taskCountByDueDate={
          { overdue: 2, today: 1, tomorrow: 0, 'this-week': 3, 'next-week': 4, none: 5 } as never
        }
      />
    )

    expect(screen.getByText('May 1 - May 3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /filterByDueDate/ }))
    fireEvent.click(screen.getByText('Today'))
    expect(onChange).toHaveBeenCalledWith({ type: 'today', customStart: null, customEnd: null })

    fireEvent.click(screen.getByText('Today'))
    expect(onChange).toHaveBeenLastCalledWith({ type: 'any', customStart: null, customEnd: null })
  })

  it('opens more filters, toggles switches, and picks statuses', () => {
    const onStatusChange = vi.fn()
    const onRepeatTypeChange = vi.fn()
    const onHasTimeChange = vi.fn()
    render(
      <MoreFiltersDropdown
        statuses={statuses}
        selectedStatusIds={['todo']}
        onStatusChange={onStatusChange}
        repeatType="all"
        onRepeatTypeChange={onRepeatTypeChange}
        hasTime="all"
        onHasTimeChange={onHasTimeChange}
        taskCountByStatus={{ todo: 5, done: 2 }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /moreFilters/ }))
    const switches = screen.getAllByRole('switch')
    fireEvent.click(switches[0])
    expect(onHasTimeChange).toHaveBeenCalledWith('with-time')
    fireEvent.click(switches[1])
    expect(onRepeatTypeChange).toHaveBeenCalledWith('repeating')

    fireEvent.click(screen.getByText('phaseF.componentsTasksFiltersMoreFiltersDropdown.status'))
    expect(screen.getByText('Todo')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(within(screen.getByText('Todo').closest('button')!).getByText('5')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Done'))
    expect(onStatusChange).toHaveBeenCalledWith(['todo', 'done'])
    fireEvent.click(screen.getByText('Todo'))
    expect(onStatusChange).toHaveBeenLastCalledWith([])
  })

  it('navigates the full filter dropdown panels and emits filter updates', () => {
    const onOpenChange = vi.fn()
    const onUpdateFilters = vi.fn()
    const onApplySavedFilter = vi.fn()
    const onDeleteSavedFilter = vi.fn()
    const onSaveFilter = vi.fn()
    const onToggleStarFilter = vi.fn()
    const tasks = [
      {
        id: 'task-1',
        title: 'Ship coverage',
        priority: 'urgent',
        statusId: 'todo'
      },
      {
        id: 'task-2',
        title: 'Review coverage',
        priority: 'high',
        statusId: 'done'
      }
    ] as never

    render(
      <FilterDropdown
        open
        onOpenChange={onOpenChange}
        filters={{ ...defaultFilters, priorities: ['urgent'], statusIds: ['todo'] }}
        onUpdateFilters={onUpdateFilters}
        onClearFilters={vi.fn()}
        tasks={tasks}
        projects={projects}
        savedFilters={[
          {
            id: 'saved-1',
            name: 'Important work',
            filters: richFilters,
            isStarred: false,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z')
          }
        ]}
        activeSavedFilterId={null}
        hasActiveFilters
        onDeleteSavedFilter={onDeleteSavedFilter}
        onApplySavedFilter={onApplySavedFilter}
        onSaveFilter={onSaveFilter}
        onToggleStarFilter={onToggleStarFilter}
        statuses={statuses}
      >
        <button type="button">Filters</button>
      </FilterDropdown>
    )

    fireEvent.change(screen.getByPlaceholderText(/filterBy/), { target: { value: 'prio' } })
    expect(screen.getByText('Priority')).toBeInTheDocument()
    expect(screen.queryByText('Status')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Priority'))
    fireEvent.click(screen.getByText('High'))
    expect(onUpdateFilters).toHaveBeenCalledWith({ priorities: ['urgent', 'high'] })
    fireEvent.click(screen.getByText('Urgent'))
    expect(onUpdateFilters).toHaveBeenLastCalledWith({ priorities: [] })
    fireEvent.click(screen.getByText('Apply'))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('uses project status fallback, due-date, project, and saved-filter actions in filter dropdown', () => {
    const onUpdateFilters = vi.fn()
    const onApplySavedFilter = vi.fn()
    const onDeleteSavedFilter = vi.fn()
    const onSaveFilter = vi.fn()
    const onToggleStarFilter = vi.fn()
    const onOpenChange = vi.fn()

    const { unmount } = render(
      <FilterDropdown
        open
        onOpenChange={onOpenChange}
        filters={{ ...defaultFilters, projectIds: ['work'] }}
        onUpdateFilters={onUpdateFilters}
        onClearFilters={vi.fn()}
        tasks={[{ id: 'task-1', priority: 'urgent', statusId: 'todo' }] as never}
        projects={projects}
        savedFilters={[
          {
            id: 'saved-1',
            name: 'Important work',
            filters: richFilters,
            isStarred: false,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-01-01T00:00:00Z')
          }
        ]}
        activeSavedFilterId="saved-1"
        hasActiveFilters
        onDeleteSavedFilter={onDeleteSavedFilter}
        onApplySavedFilter={onApplySavedFilter}
        onSaveFilter={onSaveFilter}
        onToggleStarFilter={onToggleStarFilter}
      >
        <button type="button">Filters</button>
      </FilterDropdown>
    )

    fireEvent.click(screen.getByText('Important work'))
    expect(onApplySavedFilter).toHaveBeenCalledWith(expect.objectContaining({ id: 'saved-1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Star Important work' }))
    expect(onToggleStarFilter).toHaveBeenCalledWith('saved-1')
    fireEvent.click(screen.getByRole('button', { name: 'Delete Important work' }))
    expect(onDeleteSavedFilter).toHaveBeenCalledWith('saved-1')

    fireEvent.click(screen.getByText('Status'))
    fireEvent.click(screen.getByText('Work'))
    fireEvent.click(screen.getByText('Done'))
    expect(onUpdateFilters).toHaveBeenCalledWith({ statusIds: ['done'] })

    unmount()

    const dueDateView = render(
      <FilterDropdown
        open
        onOpenChange={onOpenChange}
        filters={{ ...defaultFilters, projectIds: ['work'] }}
        onUpdateFilters={onUpdateFilters}
        onClearFilters={vi.fn()}
        tasks={[]}
        projects={projects}
        savedFilters={[]}
        activeSavedFilterId={null}
        hasActiveFilters={false}
        onDeleteSavedFilter={onDeleteSavedFilter}
        onApplySavedFilter={onApplySavedFilter}
        onSaveFilter={onSaveFilter}
        onToggleStarFilter={onToggleStarFilter}
        statuses={statuses}
      >
        <button type="button">Filters</button>
      </FilterDropdown>
    )

    fireEvent.click(screen.getByText('Due date'))
    fireEvent.click(screen.getByText('Today'))
    expect(onUpdateFilters).toHaveBeenCalledWith({
      dueDate: { type: 'today', customStart: null, customEnd: null }
    })
    fireEvent.click(screen.getByText('phaseF.componentsTasksDatePickerContent.removeDate'))
    expect(onUpdateFilters).toHaveBeenCalledWith({
      dueDate: { type: 'any', customStart: null, customEnd: null }
    })

    dueDateView.unmount()

    render(
      <FilterDropdown
        open
        onOpenChange={onOpenChange}
        filters={{ ...defaultFilters, projectIds: ['work'] }}
        onUpdateFilters={onUpdateFilters}
        onClearFilters={vi.fn()}
        tasks={[]}
        projects={projects}
        savedFilters={[]}
        activeSavedFilterId={null}
        hasActiveFilters={false}
        onDeleteSavedFilter={onDeleteSavedFilter}
        onApplySavedFilter={onApplySavedFilter}
        onSaveFilter={onSaveFilter}
        onToggleStarFilter={onToggleStarFilter}
        statuses={statuses}
      >
        <button type="button">Filters</button>
      </FilterDropdown>
    )

    fireEvent.click(screen.getByText('Project'))
    fireEvent.click(
      screen.getByText('phaseF.componentsTasksFiltersFilterPanelsProjectPanel.noProject')
    )
    expect(onUpdateFilters).toHaveBeenCalledWith({ projectIds: [] })
    fireEvent.click(screen.getByText('Work'))
    expect(onUpdateFilters).toHaveBeenLastCalledWith({ projectIds: [] })
  })
})
