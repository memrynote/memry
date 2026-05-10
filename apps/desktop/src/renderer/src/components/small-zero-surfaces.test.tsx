import { fireEvent, render, screen } from '@testing-library/react'
import { type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SavedFilter } from '@/data/tasks-data'
import { JournalHeaderActions } from './journal/journal-header-actions'
import { TriageSnoozePicker } from './inbox/triage-snooze-picker'
import { WikiLinkMenu, type WikiLinkSuggestionItem } from './note/content-area/wiki-link-menu'
import { WikiLinkPreviewCard } from './note/content-area/wiki-link-preview-card'
import { TabPane } from './split-view/tab-pane'
import { SavedFiltersDropdown } from './tasks/filters/saved-filters-dropdown'

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  tabGroup: null as null | {
    id: string
    activeTabId: string
    tabs: Array<Record<string, unknown>>
  },
  dayPanel: { isOpen: false, width: 0, isResizing: false }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key.split('.').at(-1) ?? key })
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: ({ checked }: { checked?: boolean }) => (
    <input readOnly type="checkbox" checked={checked} />
  )
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  )
}))

vi.mock('./journal/journal-reminder-button', () => ({
  JournalReminderButton: ({ journalDate }: { journalDate: string }) => (
    <button type="button">reminder:{journalDate}</button>
  )
}))

vi.mock('@/contexts/day-panel-context', () => ({
  useDayPanel: () => mocks.dayPanel
}))

vi.mock('@/contexts/tabs', () => ({
  useTabGroup: () => mocks.tabGroup,
  useTabs: () => ({ dispatch: mocks.dispatch })
}))

vi.mock('@/components/tabs', () => ({
  TabBarWithDrag: ({
    groupId,
    showSidebarToggle
  }: {
    groupId: string
    showSidebarToggle: boolean
  }) => <div>tabbar:{`${groupId}:${showSidebarToggle}`}</div>
}))

vi.mock('./split-view/empty-pane-state', () => ({
  EmptyPaneState: ({ groupId }: { groupId: string }) => <div>empty:{groupId}</div>
}))

vi.mock('./split-view/tab-content', () => ({
  TabContent: ({ groupId, tab }: { groupId: string; tab: { id: string } }) => (
    <div>content:{`${groupId}:${tab.id}`}</div>
  )
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.tabGroup = null
  mocks.dayPanel = { isOpen: false, width: 0, isResizing: false }
})

describe('small zero-line renderer surfaces', () => {
  it('renders tab panes, active content, empty groups, and inactive focus dispatch', () => {
    const { container, rerender } = render(<TabPane groupId="missing" isActive={false} />)
    expect(container).toBeEmptyDOMElement()

    mocks.tabGroup = {
      id: 'group-1',
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', title: 'Note' }]
    }
    mocks.dayPanel = { isOpen: true, width: 320, isResizing: false }
    rerender(<TabPane groupId="group-1" isActive={false} showSidebarToggle={false} />)
    fireEvent.click(screen.getByTestId('tab-pane'))

    expect(screen.getByText('tabbar:group-1:false')).toBeInTheDocument()
    expect(screen.getByText('content:group-1:tab-1')).toBeInTheDocument()
    expect(mocks.dispatch).toHaveBeenCalledWith({
      type: 'SET_ACTIVE_GROUP',
      payload: { groupId: 'group-1' }
    })

    mocks.tabGroup = { id: 'group-1', activeTabId: 'missing', tabs: [] }
    rerender(<TabPane groupId="group-1" isActive={true} />)
    expect(screen.getByText('empty:group-1')).toBeInTheDocument()
  })

  it('drives wiki-link menu loading, empty, note, and create rows', () => {
    const onItemClick = vi.fn()
    const items: WikiLinkSuggestionItem[] = [
      {
        id: 'note-1',
        title: 'Existing Note',
        target: 'Existing Note',
        exists: true,
        type: 'note',
        lastEdited: '2026-05-10T00:00:00.000Z'
      },
      {
        id: 'create-1',
        title: 'New Note',
        target: 'New Note',
        exists: false,
        type: 'create'
      }
    ]

    const { rerender } = render(
      <WikiLinkMenu items={[]} loadingState="loading" selectedIndex={0} onItemClick={onItemClick} />
    )
    expect(screen.getByText('loading')).toBeInTheDocument()

    rerender(
      <WikiLinkMenu items={[]} loadingState="loaded" selectedIndex={0} onItemClick={onItemClick} />
    )
    expect(screen.getByText('empty')).toBeInTheDocument()

    rerender(
      <WikiLinkMenu
        items={items}
        loadingState="loaded"
        selectedIndex={1}
        onItemClick={onItemClick}
      />
    )
    fireEvent.click(screen.getByText('Existing Note'))
    fireEvent.click(screen.getByText('create'))

    expect(onItemClick).toHaveBeenCalledWith(items[0])
    expect(onItemClick).toHaveBeenCalledWith(items[1])
  })

  it('renders wiki-link previews and forwards note, tag, and hover events', () => {
    const onMouseEnter = vi.fn()
    const onMouseLeave = vi.fn()
    const onNoteClick = vi.fn()
    const onTagClick = vi.fn()

    render(
      <WikiLinkPreviewCard
        preview={{
          id: 'note-1',
          title: 'Previewed',
          snippet: 'Snippet',
          createdAt: '2026-05-10T00:00:00.000Z',
          emoji: null,
          tags: [{ name: 'work', color: '#22c55e' }]
        }}
        position={{ top: 10, left: 20, placement: 'above' }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onNoteClick={onNoteClick}
        onTagClick={onTagClick}
      />
    )

    const preview = document.querySelector('[data-wiki-link-preview]') as HTMLElement
    fireEvent.mouseEnter(preview)
    fireEvent.mouseLeave(preview)
    fireEvent.click(screen.getByText('Previewed'))
    fireEvent.click(screen.getByText('work'))

    expect(onMouseEnter).toHaveBeenCalled()
    expect(onMouseLeave).toHaveBeenCalled()
    expect(onNoteClick).toHaveBeenCalledWith('Previewed')
    expect(onTagClick).toHaveBeenCalledWith('work', '#22c55e')
  })

  it('drives triage snooze presets and cancel', () => {
    const onSelect = vi.fn()
    const onCancel = vi.fn()

    render(<TriageSnoozePicker onSelect={onSelect} onCancel={onCancel} />)
    fireEvent.click(screen.getAllByRole('button')[0])
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }))

    expect(onSelect).toHaveBeenCalledWith(expect.stringMatching(/T/))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('drives journal header month navigation and entry actions', () => {
    const handlers = {
      onPrevious: vi.fn(),
      onNext: vi.fn(),
      onToggleFullWidth: vi.fn(),
      onBookmarkToggle: vi.fn(),
      onVersionHistory: vi.fn(),
      onExport: vi.fn(),
      onOpenSettings: vi.fn()
    }

    const { rerender } = render(
      <JournalHeaderActions
        viewState={{ type: 'month', month: 4, year: 2026 }}
        isBookmarked={false}
        isFullWidth={false}
        hasEntry={false}
        journalDate={null}
        {...handlers}
      />
    )

    fireEvent.click(screen.getByLabelText('previousMonth'))
    fireEvent.click(screen.getByLabelText('nextMonth'))
    expect(handlers.onPrevious).toHaveBeenCalledTimes(1)
    expect(handlers.onNext).toHaveBeenCalledTimes(1)

    rerender(
      <JournalHeaderActions
        viewState={{ type: 'day', date: '2026-05-10' }}
        isBookmarked={true}
        isFullWidth={true}
        hasEntry={true}
        journalDate="2026-05-10"
        {...handlers}
      />
    )

    fireEvent.click(screen.getByTitle('removeBookmark'))
    fireEvent.click(screen.getByRole('button', { name: /versionHistory/ }))
    fireEvent.click(screen.getByRole('button', { name: /export/ }))
    fireEvent.click(screen.getByRole('button', { name: /fullWidth/ }))
    fireEvent.click(screen.getByRole('button', { name: /journalSettings/ }))

    expect(screen.getByText('reminder:2026-05-10')).toBeInTheDocument()
    expect(handlers.onBookmarkToggle).toHaveBeenCalledTimes(1)
    expect(handlers.onVersionHistory).toHaveBeenCalledTimes(1)
    expect(handlers.onExport).toHaveBeenCalledTimes(1)
    expect(handlers.onToggleFullWidth).toHaveBeenCalledTimes(1)
    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('applies, deletes, saves, and renders empty saved-filter states', () => {
    const onApply = vi.fn()
    const onDelete = vi.fn()
    const onSaveCurrent = vi.fn()
    const filter: SavedFilter = {
      id: 'filter-1',
      name: 'High priority',
      filters: {} as SavedFilter['filters'],
      starred: true,
      createdAt: new Date('2026-05-10T00:00:00.000Z')
    }

    const { rerender } = render(
      <SavedFiltersDropdown
        savedFilters={[filter]}
        onApply={onApply}
        onDelete={onDelete}
        onSaveCurrent={onSaveCurrent}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'High priority' }))
    fireEvent.click(screen.getByLabelText('Delete High priority'))
    fireEvent.click(screen.getByRole('button', { name: /saveCurrentFilters/ }))

    expect(onApply).toHaveBeenCalledWith(filter)
    expect(onDelete).toHaveBeenCalledWith('filter-1')
    expect(onSaveCurrent).toHaveBeenCalledTimes(1)

    rerender(<SavedFiltersDropdown savedFilters={[]} onApply={onApply} onDelete={onDelete} />)
    expect(screen.getByText('noSavedFiltersYet')).toBeInTheDocument()
    expect(screen.getByText('saveCurrentFilters2')).toBeInTheDocument()
  })
})
