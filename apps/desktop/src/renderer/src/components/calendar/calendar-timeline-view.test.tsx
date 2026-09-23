import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultTask, type Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import { CalendarTimelineView } from './calendar-timeline-view'
import { DEFAULT_TIMELINE_SETTINGS, type TimelineSettings } from './timeline-model'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? [key, ...Object.values(vars)].join('|') : key,
    i18n: { language: 'en-US' }
  })
}))

const { updateTask, registerUndo, openTab } = vi.hoisted(() => ({
  updateTask: vi.fn(),
  registerUndo: vi.fn((_label: string, _undo: () => void) => 'undo-id'),
  openTab: vi.fn()
}))

const workspace: {
  tasks: Task[]
  projects: Project[]
  updateTask: typeof updateTask
  addTask: () => void
  deleteTask: () => void
} = { tasks: [], projects: [], updateTask, addTask: vi.fn(), deleteTask: vi.fn() }

vi.mock('@/contexts/tasks', () => ({ useTasksOptional: () => workspace }))
vi.mock('@/contexts/tabs', () => ({ useTabActionsOptional: () => ({ openTab }) }))
vi.mock('@/hooks/use-undo', () => ({
  useUndoTracker: () => ({ registerUndo, removeUndoEntry: vi.fn() })
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const d = (value: string): Date => {
  const [y, m, day] = value.split('-').map(Number)
  return new Date(y, m - 1, day)
}

function task(id: string, start: string | null, due: string | null, extra: Partial<Task> = {}) {
  return {
    ...createDefaultTask('launch', 'launch-todo', id),
    id,
    startDate: start ? d(start) : null,
    dueDate: due ? d(due) : null,
    ...extra
  }
}

const launch: Project = {
  id: 'launch',
  name: 'Launch',
  description: '',
  icon: 'folder',
  color: '#22aa66',
  statuses: [
    { id: 'launch-todo', name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
    { id: 'launch-done', name: 'Done', color: '#10b981', type: 'done', order: 1 }
  ],
  isDefault: false,
  isArchived: false,
  createdAt: new Date(2026, 0, 1),
  taskCount: 0
}

// Months zoom around 2026-03-15 lays out 2026-01-01 .. 2026-06-30; 26px a day.
const DAY = 26
const offsetOf = (date: string): number =>
  Math.round((d(date).getTime() - d('2026-01-01').getTime()) / 86_400_000)

function renderView(
  props: Partial<Omit<React.ComponentProps<typeof CalendarTimelineView>, 'settings'>> & {
    settings?: Partial<TimelineSettings>
  } = {}
) {
  const { settings, ...rest } = props
  const result = render(
    <CalendarTimelineView
      anchorDate="2026-03-15"
      weekStartsOn={1}
      settings={{ ...DEFAULT_TIMELINE_SETTINGS, ...settings }}
      {...rest}
    />
  )
  return { ...result, grid: screen.getByRole('grid') }
}

const row = (name: RegExp) => screen.getByRole('row', { name })

describe('CalendarTimelineView', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 2, 20, 12))
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    Element.prototype.scrollIntoView = vi.fn()
    updateTask.mockClear()
    registerUndo.mockClear()
    openTab.mockClear()
    workspace.projects = [launch]
    workspace.tasks = [
      task('Write draft', '2026-03-03', '2026-03-10'),
      task('Ship it', null, '2026-03-25'),
      task('Kickoff', '2026-03-22', null),
      task('Unplanned', null, null)
    ]
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('draws spans, milestones, open-ended bars and unscheduled rows under their project', () => {
    renderView()

    const group = screen.getByRole('rowgroup', { name: 'Launch' })
    expect(
      within(group)
        .getAllByTestId('timeline-task-row')
        .map((el) => el.getAttribute('aria-label'))
    ).toEqual([
      'Write draft, timeline.span|Mar 3|Mar 10|8, timeline.overdue',
      'Kickoff, timeline.starts|Mar 22',
      'Ship it, timeline.due|Mar 25',
      'Unplanned, timeline.no-date'
    ])

    const bar = within(row(/^Write draft/)).getByTestId('timeline-task-bar')
    expect(bar.style.insetInlineStart).toBe(`${offsetOf('2026-03-03') * DAY + 2}px`)
    expect(bar.style.width).toBe(`${8 * DAY - 4}px`)
    expect(within(row(/^Kickoff/)).getByTestId('timeline-task-bar').dataset.kind).toBe('start')
    expect(within(row(/^Ship it/)).getByTestId('timeline-task-milestone')).toBeInTheDocument()
    expect(within(row(/^Write draft/)).getByTestId('timeline-slip')).toBeInTheDocument()
    expect(screen.getByTestId('timeline-group-summary')).toBeInTheDocument()
  })

  it('opens on the start of the anchor period', () => {
    const { grid } = renderView()
    expect(grid.scrollLeft).toBe(offsetOf('2026-03-01') * DAY)
  })

  it('moves the anchor once scrolling passes into another month', () => {
    const onAnchorChange = vi.fn()
    const { grid } = renderView({ onAnchorChange })

    grid.scrollLeft = offsetOf('2026-03-28') * DAY
    fireEvent.scroll(grid)
    expect(onAnchorChange).not.toHaveBeenCalled()

    grid.scrollLeft = offsetOf('2026-04-11') * DAY
    fireEvent.scroll(grid)
    expect(onAnchorChange).toHaveBeenCalledWith('2026-04-11')
  })

  it('keeps the view still when a scroll-driven anchor slides the window', () => {
    const onAnchorChange = vi.fn()
    const { grid, rerender } = renderView({ onAnchorChange })
    grid.scrollLeft = offsetOf('2026-04-11') * DAY
    fireEvent.scroll(grid)

    rerender(
      <CalendarTimelineView
        anchorDate="2026-04-11"
        weekStartsOn={1}
        settings={DEFAULT_TIMELINE_SETTINGS}
        onAnchorChange={onAnchorChange}
      />
    )
    // The window now starts on Feb 1, 31 days later than before.
    expect(grid.scrollLeft).toBe((offsetOf('2026-04-11') - 31) * DAY)
  })

  it('selects rows with the arrow keys and opens the selection with Enter', () => {
    const onOpenTask = vi.fn()
    const { grid } = renderView({ onOpenTask })

    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(row(/^Write draft/)).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(row(/^Kickoff/)).toHaveAttribute('aria-selected', 'true')
    expect(grid).toHaveAttribute('aria-activedescendant', row(/^Kickoff/).id)

    fireEvent.keyDown(grid, { key: 'Enter' })
    expect(onOpenTask).toHaveBeenCalledWith('Kickoff', expect.any(Object))

    fireEvent.keyDown(grid, { key: 'Enter', ctrlKey: true })
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tasks',
        viewState: expect.objectContaining({ openTaskId: 'Kickoff' })
      })
    )

    fireEvent.keyDown(grid, { key: 'Escape' })
    expect(row(/^Kickoff/)).toHaveAttribute('aria-selected', 'false')
  })

  it('moves and resizes the selected task from the keyboard, each undoable', () => {
    const { grid } = renderView()
    fireEvent.pointerDown(row(/^Write draft/), { button: 0 })

    fireEvent.keyDown(grid, { key: 'ArrowRight', shiftKey: true })
    expect(updateTask).toHaveBeenLastCalledWith('Write draft', {
      startDate: d('2026-03-04'),
      dueDate: d('2026-03-11')
    })
    expect(registerUndo).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(grid, { key: 'ArrowLeft', altKey: true })
    expect(updateTask).toHaveBeenLastCalledWith('Write draft', {
      startDate: d('2026-03-03'),
      dueDate: d('2026-03-09')
    })

    fireEvent.keyDown(grid, { key: 'w' })
    expect(updateTask).toHaveBeenLastCalledWith('Write draft', {
      startDate: d('2026-03-10'),
      dueDate: d('2026-03-17')
    })

    fireEvent.keyDown(grid, { key: 'Backspace' })
    expect(updateTask).toHaveBeenLastCalledWith('Write draft', {
      startDate: null,
      dueDate: null,
      dueTime: null
    })

    // Undo puts back exactly what was there.
    registerUndo.mock.calls[0][1]()
    expect(updateTask).toHaveBeenLastCalledWith('Write draft', {
      startDate: d('2026-03-03'),
      dueDate: d('2026-03-10'),
      dueTime: null
    })
  })

  it('stretches a milestone into a span', () => {
    const { grid } = renderView()
    fireEvent.pointerDown(row(/^Ship it/), { button: 0 })
    fireEvent.keyDown(grid, { key: 'ArrowRight', altKey: true })
    expect(updateTask).toHaveBeenLastCalledWith('Ship it', {
      startDate: d('2026-03-25'),
      dueDate: d('2026-03-26')
    })
  })

  it('completes the selected task with C', () => {
    const { grid } = renderView()
    fireEvent.pointerDown(row(/^Ship it/), { button: 0 })
    fireEvent.keyDown(grid, { key: 'c' })
    expect(updateTask).toHaveBeenCalledWith(
      'Ship it',
      expect.objectContaining({ statusId: 'launch-done', completedAt: expect.any(Date) })
    )
  })

  it('drags a bar by whole days', () => {
    renderView()
    const bar = within(row(/^Write draft/)).getByTestId('timeline-task-bar')

    fireEvent.pointerDown(bar, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 100 + DAY * 2 + 3 })
    expect(row(/^Write draft/)).toHaveAttribute('aria-selected', 'true')
    fireEvent.pointerUp(window, { clientX: 100 + DAY * 2 + 3 })

    expect(updateTask).toHaveBeenCalledWith('Write draft', {
      startDate: d('2026-03-05'),
      dueDate: d('2026-03-12')
    })
  })

  it('resizes from the end handle and cancels a drag with Escape', () => {
    renderView()
    const handle = within(row(/^Write draft/)).getByTestId('timeline-resize-end')

    fireEvent.pointerDown(handle, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 100 + DAY * 3 })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.pointerUp(window, { clientX: 100 + DAY * 3 })
    expect(updateTask).not.toHaveBeenCalled()

    fireEvent.pointerDown(handle, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 100 + DAY * 3 })
    fireEvent.pointerUp(window, { clientX: 100 + DAY * 3 })
    expect(updateTask).toHaveBeenCalledWith('Write draft', {
      startDate: d('2026-03-03'),
      dueDate: d('2026-03-13')
    })
  })

  it('schedules an unscheduled task by clicking or dragging across its row', () => {
    renderView()
    const track = within(row(/^Unplanned/)).getAllByRole('gridcell')[1]
    const x = (date: string) => offsetOf(date) * DAY + 5

    fireEvent.pointerDown(track, { button: 0, clientX: x('2026-03-12') })
    fireEvent.pointerUp(window, { clientX: x('2026-03-12') })
    expect(updateTask).toHaveBeenLastCalledWith('Unplanned', {
      startDate: null,
      dueDate: d('2026-03-12')
    })

    fireEvent.pointerDown(track, { button: 0, clientX: x('2026-03-12') })
    fireEvent.pointerMove(window, { clientX: x('2026-03-16') })
    fireEvent.pointerUp(window, { clientX: x('2026-03-16') })
    expect(updateTask).toHaveBeenLastCalledWith('Unplanned', {
      startDate: d('2026-03-12'),
      dueDate: d('2026-03-16')
    })
  })

  it('runs actions from the Ctrl+K panel', () => {
    const { grid } = renderView()
    fireEvent.pointerDown(row(/^Write draft/), { button: 0 })
    fireEvent.keyDown(grid, { key: 'k', ctrlKey: true })

    const panel = screen.getByTestId('timeline-action-panel')
    fireEvent.click(within(panel).getByText('timeline.actions.move-later'))
    expect(updateTask).toHaveBeenLastCalledWith('Write draft', {
      startDate: d('2026-03-10'),
      dueDate: d('2026-03-17')
    })
    expect(screen.queryByTestId('timeline-action-panel')).not.toBeInTheDocument()
  })

  it('moves a task to another project from the panel', () => {
    const other: Project = { ...launch, id: 'other', name: 'Other', color: '#3366ff' }
    workspace.projects = [launch, other]
    const { grid } = renderView()
    fireEvent.pointerDown(row(/^Write draft/), { button: 0 })
    fireEvent.keyDown(grid, { key: 'p' })

    fireEvent.click(within(screen.getByTestId('timeline-action-panel')).getByText('Other'))
    expect(updateTask).toHaveBeenCalledWith('Write draft', { projectId: 'other' })
  })

  it('lists all-day events first and opens them', () => {
    const onOpenEvent = vi.fn()
    const offsite: CalendarProjectionItem = {
      projectionId: 'event:offsite',
      sourceType: 'event',
      sourceId: 'offsite',
      title: 'Offsite',
      descriptionPreview: null,
      startAt: d('2026-03-09').toISOString(),
      endAt: d('2026-03-12').toISOString(),
      isAllDay: true,
      timezone: 'UTC',
      visualType: 'event',
      editability: { canMove: true, canResize: true, canEditText: true, canDelete: true },
      source: {
        provider: null,
        calendarSourceId: null,
        title: null,
        color: null,
        kind: null,
        isMemryManaged: true
      },
      binding: null,
      snoozeOffsetMinutes: null
    }
    const { grid } = renderView({ items: [offsite], onOpenEvent })

    expect(screen.getAllByRole('rowgroup').map((g) => g.getAttribute('aria-label'))).toEqual([
      'timeline.events',
      'Launch'
    ])
    fireEvent.keyDown(grid, { key: 'ArrowDown' })
    expect(screen.getByTestId('timeline-event-row')).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(grid, { key: 'Enter' })
    expect(onOpenEvent).toHaveBeenCalledWith(offsite, expect.any(Object))
  })

  it('collapses a group and skips its rows when navigating', () => {
    renderView()
    fireEvent.click(screen.getByRole('button', { name: /Launch/ }))
    expect(screen.queryByTestId('timeline-task-row')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Launch/ })).toHaveAttribute('aria-expanded', 'false')
  })

  it('hides unscheduled tasks when Display says so', () => {
    renderView({ settings: { showUndated: false } })
    expect(screen.queryByRole('row', { name: /^Unplanned/ })).not.toBeInTheDocument()
  })

  it('explains an empty timeline', () => {
    workspace.tasks = []
    renderView()
    expect(screen.getByText('timeline.empty-title')).toBeInTheDocument()
  })

  it('shows what is selected in the action bar', () => {
    renderView()
    const bar = screen.getByTestId('timeline-action-bar')
    expect(within(bar).getByText('timeline.bar.summary|4|0')).toBeInTheDocument()

    act(() => {
      fireEvent.pointerDown(row(/^Write draft/), { button: 0 })
    })
    expect(within(bar).getByText('Write draft')).toBeInTheDocument()
    expect(
      within(bar).getByText('timeline.span|Mar 3|Mar 10|8, timeline.overdue')
    ).toBeInTheDocument()
  })
})
