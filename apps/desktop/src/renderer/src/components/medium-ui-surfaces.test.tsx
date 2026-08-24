import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CalendarMiniMonth } from '@/components/calendar/calendar-mini-month'
import { SummaryRow } from '@/components/folder-view/summary-row'
import { RowContextMenu } from '@/components/folder-view/row-context-menu'
import { StorageUsageBar } from '@/components/settings/storage-usage-bar'
import { CelebrationProgress } from '@/components/tasks/celebration-progress'
import { CollapsedEmptySection } from '@/components/tasks/empty-states/collapsed-empty-section'
import { getCollapsedEmptyProps } from '@/components/tasks/empty-states/collapsed-empty-presets'
import {
  CelebrationEmptyState,
  PlanningEmptyState,
  SimpleEmptyState
} from '@/components/tasks/empty-states/section-empty-states'
import { SubtaskDots } from '@/components/tasks/subtask-dots'
import { SubtaskProgressBadge } from '@/components/tasks/subtask-progress-badge'
import type { SidebarItem } from '@/contexts/tabs/types'

// The reveal action's label branches on platform. Pin macOS so these
// assertions read the Finder wording whatever host the suite runs on.
Object.defineProperty(navigator, 'platform', {
  value: 'MacIntel',
  configurable: true,
  // Enumerable so it survives the `{ ...navigator }` spreads some suites
  // use to stub the clipboard.
  enumerable: true
})

const storageState = vi.hoisted(() => ({
  data: null as null | {
    used: number
    limit: number
    breakdown: { notes: number; attachments: number; crdt: number; other: number }
  },
  loading: false,
  error: null as string | null,
  refresh: vi.fn()
}))

const sidebarNavigation = vi.hoisted(() => ({
  openSidebarItem: vi.fn(),
  openAsPin: vi.fn(),
  copyItemLink: vi.fn(),
  isOpenInTab: vi.fn(() => false),
  isActiveItem: vi.fn(() => false)
}))

const notesServiceMock = vi.hoisted(() => ({
  openExternal: vi.fn(),
  revealInFinder: vi.fn()
}))

const clipboardWriteMock = vi.hoisted(() => vi.fn())

const toastMock = vi.hoisted(() => ({
  error: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join('/')}` : key,
    i18n: { language: 'en-US' }
  })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastMock.error
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn()
  })
}))

vi.mock('@/hooks/use-storage-usage', () => ({
  useStorageUsage: () => storageState
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => sidebarNavigation
}))

vi.mock('@/services/notes-service', () => ({
  notesService: notesServiceMock
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />,
  ContextMenuShortcut: ({ children }: { children: React.ReactNode }) => <span>{children}</span>
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    )
  }
}))

beforeEach(() => {
  storageState.data = null
  storageState.loading = false
  storageState.error = null
  storageState.refresh.mockReset()
  sidebarNavigation.openSidebarItem.mockReset()
  sidebarNavigation.openAsPin.mockReset()
  sidebarNavigation.copyItemLink.mockReset()
  sidebarNavigation.isOpenInTab.mockReset().mockReturnValue(false)
  sidebarNavigation.isActiveItem.mockReset().mockReturnValue(false)
  notesServiceMock.openExternal.mockReset().mockResolvedValue(undefined)
  notesServiceMock.revealInFinder.mockReset().mockResolvedValue(undefined)
  toastMock.error.mockReset()
  clipboardWriteMock.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', {
    ...navigator,
    clipboard: { writeText: clipboardWriteMock }
  })
})

describe('medium UI coverage surfaces', () => {
  it('renders storage loading, error, warning, legend, and refresh states', async () => {
    const user = userEvent.setup()

    storageState.loading = true
    const { rerender } = render(<StorageUsageBar />)
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument()

    storageState.loading = false
    storageState.error = 'quota unavailable'
    rerender(<StorageUsageBar />)
    expect(screen.getByText('quota unavailable')).toBeInTheDocument()
    await user.click(screen.getByRole('button'))
    expect(storageState.refresh).toHaveBeenCalledTimes(1)

    storageState.error = null
    storageState.data = {
      used: 900 * 1024,
      limit: 1000 * 1024,
      breakdown: {
        notes: 400 * 1024,
        attachments: 300 * 1024,
        crdt: 150 * 1024,
        other: 50 * 1024
      }
    }
    rerender(<StorageUsageBar />)

    expect(screen.getByText('vault.storage.title')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', `${900 * 1024}`)
    expect(screen.getByRole('alert')).toHaveTextContent('vault.storage.warningTitle')
    expect(screen.getByText(/vault.storage.categories.notes/)).toBeInTheDocument()
    expect(screen.getByText(/vault.storage.available/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /vault.storage.refreshAria/ }))
    expect(storageState.refresh).toHaveBeenCalledTimes(2)
  })

  it('covers subtask dot, badge, and celebration progress states', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()

    const { container, rerender } = render(<SubtaskDots completed={0} total={0} />)
    expect(container).toBeEmptyDOMElement()

    rerender(<SubtaskDots completed={2} total={4} onClick={onToggle} isExpanded />)
    const dotButton = screen.getByRole('button', { name: '2 of 4 subtasks complete' })
    await user.click(dotButton)
    fireEvent.keyDown(dotButton, { key: 'Enter' })
    expect(onToggle).toHaveBeenCalledTimes(2)
    expect(dotButton).toHaveTextContent('2/4')

    rerender(<SubtaskDots completed={6} total={8} maxDots={5} />)
    expect(screen.getByRole('button', { name: '6 of 8 subtasks complete' })).toHaveAttribute(
      'tabindex',
      '-1'
    )

    rerender(<SubtaskProgressBadge completed={3} total={3} onClick={onToggle} />)
    const completeBadge = screen.getByRole('button', {
      name: '3 of 3 subtasks complete (100%)'
    })
    await user.click(completeBadge)
    expect(completeBadge).toHaveTextContent('3/3')

    rerender(<CelebrationProgress progress={{ completed: 1, total: 2, percentage: 50 }} />)
    expect(screen.getByText('1/2')).toBeInTheDocument()
    rerender(<CelebrationProgress progress={{ completed: 2, total: 2, percentage: 100 }} />)
    expect(
      screen.getByLabelText('phaseF.componentsTasksCelebrationProgress.complete')
    ).toBeInTheDocument()
  })

  it('renders empty task states and collapsed presets', async () => {
    const user = userEvent.setup()
    const onAddTask = vi.fn()
    const onViewCalendar = vi.fn()

    render(
      <div>
        <CelebrationEmptyState onAddTask={onAddTask} />
        <SimpleEmptyState label="Tomorrow" onAddTask={onAddTask} />
        <PlanningEmptyState onAddTask={onAddTask} onViewCalendar={onViewCalendar} />
        <CollapsedEmptySection
          type="overdue"
          label="Overdue"
          message="All caught up"
          onAddTask={onAddTask}
        />
        <CollapsedEmptySection
          type="no-date"
          label="No Date"
          message="No floating tasks"
          onAddTask={onAddTask}
        />
      </div>
    )

    await user.click(screen.getByRole('button', { name: 'Add task for today' }))
    await user.click(screen.getByRole('button', { name: 'Add task for tomorrow' }))
    await user.click(screen.getByRole('button', { name: /addTask$/ }))
    await user.click(screen.getByRole('button', { name: 'Add task for overdue' }))
    await user.click(screen.getByRole('button', { name: 'Add task for no date' }))
    await user.click(screen.getByRole('button', { name: /viewCalendar$/ }))

    expect(onAddTask).toHaveBeenCalledTimes(5)
    expect(onViewCalendar).toHaveBeenCalledTimes(1)
    expect(getCollapsedEmptyProps('today')).toEqual({ label: 'TODAY', message: 'All clear!' })
    expect(getCollapsedEmptyProps('no-date')).toEqual({ label: 'NO DATE', message: 'No tasks' })
  })

  it('computes summary rows and drives the mini month calendar', async () => {
    const user = userEvent.setup()
    const onDateSelect = vi.fn()
    const onMonthChange = vi.fn()

    render(
      <>
        <table>
          <SummaryRow
            columns={[
              { id: 'title', label: 'Title', type: 'text', width: 150 },
              { id: 'wordCount', label: 'Words', type: 'number', width: 100 },
              { id: 'tags', label: 'Tags', type: 'tags', width: 120 }
            ]}
            notes={[
              {
                id: 'n1',
                title: 'Alpha',
                folder: 'notes',
                tags: ['work'],
                created: '2026-05-01',
                modified: '2026-05-01',
                wordCount: 100,
                properties: {}
              },
              {
                id: 'n2',
                title: 'Beta',
                folder: 'notes',
                tags: ['work', 'home'],
                created: '2026-05-02',
                modified: '2026-05-02',
                wordCount: 250,
                properties: {}
              }
            ]}
            summaries={{
              title: { type: 'count', label: 'Rows' },
              wordCount: { type: 'sum', label: 'Total' },
              tags: { type: 'countBy' }
            }}
            density="compact"
            showColumnBorders
            columnWidths={{ title: 160 }}
          />
        </table>
        <CalendarMiniMonth
          anchorDate="2026-05-10"
          items={[{ id: 'e1', startAt: '2026-05-11T10:00:00.000Z' } as never]}
          onDateSelect={onDateSelect}
          onMonthChange={onMonthChange}
        />
      </>
    )

    expect(screen.getByTitle('Rows: 2')).toHaveTextContent('2')
    expect(screen.getByTitle('Total: 350')).toHaveTextContent('350')
    expect(screen.getByTitle(/work/)).toHaveTextContent('work')

    await user.click(screen.getByRole('button', { name: 'toolbar.previous-month' }))
    await user.click(screen.getByRole('button', { name: 'toolbar.next-month' }))
    expect(onMonthChange).toHaveBeenNthCalledWith(1, '2026-04-10')
    expect(onMonthChange).toHaveBeenNthCalledWith(2, '2026-06-10')

    await user.click(screen.getAllByRole('button', { name: '11' })[0])
    expect(onDateSelect).toHaveBeenCalledWith('2026-05-11')
  })

  it('drives row context menu single and bulk actions', async () => {
    const user = userEvent.setup()
    const onNoteOpen = vi.fn()
    const onOpenInNewTab = vi.fn()
    const onMoveToFolder = vi.fn()
    const onDelete = vi.fn()
    const note = {
      id: 'note-1',
      title: 'A note',
      folder: 'notes',
      tags: [],
      created: '2026-05-01',
      modified: '2026-05-02',
      wordCount: 12,
      properties: {}
    }

    const { rerender } = render(
      <RowContextMenu
        note={note}
        isPartOfSelection={false}
        selectedCount={1}
        selectedNoteIds={['note-1']}
        onNoteOpen={onNoteOpen}
        onOpenInNewTab={onOpenInNewTab}
        onMoveToFolder={onMoveToFolder}
        onDelete={onDelete}
      >
        <div>row</div>
      </RowContextMenu>
    )

    const menu = screen.getByTestId('context-menu-content')
    await user.click(within(menu).getByText('phaseF.componentsFolderViewRowContextMenu.open'))
    await user.click(within(menu).getByText('Open in New Tab'))
    await user.click(
      within(menu).getByText('phaseF.componentsFolderViewRowContextMenu.openInExternalEditor')
    )
    await user.click(within(menu).getByText('fileActions.revealInFinder'))
    await user.click(
      within(menu).getByText('phaseF.componentsFolderViewRowContextMenu.revealInSidebar')
    )
    await user.click(
      within(menu).getByRole('button', {
        name: /phaseF\.componentsFolderViewRowContextMenu\.copyLink/
      })
    )
    await user.click(within(menu).getByText('Move to Folder...'))
    await user.click(within(menu).getByText('phaseF.componentsFolderViewRowContextMenu.delete2'))

    expect(onNoteOpen).toHaveBeenCalledWith('note-1')
    expect(onOpenInNewTab).toHaveBeenCalledWith('note-1')
    expect(notesServiceMock.openExternal).toHaveBeenCalledWith('note-1')
    expect(notesServiceMock.revealInFinder).toHaveBeenCalledWith('note-1')
    expect(onMoveToFolder).toHaveBeenCalledWith(['note-1'])
    expect(onDelete).toHaveBeenCalledWith(['note-1'])

    rerender(
      <RowContextMenu
        note={note}
        isPartOfSelection
        selectedCount={3}
        selectedNoteIds={['note-1', 'note-2', 'note-3']}
        onMoveToFolder={onMoveToFolder}
        onDelete={onDelete}
      >
        <div>row</div>
      </RowContextMenu>
    )

    await user.click(screen.getByText(/Move 3 Notes/))
    await user.click(
      screen.getByRole('button', { name: /phaseF\.componentsFolderViewRowContextMenu\.delete3/ })
    )
    expect(onMoveToFolder).toHaveBeenCalledWith(['note-1', 'note-2', 'note-3'])
    expect(onDelete).toHaveBeenCalledWith(['note-1', 'note-2', 'note-3'])
  })
})
