import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AIConnectionsPanel, type AIConnection } from '@/components/journal/ai-connections-panel'
import { CollapsibleSection, JournalSection } from '@/components/journal/collapsible-section'
import { DayContextSidebar } from '@/components/journal/day-context-sidebar'
import { DayCard } from '@/components/journal/day-card'
import { FloatingDayContext } from '@/components/journal/floating-day-context'
import { JournalNavigationRow } from '@/components/journal/journal-navigation-row'
import { TodaysNotesSection } from '@/components/journal/todays-notes'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, values?: Record<string, unknown>) =>
      values?.count !== undefined
        ? `${key}:${String(values.count)}`
        : values?.date !== undefined
          ? `${key}:${String(values.date)}`
          : values?.title !== undefined
            ? `${key}:${String(values.title)}`
            : key
  })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '12h' } })
}))

vi.mock('@/components/journal/journal-editor', () => ({
  JournalEditor: ({
    content,
    placeholder,
    onContentChange,
    onFocusToggle
  }: {
    content: string
    placeholder: string
    onContentChange?: (content: string) => void
    onFocusToggle?: () => void
  }) => (
    <div>
      <button onClick={() => onContentChange?.(`${content}-changed`)}>{placeholder}</button>
      <button onClick={onFocusToggle}>focus</button>
    </div>
  )
}))

vi.mock('@/components/journal/journal-reminder-button', () => ({
  JournalReminderButton: ({ journalDate }: { journalDate: string }) => (
    <button>reminder:{journalDate}</button>
  )
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => <button onClick={onClick}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

const note = (id: string, title: string, created: string) =>
  ({
    id,
    title,
    path: `${title}.md`,
    content: '',
    created,
    modified: created,
    tags: [],
    properties: {},
    wordCount: 1,
    backlinks: 0,
    outgoingLinks: 0
  }) as never

describe('journal component coverage', () => {
  it('toggles collapsible content and forwards journal editor events', () => {
    const onContentChange = vi.fn()
    const onFocusToggle = vi.fn()

    render(
      <>
        <CollapsibleSection icon={<span>icon</span>} title="Events" count={2}>
          body
        </CollapsibleSection>
        <JournalSection
          content="draft"
          onContentChange={onContentChange}
          onFocusToggle={onFocusToggle}
        />
      </>
    )

    const header = screen.getByRole('button', { name: /Events/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'editor.placeholder.default' }))
    fireEvent.click(screen.getByRole('button', { name: 'focus' }))
    expect(onContentChange).toHaveBeenCalledWith('draft-changed')
    expect(onFocusToggle).toHaveBeenCalled()
  })

  it('renders schedule/task sidebar branches and handles actions', () => {
    const onEventClick = vi.fn()
    const onTaskClick = vi.fn()
    const onTaskToggle = vi.fn()

    const { rerender } = render(
      <DayContextSidebar
        isToday
        overdueCount={1}
        events={[
          {
            id: 'event-1',
            title: 'Standup',
            time: '09:00',
            type: 'meeting',
            attendeeCount: 3
          },
          { id: 'event-2', title: 'Focus', time: '10:00', type: 'focus', isAllDay: true }
        ]}
        tasks={[
          {
            id: 'task-1',
            title: 'Pay invoice',
            completed: false,
            priority: 'urgent',
            dueTime: '08:00',
            isOverdue: true
          },
          { id: 'task-2', title: 'Already done', completed: true, priority: 'low' }
        ]}
        onEventClick={onEventClick}
        onTaskClick={onTaskClick}
        onTaskToggle={onTaskToggle}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Standup/ }))
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Pay invoice. task.notCompleted, task.priority, task.overdue'
      })
    )
    fireEvent.click(screen.getByRole('button', { name: /task.markComplete/ }))
    expect(onEventClick).toHaveBeenCalledWith('event-1')
    expect(onTaskClick).toHaveBeenCalledWith('task-1')
    expect(onTaskToggle).toHaveBeenCalledWith('task-1')

    fireEvent.click(screen.getByRole('button', { name: /section.todaysSchedule/ }))
    expect(screen.queryByText('Standup')).not.toBeInTheDocument()

    rerender(<DayContextSidebar isPast events={[]} tasks={[]} />)
    fireEvent.click(screen.getByRole('button', { name: /section.schedule/ }))
    expect(screen.getByText('empty.noEventsWereScheduled')).toBeInTheDocument()
    expect(screen.getByText('empty.noTasksWereDue')).toBeInTheDocument()

    const hidden = render(<DayContextSidebar showSchedule={false} showTasks={false} />)
    expect(hidden.container.firstChild).toBeNull()
  })

  it('covers AI connections loading, empty, error, list, expand, and callbacks', () => {
    const onRefresh = vi.fn()
    const onConnectionClick = vi.fn()
    const connections: AIConnection[] = [
      { id: 'j', type: 'journal', date: 'May 10', preview: 'same idea', score: 0.92 },
      { id: 'n', type: 'note', title: 'Roadmap', preview: 'related note', score: 0.8 },
      { id: 'p', type: 'page', title: 'Spec', preview: 'related page', score: 0.5 }
    ]

    const { rerender } = render(
      <AIConnectionsPanel connections={[]} isLoading onRefresh={onRefresh} />
    )
    expect(screen.getByText('ai.loading')).toBeInTheDocument()

    rerender(<AIConnectionsPanel connections={[]} isNewUser />)
    expect(screen.getByText('ai.empty.willAppear')).toBeInTheDocument()

    rerender(<AIConnectionsPanel connections={[]} error="offline" onRefresh={onRefresh} />)
    fireEvent.click(screen.getByRole('button', { name: 'button.retry' }))
    expect(onRefresh).toHaveBeenCalled()

    rerender(
      <AIConnectionsPanel
        connections={connections}
        maxItems={1}
        onConnectionClick={onConnectionClick}
        onRefresh={onRefresh}
      />
    )
    fireEvent.click(screen.getByText('May 10').closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: 'count.moreConnections_plural:2' }))
    fireEvent.click(screen.getByText('Roadmap').closest('button')!)
    expect(onConnectionClick).toHaveBeenCalledWith(connections[0])
    expect(onConnectionClick).toHaveBeenCalledWith(connections[1])
  })

  it('covers today notes empty, create, list, active, and expand paths', () => {
    const onCreate = vi.fn()
    const onNoteClick = vi.fn()

    const { rerender } = render(<TodaysNotesSection notes={[]} onCreate={onCreate} />)
    fireEvent.click(screen.getByRole('button', { name: 'action.createNewNote' }))
    fireEvent.click(screen.getByRole('button', { name: 'action.createNote' }))
    expect(onCreate).toHaveBeenCalledTimes(2)
    expect(onCreate.mock.calls[0][0]).toContain('note.generatedTitle')

    rerender(
      <TodaysNotesSection
        notes={[
          note('note-1', 'Morning', '2026-05-10T08:30:00.000Z'),
          note('note-2', 'Noon', '2026-05-10T12:00:00.000Z'),
          note('note-3', 'Evening', '2026-05-10T18:00:00.000Z')
        ]}
        maxItems={1}
        activeNoteId="note-1"
        onNoteClick={onNoteClick}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Morning/ }))
    fireEvent.click(screen.getByRole('button', { name: 'action.showMoreNotes_plural:2' }))
    fireEvent.click(screen.getByRole('button', { name: /Noon/ }))
    expect(onNoteClick).toHaveBeenCalledWith('note-1')
    expect(onNoteClick).toHaveBeenCalledWith('note-2')
  })

  it('covers journal navigation variants and actions', () => {
    const handlers = {
      onPrevious: vi.fn(),
      onNext: vi.fn(),
      onToday: vi.fn(),
      onFocusToggle: vi.fn(),
      onBookmarkToggle: vi.fn(),
      onVersionHistory: vi.fn(),
      onExport: vi.fn()
    }

    const { rerender } = render(
      <JournalNavigationRow
        viewState={{ type: 'day', date: '2026-05-10' }}
        isToday={false}
        isBookmarked={false}
        hasEntry
        journalDate="2026-05-10"
        {...handlers}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'nav.previousDay' }))
    fireEvent.click(screen.getByRole('button', { name: 'nav.nextDay' }))
    fireEvent.click(screen.getByRole('button', { name: 'date.relative.today' }))
    fireEvent.click(screen.getByRole('button', { name: 'action.addBookmark' }))
    fireEvent.click(screen.getByRole('button', { name: /action.compactMode/ }))
    fireEvent.click(screen.getByRole('button', { name: /action.versionHistory/ }))
    fireEvent.click(screen.getByRole('button', { name: 'action.export' }))
    expect(handlers.onPrevious).toHaveBeenCalled()
    expect(handlers.onNext).toHaveBeenCalled()
    expect(handlers.onToday).toHaveBeenCalled()
    expect(handlers.onBookmarkToggle).toHaveBeenCalled()
    expect(handlers.onFocusToggle).toHaveBeenCalled()
    expect(handlers.onVersionHistory).toHaveBeenCalled()
    expect(handlers.onExport).toHaveBeenCalled()

    rerender(
      <JournalNavigationRow
        viewState={{ type: 'month', year: 2026, month: 4 }}
        isToday
        isCompact
        isBookmarked
        hasEntry={false}
        journalDate={null}
        {...handlers}
      />
    )
    expect(screen.getByRole('button', { name: 'nav.previousMonth' })).toBeInTheDocument()

    rerender(
      <JournalNavigationRow
        viewState={{ type: 'year', year: 2026 }}
        isToday
        isBookmarked
        hasEntry={false}
        journalDate={null}
        {...handlers}
      />
    )
    expect(screen.getByRole('button', { name: 'nav.nextYear' })).toBeInTheDocument()
    expect(within(screen.getByRole('navigation')).queryByText('date.relative.today')).toBeNull()
  })

  it('renders day cards with event/task sections, focus mode, and future placeholders', () => {
    const onToggleFocusMode = vi.fn()
    const { rerender } = render(
      <DayCard
        date="2026-05-10"
        isActive
        isToday
        isFuture={false}
        opacity={0.9}
        onToggleFocusMode={onToggleFocusMode}
        calendarEvents={[
          { id: 'event-1', time: '09:00', title: 'Standup', attendeeCount: 3 },
          { id: 'event-2', time: '11:00', title: 'Focus' }
        ]}
        overdueTasks={[
          { id: 'task-1', title: 'Pay invoice', dueDate: 'Yesterday', completed: false }
        ]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /section.calendarEvents/ }))
    expect(screen.getByText('Standup')).toBeInTheDocument()
    expect(screen.getByText('(count.people:3)')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /section.overdueTasks/ }))
    expect(screen.getByText('Pay invoice')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'action.enterFocusMode' }))
    expect(onToggleFocusMode).toHaveBeenCalled()

    rerender(
      <DayCard
        date="2026-05-11"
        isActive={false}
        isToday={false}
        isFuture
        opacity={0.4}
        viewMode="focus"
        onToggleFocusMode={onToggleFocusMode}
        calendarEvents={[{ id: 'event-3', time: '12:00', title: 'Hidden in focus' }]}
        overdueTasks={[
          { id: 'task-2', title: 'Hidden task', dueDate: 'Tomorrow', completed: false }
        ]}
      />
    )
    expect(screen.queryByText('Hidden in focus')).not.toBeInTheDocument()
    expect(screen.queryByText('Hidden task')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'editor.placeholder.future' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'action.exitFocusMode' }))
    expect(onToggleFocusMode).toHaveBeenCalledTimes(2)
  })

  it('covers floating day context expanded, tabbed, collapsed, and empty states', () => {
    const onEventClick = vi.fn()
    const onTaskClick = vi.fn()
    const onTaskToggle = vi.fn()
    const { container, rerender } = render(
      <FloatingDayContext
        isToday
        overdueCount={1}
        events={[
          { id: 'event-1', title: 'Standup', time: '09:00', type: 'meeting', attendeeCount: 2 },
          { id: 'event-2', title: 'Deep work', time: '10:00', type: 'focus' },
          { id: 'event-3', title: 'Medication', time: '12:00', type: 'reminder', isAllDay: true },
          { id: 'event-4', title: 'Other hold', time: '14:00', type: 'other' }
        ]}
        tasks={[
          {
            id: 'task-1',
            title: 'Pay invoice',
            completed: false,
            priority: 'urgent',
            isOverdue: true
          },
          { id: 'task-2', title: 'Review notes', completed: false, priority: 'unknown' as never },
          { id: 'task-3', title: 'Already done', completed: true, priority: 'low' }
        ]}
        onEventClick={onEventClick}
        onTaskClick={onTaskClick}
        onTaskToggle={onTaskToggle}
      />
    )

    fireEvent.click(screen.getByText('Standup').closest('button')!)
    expect(onEventClick).toHaveBeenCalledWith('event-1')
    expect(screen.getByText('date.allDay')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /section.tasks/ }))
    fireEvent.click(screen.getByText('Pay invoice'))
    fireEvent.click(screen.getByText('Pay invoice').closest('div')!.querySelector('button')!)
    expect(onTaskClick).toHaveBeenCalledWith('task-1')
    expect(onTaskToggle).toHaveBeenCalledWith('task-1')
    expect(screen.getByText('count.overdue:1')).toBeInTheDocument()
    expect(screen.getByText('count.completed:1')).toBeInTheDocument()

    const collapseButton = Array.from(container.querySelectorAll('button')).at(2)!
    fireEvent.click(collapseButton)
    expect(screen.queryByText('Pay invoice')).not.toBeInTheDocument()
    fireEvent.click(container.querySelector('button')!)
    expect(screen.getByText('date.relative.today')).toBeInTheDocument()

    rerender(<FloatingDayContext events={[]} tasks={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
