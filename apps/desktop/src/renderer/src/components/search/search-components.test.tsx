import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '@/components/search/command-palette'
import { SearchFilters } from '@/components/search/search-filters'
import { SearchResultGroup } from '@/components/search/search-result-group'
import { SearchResultItem } from '@/components/search/search-result-item'
import { searchService } from '@/services/search-service'
import { localDayRange } from '@/lib/local-day-range'

const openTab = vi.fn()
const setQuery = vi.fn()
const setFilters = vi.fn()
const loadReasons = vi.fn()
const clearReasons = vi.fn()
const reset = vi.fn()

let searchState = {
  query: 'road',
  results: [] as any[],
  totalCount: 0,
  loading: false,
  error: null as string | null,
  filters: { types: [] as string[], tags: [] as string[], dateRange: null },
  reasons: [] as any[]
}

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('cmdk', () => {
  const CommandRoot = ({ children }: { children: React.ReactNode }) => <div>{children}</div>
  return {
    Command: Object.assign(CommandRoot, {
      Dialog: ({
        open,
        children,
        onOpenChange
      }: {
        open: boolean
        children: React.ReactNode
        onOpenChange?: (open: boolean) => void
      }) =>
        open ? (
          <div role="dialog">
            <button onClick={() => onOpenChange?.(false)}>close-dialog</button>
            {children}
          </div>
        ) : null,
      Input: ({
        value,
        onValueChange,
        placeholder
      }: {
        value: string
        onValueChange: (value: string) => void
        placeholder?: string
      }) => (
        <input
          aria-label="search"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onValueChange(event.target.value)}
        />
      ),
      List: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Empty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Group: ({ children, heading }: { children: React.ReactNode; heading?: React.ReactNode }) => (
        <div cmdk-group="">
          {heading}
          {children}
        </div>
      ),
      Item: ({
        children,
        onSelect,
        value
      }: {
        children: React.ReactNode
        onSelect?: () => void
        value?: string
      }) => (
        <button cmdk-item="" data-selected="true" onClick={onSelect}>
          {value}
          {children}
        </button>
      )
    })
  }
})

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab })
}))

vi.mock('@/hooks/use-search', () => ({
  useSearch: () => ({
    ...searchState,
    setQuery,
    setFilters,
    loadReasons,
    clearReasons,
    reset
  })
}))

vi.mock('@/services/search-service', async () => {
  const actual = await vi.importActual<typeof import('@/services/search-service')>(
    '@/services/search-service'
  )
  return {
    ...actual,
    searchService: {
      getAllTags: vi.fn(),
      addReason: vi.fn()
    }
  }
})

vi.mock('@/lib/render-note-icon', () => ({
  NoteIconDisplay: ({ value }: { value: string }) => <span>{value}</span>
}))

const item = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'item-1',
    type: 'note',
    title: 'Roadmap note',
    snippet: 'Build the roadmap',
    score: 1,
    matchType: 'exact',
    metadata: {
      type: 'note',
      path: 'notes/Roadmap.md',
      tags: ['work', 'planning'],
      emoji: '🗺️'
    },
    ...overrides
  }) as any

describe('search components coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchState = {
      query: 'road',
      results: [],
      totalCount: 0,
      loading: false,
      error: null,
      filters: { types: [], tags: [], dateRange: null },
      reasons: []
    }
  })

  it('renders result item metadata variants and selects items', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<SearchResultItem item={item()} query="road" onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /note-item-1/i }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-1' }))
    expect(screen.getByText('work, planning')).toBeInTheDocument()

    rerender(
      <SearchResultItem
        item={item({
          id: 'journal-1',
          type: 'journal',
          title: 'Daily journal',
          metadata: { type: 'journal', date: '2026-05-10', tags: ['daily'] }
        })}
        query="daily"
        onSelect={onSelect}
      />
    )
    expect(screen.getByText('2026-05-10')).toBeInTheDocument()

    rerender(
      <SearchResultItem
        item={item({
          id: 'task-1',
          type: 'task',
          title: 'Ship search',
          matchType: 'fuzzy',
          metadata: {
            type: 'task',
            projectId: 'project-1',
            projectName: 'Launch',
            projectColor: '#f00',
            dueDate: '2026-05-11',
            priority: 3,
            statusName: 'Doing'
          }
        })}
        query="ship"
        onSelect={onSelect}
      />
    )
    expect(screen.getByText('Launch')).toBeInTheDocument()
    expect(screen.getByText('phaseF.componentsSearchSearchResultItem.fuzzy')).toBeInTheDocument()

    rerender(
      <SearchResultItem
        item={item({
          id: 'inbox-1',
          type: 'inbox',
          title: 'Captured link',
          metadata: {
            type: 'inbox',
            itemType: 'link',
            sourceUrl: 'https://example.com',
            sourceTitle: 'Example'
          }
        })}
        query="link"
        onSelect={onSelect}
      />
    )
    expect(screen.getByText('Example')).toBeInTheDocument()
  })

  it('expands grouped results', () => {
    const onSelect = vi.fn()
    render(
      <SearchResultGroup
        query="road"
        onSelect={onSelect}
        initialLimit={1}
        group={{
          type: 'note',
          totalInGroup: 2,
          results: [item({ id: 'one', title: 'One' }), item({ id: 'two', title: 'Two' })]
        }}
      />
    )

    expect(screen.getByText('One')).toBeInTheDocument()
    expect(screen.queryByText('Two')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /viewAll/ }))
    expect(screen.getByText('Two')).toBeInTheDocument()
  })

  it('toggles filters, loads tags, selects presets, and clears', async () => {
    vi.mocked(searchService.getAllTags).mockResolvedValue(['work', 'home', 'roadmap'])
    const onToggleType = vi.fn()
    const onToggleTag = vi.fn()
    const onSetDateRange = vi.fn()
    const onClear = vi.fn()

    render(
      <SearchFilters
        activeTypes={['note']}
        activeTags={['work']}
        activeDateRange={{ from: 'x', to: 'y' }}
        onToggleType={onToggleType}
        onToggleTag={onToggleTag}
        onSetDateRange={onSetDateRange}
        onClear={onClear}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Tasks/ }))
    fireEvent.click(screen.getByRole('button', { name: /clear/ }))
    fireEvent.click(screen.getAllByRole('button').find((button) => button.textContent === '')!)
    await waitFor(() => expect(searchService.getAllTags).toHaveBeenCalled())

    fireEvent.change(
      screen.getByPlaceholderText('phaseF.componentsSearchSearchFilters.filterByTag'),
      {
        target: { value: 'road' }
      }
    )
    fireEvent.click(screen.getByRole('button', { name: 'roadmap' }))
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))
    fireEvent.click(
      screen
        .getAllByRole('button')
        .find((button) => button.querySelector('svg') && !button.textContent)!
    )

    expect(onToggleType).toHaveBeenCalledWith('task')
    expect(onToggleTag).toHaveBeenCalledWith('roadmap')
    expect(onSetDateRange).toHaveBeenCalled()
    expect(onClear).toHaveBeenCalled()
  })

  // The presets used to name the UTC date and cover the UTC day, so in a westerly zone "Today"
  // meant tomorrow and excluded the whole local evening (#1954).
  it('scopes the Today preset to the local day, not the UTC one', () => {
    const onSetDateRange = vi.fn()
    render(
      <SearchFilters
        activeTypes={[]}
        activeTags={[]}
        activeDateRange={null}
        onToggleType={vi.fn()}
        onToggleTag={vi.fn()}
        onSetDateRange={onSetDateRange}
        onClear={vi.fn()}
      />
    )
    fireEvent.click(screen.getAllByRole('button').find((b) => b.textContent === '')!)
    fireEvent.click(screen.getByRole('button', { name: 'Today' }))

    const now = new Date()
    const { startAt, endAt } = localDayRange(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    )
    // `search.ts` filters with an inclusive `to`, so the preset stops a millisecond short of the
    // next local midnight rather than reaching it.
    expect(onSetDateRange).toHaveBeenCalledWith({
      from: startAt,
      to: new Date(Date.parse(endAt) - 1).toISOString()
    })
  })

  it('opens command palette results and recent reasons', async () => {
    vi.mocked(searchService.addReason).mockResolvedValue(undefined)
    searchState = {
      ...searchState,
      query: 'road',
      totalCount: 1,
      results: [{ type: 'note', totalInGroup: 1, results: [item()] }]
    }
    const onOpenChange = vi.fn()

    const { rerender } = render(<CommandPalette open onOpenChange={onOpenChange} />)
    expect(loadReasons).toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: 'search' }), {
      target: { value: 'next' }
    })
    fireEvent.click(screen.getByRole('button', { name: /Roadmap note/ }))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'item-1' })
    )
    await waitFor(() => expect(searchService.addReason).toHaveBeenCalled())

    searchState = {
      ...searchState,
      query: '',
      results: [],
      reasons: [
        {
          id: 'reason-1',
          itemId: 'task-1',
          itemType: 'task',
          itemTitle: 'Recent task',
          itemIcon: null,
          searchQuery: 'task'
        }
      ]
    }
    rerender(<CommandPalette open onOpenChange={onOpenChange} />)
    fireEvent.keyDown(window, { key: '1', ctrlKey: true })
    expect(setFilters).toHaveBeenCalledWith(expect.objectContaining({ types: ['note'] }))
    fireEvent.click(screen.getByRole('button', { name: 'close-dialog' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
