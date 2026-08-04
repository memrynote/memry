import { fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ChordIndicator } from './keyboard/chord-indicator'
import { DetailHeader } from './inbox-detail/detail-header'
import { NoteDetail } from './inbox-detail/note-detail'
import { SnoozeCountdown } from './snooze/snooze-countdown'
import { SortableTab } from './tabs/sortable-tab'
import { FilterBar } from './tasks/filters/filter-bar'
import { FilterChip } from './tasks/filters/filter-chip'
import { DueDatePanel } from './tasks/filters/filter-panels/due-date-panel'
import { QuickAddHelp } from './tasks/quick-add/quick-add-help'
import { QuickOptionsBar } from './tasks/quick-add/quick-options-bar'
import { AutocompleteDropdown } from './tasks/quick-add/autocomplete-dropdown'
import { RepeatPicker } from './tasks/repeat-picker'
import { TaskEmptyState } from './tasks/task-empty-state'
import { TaskList } from './tasks/task-list'
import { UpcomingEmptyState } from './tasks/upcoming-empty-state'

const mocks = vi.hoisted(() => ({
  countdown: null as string | null,
  sortableState: { isDragging: false, isOver: false },
  activeFilters: false
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string) => key.split('.').at(-1) ?? key
  })
}))

vi.mock('@/hooks/use-keyboard-shortcuts-base', () => ({
  isMac: false
}))

vi.mock('@/services/inbox-service', () => ({
  formatCompactDate: () => 'May 10'
}))

vi.mock('./inbox-detail/content-section', () => ({
  TypeIcon: ({ type }: { type: string }) => <span>type:{type}</span>
}))

vi.mock('./inbox-detail/inbox-content-editor', () => ({
  InboxContentEditor: ({
    initialContent,
    editable,
    placeholder,
    onContentChange,
    onTitleChange
  }: {
    initialContent: string
    editable: boolean
    placeholder: string
    onContentChange?: (content: string) => void
    onTitleChange?: (title: string) => void
  }) => (
    <div>
      editor:{initialContent}:{String(editable)}:{placeholder}
      <button type="button" onClick={() => onContentChange?.('updated body')}>
        edit note
      </button>
      <button type="button" onClick={() => onTitleChange?.('updated title')}>
        rename note
      </button>
    </div>
  )
}))

vi.mock('./snooze/use-snooze-countdown', () => ({
  useSnoozeCountdown: () => mocks.countdown
}))

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: { 'data-sortable': 'true' },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn(),
    transform: { x: 1, y: 2, scaleX: 1, scaleY: 1 },
    transition: '',
    isDragging: mocks.sortableState.isDragging,
    isOver: mocks.sortableState.isOver
  })
}))

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => 'translate3d(1px, 2px, 0)' } }
}))

vi.mock('./tabs/regular-tab', () => ({
  RegularTab: ({ tab, className }: { tab: { title: string }; className?: string }) => (
    <div className={className}>regular:{tab.title}</div>
  )
}))

vi.mock('./tabs/tab-context-menu', () => ({
  TabContextMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('./tabs/tab-hover-preview', () => ({
  TabHoverPreview: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...props }: any) => (
    <button type="button" onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: any) => (
    <button type="button" onClick={() => onSelect?.({ preventDefault: () => {} })}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />
}))

vi.mock('@/components/ui/separator', () => ({
  Separator: () => <hr />
}))

vi.mock('@/components/tasks/date-picker-content', () => ({
  DatePickerContent: ({ onSelect }: { onSelect: (date: Date | null) => void }) => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const nextWeek = new Date(today)
    nextWeek.setDate(nextWeek.getDate() + 7)
    return (
      <div>
        <button type="button" onClick={() => onSelect(null)}>
          clear date
        </button>
        <button type="button" onClick={() => onSelect(today)}>
          select today
        </button>
        <button type="button" onClick={() => onSelect(tomorrow)}>
          select tomorrow
        </button>
        <button type="button" onClick={() => onSelect(nextWeek)}>
          select custom
        </button>
      </div>
    )
  }
}))

vi.mock('./tasks/filters/active-filters-bar', () => ({
  ActiveFiltersBar: ({
    onClearAll,
    onSaveFilter
  }: {
    onClearAll: () => void
    onSaveFilter?: () => void
  }) => (
    <div>
      active filters
      <button type="button" onClick={onClearAll}>
        clear all
      </button>
      <button type="button" onClick={onSaveFilter}>
        save filter
      </button>
    </div>
  )
}))

vi.mock('@/lib/task-utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/task-utils')>('@/lib/task-utils')
  return {
    ...actual,
    hasActiveFilters: () => mocks.activeFilters
  }
})

vi.mock('@/components/tasks/virtualized-all-tasks-view', () => ({
  VirtualizedAllTasksView: ({ storageKey, tasks, onQuickAdd, onTaskClick }: any) => (
    <div>
      all tasks:{storageKey}:{tasks.length}
      <button type="button" onClick={() => onQuickAdd('all quick', { projectId: null })}>
        all quick
      </button>
      <button type="button" onClick={() => onTaskClick?.('all-task')}>
        all open
      </button>
    </div>
  )
}))

vi.mock('@/components/tasks/project/virtualized-project-task-list', () => ({
  VirtualizedProjectTaskList: ({ project, tasks, onQuickAdd, onTaskClick }: any) => (
    <div>
      project tasks:{project.name}:{tasks.length}
      <button type="button" onClick={() => onQuickAdd('project quick', { projectId: project.id })}>
        project quick
      </button>
      <button type="button" onClick={() => onTaskClick?.('project-task')}>
        project open
      </button>
    </div>
  )
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  mocks.countdown = null
  mocks.sortableState = { isDragging: false, isOver: false }
  mocks.activeFilters = false
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

describe('more leaf renderer surfaces', () => {
  it('renders small inbox, keyboard, snooze, tab, and task-list wrappers', () => {
    const onClose = vi.fn()
    const onContentChange = vi.fn()
    const onTitleChange = vi.fn()
    const onQuickAdd = vi.fn()
    const onTaskClick = vi.fn()

    const { rerender } = render(<ChordIndicator isActive={false} />)
    expect(screen.queryByText('pressedWaitingForSecondKey')).not.toBeInTheDocument()

    rerender(<ChordIndicator isActive className="custom-chord" />)
    expect(screen.getByText('pressedWaitingForSecondKey')).toBeInTheDocument()

    render(<DetailHeader type="note" createdAt="2026-05-10T00:00:00Z" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'closePanel' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    render(
      <NoteDetail
        item={{ id: 'inbox-1', content: 'Body' } as any}
        onContentChange={onContentChange}
        onTitleChange={onTitleChange}
      />
    )
    fireEvent.click(screen.getByText('edit note'))
    fireEvent.click(screen.getByText('rename note'))
    expect(onContentChange).toHaveBeenCalledWith('updated body')
    expect(onTitleChange).toHaveBeenCalledWith('updated title')

    const snooze = render(<SnoozeCountdown snoozedUntil={null} />)
    expect(snooze.container).toBeEmptyDOMElement()
    mocks.countdown = '5m'
    snooze.rerender(<SnoozeCountdown snoozedUntil="2026-05-10T09:00:00Z" className="badge" />)
    expect(screen.getByText('5m')).toBeInTheDocument()

    mocks.sortableState = { isDragging: true, isOver: true }
    render(
      <SortableTab
        tab={{ id: 'tab-1', title: 'Tasks', type: 'tasks' } as any}
        groupId="group-1"
        isActive
      />
    )
    expect(screen.getByText('regular:Tasks')).toBeInTheDocument()

    const task = { id: 'task-1', title: 'Task' } as any
    const projects = [{ id: 'project-1', name: 'Work' }] as any[]
    const taskList = render(
      <TaskList
        tasks={[task]}
        projects={projects}
        selectedId="all"
        selectedType="view"
        onToggleComplete={vi.fn()}
        onQuickAdd={onQuickAdd}
        onTaskClick={onTaskClick}
      />
    )
    fireEvent.click(screen.getByText('all quick'))
    fireEvent.click(screen.getByText('all open'))
    expect(onQuickAdd).toHaveBeenCalledWith('all quick', { projectId: null })
    expect(onTaskClick).toHaveBeenCalledWith('all-task')

    taskList.rerender(
      <TaskList
        tasks={[task]}
        projects={projects}
        selectedId="project-1"
        selectedType="project"
        onToggleComplete={vi.fn()}
        onQuickAdd={onQuickAdd}
        onTaskClick={onTaskClick}
      />
    )
    fireEvent.click(screen.getByText('project quick'))
    fireEvent.click(screen.getByText('project open'))
    expect(onQuickAdd).toHaveBeenCalledWith('project quick', { projectId: 'project-1' })
    expect(onTaskClick).toHaveBeenCalledWith('project-task')
  })

  it('drives task empty states, quick-add helpers, chips, filters, and autocomplete', () => {
    const onAddTask = vi.fn()
    const onInsert = vi.fn()
    const onRemove = vi.fn()
    const onClearFilters = vi.fn()
    const onSaveFilter = vi.fn()
    const onSelect = vi.fn()
    const onClose = vi.fn()

    const { rerender, container } = render(<TaskEmptyState variant="today" />)
    expect(screen.getByText('todayTitle')).toBeInTheDocument()

    rerender(<TaskEmptyState variant="project" projectName="Work" onAddTask={onAddTask} />)
    fireEvent.click(screen.getByText('addTask'))
    expect(onAddTask).toHaveBeenCalledTimes(1)

    rerender(<UpcomingEmptyState hasOverdue={false} onAddTask={onAddTask} />)
    fireEvent.click(screen.getByText('addTask2'))
    rerender(<UpcomingEmptyState hasOverdue onAddTask={onAddTask} />)
    fireEvent.click(screen.getByText('addTask'))
    expect(onAddTask).toHaveBeenCalledTimes(3)

    render(<QuickOptionsBar onInsert={onInsert} />)
    const today = screen.getByRole('button', { name: /!today/ })
    fireEvent.click(today)
    fireEvent.keyDown(today, { key: 'Enter' })
    fireEvent.keyDown(today, { key: ' ' })
    expect(onInsert).toHaveBeenCalledWith('!today')

    render(<QuickAddHelp />)
    expect(screen.getAllByText('!tomorrow').length).toBeGreaterThan(0)
    expect(screen.getByText('exampleBuyMilkTomorrowHighPersonal')).toBeInTheDocument()

    render(
      <FilterChip
        label="Priority"
        icon={<span>icon</span>}
        dot="#f00"
        chipBg="#fff"
        chipText="#111"
        chipBorder="#ccc"
        onRemove={onRemove}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove Priority filter' }))
    expect(onRemove).toHaveBeenCalledTimes(1)

    mocks.activeFilters = false
    const inactive = render(
      <FilterBar
        filters={{} as any}
        projects={[]}
        onUpdateFilters={vi.fn()}
        onClearFilters={onClearFilters}
      />
    )
    expect(inactive.container).toBeEmptyDOMElement()

    mocks.activeFilters = true
    inactive.rerender(
      <FilterBar
        filters={{} as any}
        projects={[]}
        onUpdateFilters={vi.fn()}
        onClearFilters={onClearFilters}
        onSaveFilter={onSaveFilter}
      />
    )
    fireEvent.click(screen.getByText('clear all'))
    fireEvent.click(screen.getByText('save filter'))
    expect(onClearFilters).toHaveBeenCalledTimes(1)
    expect(onSaveFilter).toHaveBeenCalledTimes(1)

    rerender(
      <AutocompleteDropdown
        type="priority"
        options={[
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]}
        onSelect={onSelect}
        onClose={onClose}
      />
    )
    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByText('Low'))
    expect(onSelect).toHaveBeenCalledWith('high')
    expect(onSelect).toHaveBeenCalledWith('low')
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(
      <AutocompleteDropdown type={null} options={[]} onSelect={onSelect} onClose={onClose} />
    )
    expect(container).toBeTruthy()
  })

  it('drives repeat picker and due-date panel selections', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'))
    const onRepeatChange = vi.fn()
    const onOpenCustomDialog = vi.fn()
    const onSelectDueDate = vi.fn()
    const onSelectCalendarDate = vi.fn()
    const onClearDueDate = vi.fn()
    const onGoBack = vi.fn()

    render(
      <RepeatPicker
        value={null}
        dueDate={new Date('2026-05-10T00:00:00.000Z')}
        onChange={onRepeatChange}
        onOpenCustomDialog={onOpenCustomDialog}
      />
    )
    fireEvent.click(screen.getByText('doesNotRepeat'))
    fireEvent.click(screen.getByText('custom'))
    expect(onRepeatChange).toHaveBeenCalledWith(null)
    expect(onOpenCustomDialog).toHaveBeenCalledTimes(1)

    render(
      <DueDatePanel
        dueDate={{ type: 'custom', customStart: new Date('2026-05-13T00:00:00.000Z') }}
        onSelectDueDate={onSelectDueDate}
        onSelectCalendarDate={onSelectCalendarDate}
        onClearDueDate={onClearDueDate}
        onGoBack={onGoBack}
      />
    )
    fireEvent.click(screen.getByText('clear date'))
    fireEvent.click(screen.getByText('select today'))
    fireEvent.click(screen.getByText('select tomorrow'))
    fireEvent.click(screen.getByText('select custom'))
    fireEvent.click(screen.getByRole('button', { name: '' }))

    expect(onClearDueDate).toHaveBeenCalledTimes(1)
    expect(onSelectDueDate).toHaveBeenCalledWith('today')
    expect(onSelectDueDate).toHaveBeenCalledWith('tomorrow')
    expect(onSelectCalendarDate).toHaveBeenCalled()
    expect(onGoBack).toHaveBeenCalledTimes(1)
  })
})
