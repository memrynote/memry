import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InboxFilingHistoryList } from './inbox/inbox-filing-history'
import { InboxInsightsView } from './inbox/inbox-insights-view'
import { ColorPicker } from './note/tags-row/ColorPicker'
import { NoteReminderButton } from './note/note-reminder-button'
import { TabBarContextMenu } from './tabs/tab-bar-context-menu'
import { TruncatedTabTitle } from './tabs/truncated-tab-title'

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  closeAllTabs: vi.fn(),
  setReminder: vi.fn(),
  useInboxStats: vi.fn(),
  useInboxPatterns: vi.fn(),
  useInboxFilingHistory: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
    i18n: { language: 'en-US' }
  })
}))

vi.mock('@/services/inbox-service', () => ({
  formatCompactDate: (value: string) => `date:${value.slice(0, 10)}`
}))

vi.mock('@/hooks/use-inbox', () => ({
  useInboxStats: () => mocks.useInboxStats(),
  useInboxPatterns: () => mocks.useInboxPatterns(),
  useInboxFilingHistory: () => mocks.useInboxFilingHistory()
}))

vi.mock('./inbox/inbox-stats-cards', () => ({
  InboxStatsCards: ({ stats }: any) => <div>stats:{stats.total}</div>
}))

vi.mock('./inbox/inbox-capture-heatmap', () => ({
  InboxCaptureHeatmap: ({ patterns }: any) => <div>heatmap:{patterns?.day ?? 'none'}</div>
}))

vi.mock('./inbox/inbox-type-distribution', () => ({
  InboxTypeDistribution: ({ stats }: any) => <div>types:{stats.total}</div>
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    openTab: mocks.openTab,
    closeAllTabs: mocks.closeAllTabs
  })
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

vi.mock('@/hooks/use-note-reminders', () => ({
  useNoteReminders: () => ({
    activeReminders: [],
    hasActiveReminder: true,
    nextReminder: { remindAt: '2026-05-10T10:00:00.000Z' },
    activeReminderCount: 12,
    actions: {
      setReminder: mocks.setReminder,
      editReminder: vi.fn(),
      deleteReminder: vi.fn()
    }
  })
}))

vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))

// The real `ReminderPicker` renders here on purpose: a hand-written stub would
// re-declare `onSelect` from this file's reading of it, which is exactly how the
// note-dropping bug in #1527 stayed green. Only the Radix primitive underneath
// is stood in, because it does not open in jsdom.
vi.mock('@/components/ui/picker', async () => {
  const { createPickerStub } = await import('@tests/utils/picker-stub')
  return createPickerStub()
})

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

describe('extra zero renderer surfaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useInboxStats.mockReturnValue({ stats: { total: 3 }, isLoading: false })
    mocks.useInboxPatterns.mockReturnValue({ data: [{ day: 'Mon' }], isLoading: false })
    mocks.useInboxFilingHistory.mockReturnValue({
      data: {
        entries: [
          {
            id: 'history-1',
            itemType: 'link',
            itemTitle: 'Article',
            filedAction: 'folder',
            filedTo: 'notes/research/article.md',
            filedAt: '2026-05-10T00:00:00.000Z'
          },
          {
            id: 'history-2',
            itemType: 'unknown',
            itemTitle: '',
            filedAction: 'linked',
            filedTo: 'target-note',
            filedAt: '2026-05-11T00:00:00.000Z'
          }
        ]
      },
      isLoading: false
    })
  })

  it('renders inbox filing history empty, folder, linked, and insights states', () => {
    const { rerender } = render(<InboxFilingHistoryList items={[]} />)
    expect(
      screen.getByText('phaseF.componentsInboxInboxFilingHistory.noItemsFiledYet')
    ).toBeInTheDocument()

    rerender(
      <InboxFilingHistoryList
        items={
          [
            {
              id: 'history-1',
              itemType: 'link',
              itemTitle: 'Article',
              filedAction: 'folder',
              filedTo: 'notes/research/article.md',
              filedAt: '2026-05-10T00:00:00.000Z'
            },
            {
              id: 'history-2',
              itemType: 'unknown',
              itemTitle: '',
              filedAction: 'linked',
              filedTo: 'target-note',
              filedAt: '2026-05-11T00:00:00.000Z'
            }
          ] as any
        }
      />
    )
    expect(screen.getByText('Article')).toBeInTheDocument()
    expect(screen.getByText('Untitled Item')).toBeInTheDocument()
    expect(screen.getByText('phaseF.componentsInboxInboxFilingHistory.linked')).toBeInTheDocument()

    render(<InboxInsightsView />)
    expect(screen.getByText('stats:3')).toBeInTheDocument()
    expect(screen.getByText('heatmap:Mon')).toBeInTheDocument()

    mocks.useInboxStats.mockReturnValue({ stats: { total: 0 }, isLoading: true })
    render(<InboxInsightsView />)
    expect(
      screen.getByText('phaseF.componentsInboxInboxInsightsView.loadingInsights')
    ).toBeInTheDocument()
  })

  it('renders tag color picker and note reminder button interactions', () => {
    const onSelectColor = vi.fn()
    const onCancel = vi.fn()
    const onConfirm = vi.fn()

    render(
      <ColorPicker
        selectedColor="blue"
        onSelectColor={onSelectColor}
        tagName="work"
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    )
    fireEvent.click(screen.getByLabelText('tagsRow.colorAria:{"color":"rose"}'))
    expect(onSelectColor).toHaveBeenCalledWith('rose')
    fireEvent.click(screen.getByRole('button', { name: 'button.cancel' }))
    expect(onCancel).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'button.create' }))
    expect(onConfirm).toHaveBeenCalled()

    render(<NoteReminderButton noteId="note-1" />)
    expect(screen.getByText('9+')).toBeInTheDocument()

    // The note goes in through the picker's own textarea, so it only reaches
    // `setReminder` if this button reads the argument the picker actually sends.
    fireEvent.change(
      screen.getByPlaceholderText('phaseF.componentsReminderReminderPicker.addANoteOptional'),
      { target: { value: 'note' } }
    )
    fireEvent.click(screen.getByTestId('preset-tomorrow'))
    expect(mocks.setReminder).toHaveBeenCalledWith(expect.any(Date), 'note')
  })

  it('renders tab bar context actions and title truncation', () => {
    render(
      <TabBarContextMenu groupId="group-1">
        <button type="button">tab empty area</button>
      </TabBarContextMenu>
    )

    fireEvent.click(screen.getByRole('button', { name: /New Tab/ }))
    expect(mocks.openTab).toHaveBeenCalledWith(expect.objectContaining({ type: 'inbox' }), {
      groupId: 'group-1'
    })

    fireEvent.click(
      screen.getByRole('button', {
        name: 'phaseF.componentsTabsTabBarContextMenu.closeAllTabs'
      })
    )
    expect(mocks.closeAllTabs).toHaveBeenCalledWith('group-1')

    const { rerender } = render(<TruncatedTabTitle title="Short" maxWidth={200} />)
    expect(screen.getByText('Short')).toBeInTheDocument()

    const span = screen.getByText('Short')
    Object.defineProperty(span, 'scrollWidth', { value: 300, configurable: true })
    Object.defineProperty(span, 'clientWidth', { value: 120, configurable: true })
    rerender(<TruncatedTabTitle title="A very long title" maxWidth={120} />)
    expect(screen.getByText('A very long title')).toBeInTheDocument()
  })
})
