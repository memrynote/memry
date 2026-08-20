import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AIConnectionsPanel, type AIConnection } from '@/components/journal/ai-connections-panel'
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
})
