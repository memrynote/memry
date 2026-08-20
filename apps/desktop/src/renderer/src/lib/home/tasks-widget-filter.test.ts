import { describe, it, expect } from 'vitest'
import { resolveTasksFilter, selectTasksForWidget } from './tasks-widget-filter'
import { defaultFilters, type Project, type SavedFilter } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'

const projects = [
  { id: 'p1', name: 'P', color: '', statuses: [{ id: 's1', type: 'todo', name: 'Todo' }] }
] as unknown as Project[]

const atNoon = (offsetDays: number): Date => {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + offsetDays)
  return d
}

const task = (id: string, dueOffsetDays: number): Task =>
  ({
    id,
    parentId: null,
    projectId: 'p1',
    statusId: 's1',
    dueDate: atNoon(dueOffsetDays),
    archivedAt: null,
    completedAt: null
  }) as unknown as Task

const tasks = [task('today', 0), task('tomorrow', 1), task('next-week', 3)]

describe('resolveTasksFilter', () => {
  it('defaults to today view', () => {
    expect(resolveTasksFilter({})).toEqual({ kind: 'view', viewId: 'today' })
  })

  it('reads the date ranges the header pill offers', () => {
    for (const viewId of ['all', 'today', 'tomorrow', 'next7', 'nodue'] as const) {
      expect(resolveTasksFilter({ dateRange: viewId })).toEqual({ kind: 'view', viewId })
    }
  })

  it('maps legacy week / upcoming ranges onto next7', () => {
    expect(resolveTasksFilter({ dateRange: 'week' })).toEqual({ kind: 'view', viewId: 'next7' })
    expect(resolveTasksFilter({ dateRange: 'upcoming' })).toEqual({ kind: 'view', viewId: 'next7' })
  })

  it('falls back to today for an unknown date range', () => {
    expect(resolveTasksFilter({ dateRange: 'bogus' })).toEqual({ kind: 'view', viewId: 'today' })
  })

  it('prefers a saved filter when set', () => {
    expect(resolveTasksFilter({ savedFilterId: 'sf1', dateRange: 'next7' })).toEqual({
      kind: 'saved',
      savedFilterId: 'sf1'
    })
  })
})

describe('selectTasksForWidget', () => {
  it('selects only tomorrow tasks for the tomorrow view', () => {
    const result = selectTasksForWidget(tasks, projects, [], { dateRange: 'tomorrow' })
    expect(result.map((t) => t.id)).toEqual(['tomorrow'])
  })

  it('falls back to the today view when the saved filter is gone', () => {
    const result = selectTasksForWidget(tasks, projects, [], { savedFilterId: 'missing' })
    expect(result.map((t) => t.id)).toEqual(['today'])
  })

  it('uses a saved filter when present', () => {
    const saved: SavedFilter = {
      id: 'sf1',
      name: 'All',
      filters: defaultFilters,
      starred: false,
      createdAt: new Date()
    }
    const result = selectTasksForWidget(tasks, projects, [saved], { savedFilterId: 'sf1' })
    // default filters keep all active tasks
    expect(result.map((t) => t.id).sort()).toEqual(['next-week', 'today', 'tomorrow'])
  })

  it('selects every open task for the all view', () => {
    const result = selectTasksForWidget(tasks, projects, [], { dateRange: 'all' })
    expect(result.map((t) => t.id).sort()).toEqual(['next-week', 'today', 'tomorrow'])
  })

  it('spans the next seven days for the next7 view', () => {
    const result = selectTasksForWidget(tasks, projects, [], { dateRange: 'next7' })
    expect(result.map((t) => t.id).sort()).toEqual(['next-week', 'today', 'tomorrow'])
  })

  it('selects only undated tasks for the nodue view', () => {
    const undated = { ...task('undated', 0), dueDate: null }
    const result = selectTasksForWidget([...tasks, undated], projects, [], { dateRange: 'nodue' })
    expect(result.map((t) => t.id)).toEqual(['undated'])
  })

  it('keeps undated tasks out of the due-date views', () => {
    const undated = { ...task('undated', 0), dueDate: null }
    for (const dateRange of ['today', 'tomorrow', 'next7']) {
      const result = selectTasksForWidget([...tasks, undated], projects, [], { dateRange })
      expect(result.map((t) => t.id)).not.toContain('undated')
    }
  })

  it('uses a saved no-due-date filter when present', () => {
    const saved: SavedFilter = {
      id: 'sf-none',
      name: 'No due date',
      filters: {
        ...defaultFilters,
        dueDate: { type: 'none', customStart: null, customEnd: null }
      },
      starred: false,
      createdAt: new Date()
    }
    const undated = { ...task('undated', 0), dueDate: null }
    const result = selectTasksForWidget([...tasks, undated], projects, [saved], {
      savedFilterId: 'sf-none'
    })
    expect(result.map((t) => t.id)).toEqual(['undated'])
  })
})
