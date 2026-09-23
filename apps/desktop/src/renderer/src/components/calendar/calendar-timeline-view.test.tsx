import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultTask, type Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { CalendarTimelineView } from './calendar-timeline-view'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? [key, ...Object.values(vars)].join('|') : key,
    i18n: { language: 'en-US' }
  })
}))

const workspace: { tasks: Task[]; projects: Project[] } = { tasks: [], projects: [] }

vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: () => workspace
}))

function task(id: string, title: string, start: Date | null, due: Date | null): Task {
  return { ...createDefaultTask('launch', 'todo', title), id, startDate: start, dueDate: due }
}

const launch: Project = {
  id: 'launch',
  name: 'Launch',
  description: '',
  icon: 'folder',
  color: '#22aa66',
  statuses: [],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(2026, 0, 1),
  taskCount: 2
}

describe('CalendarTimelineView', () => {
  beforeEach(() => {
    workspace.projects = [launch]
    workspace.tasks = [
      task('draft', 'Write draft', new Date(2026, 2, 3), new Date(2026, 2, 10)),
      task('ship', 'Ship it', null, new Date(2026, 2, 12)),
      task('later', 'Next month', new Date(2026, 3, 2), new Date(2026, 3, 9))
    ]
  })

  it('draws each scheduled task of the month as a row under its project', () => {
    render(<CalendarTimelineView anchorDate="2026-03-15" selectedTaskId={null} />)

    const group = screen.getByRole('region', { name: 'Launch' })
    expect(within(group).getByRole('heading', { name: 'Launch' })).toBeInTheDocument()
    expect(within(group).getByText('timeline.task-count|2')).toBeInTheDocument()
    expect(
      within(group)
        .getAllByTestId('timeline-task-row')
        .map((row) => row.getAttribute('aria-label'))
    ).toEqual(['Write draft, timeline.span|Mar 3|Mar 10', 'Ship it, timeline.due|Mar 12'])

    expect(screen.getByTestId('timeline-task-bar').style.gridColumn).toBe('4 / 12')
    const marker = screen.getByTestId('timeline-task-marker')
    expect(marker.dataset.kind).toBe('due')
    expect(marker.style.gridColumn).toBe('13 / 14')
    expect(screen.getByTestId('timeline-project-bar').style.gridColumn).toBe('4 / 14')
  })

  it('opens the task a row belongs to and marks it expanded', () => {
    const onSelectTask = vi.fn()
    const { rerender } = render(
      <CalendarTimelineView
        anchorDate="2026-03-15"
        selectedTaskId={null}
        onSelectTask={onSelectTask}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Ship it/ }))
    expect(onSelectTask).toHaveBeenCalledWith('ship', { x: 0, y: 0, width: 0, height: 0 })

    rerender(
      <CalendarTimelineView
        anchorDate="2026-03-15"
        selectedTaskId="ship"
        onSelectTask={onSelectTask}
      />
    )
    expect(screen.getByRole('button', { name: /^Ship it/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByRole('button', { name: /^Write draft/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('explains how to fill a month that has no scheduled tasks', () => {
    render(<CalendarTimelineView anchorDate="2026-06-15" selectedTaskId={null} />)

    expect(screen.getByText('timeline.empty-title')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Launch' })).not.toBeInTheDocument()
  })

  it('marks a start-only task with an outlined diamond and names its start date', () => {
    workspace.tasks = [task('kickoff', 'Kickoff', new Date(2026, 2, 20), null)]

    render(<CalendarTimelineView anchorDate="2026-03-15" selectedTaskId={null} />)

    expect(screen.getByTestId('timeline-task-row')).toHaveAttribute(
      'aria-label',
      'Kickoff, timeline.starts|Mar 20'
    )
    const marker = screen.getByTestId('timeline-task-marker')
    expect(marker.dataset.kind).toBe('start')
    expect(marker.style.gridColumn).toBe('21 / 22')
    expect(marker.style.backgroundColor).toBe('transparent')
  })

  it('names a date outside the shown year with its year', () => {
    workspace.tasks = [task('carry', 'Carry over', new Date(2025, 11, 28), new Date(2026, 0, 4))]

    render(<CalendarTimelineView anchorDate="2026-01-10" selectedTaskId={null} />)

    expect(screen.getByTestId('timeline-task-row')).toHaveAttribute(
      'aria-label',
      'Carry over, timeline.span|Dec 28, 2025|Jan 4'
    )
  })
})
