import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContext, useContext, useState, type ReactNode } from 'react'

import { SidebarTagList } from './sidebar-tag-list'

/**
 * The section's sort mode moved off per-device localStorage onto the synced
 * settings channel, so these tests drive that channel instead. `storedModes`
 * stands in for what the vault holds; asserting against it is asserting that
 * the choice was persisted where another device can see it.
 */
const storedModes: Record<string, string> = {}

beforeEach(() => {
  for (const key of Object.keys(storedModes)) delete storedModes[key]
  ;(window as unknown as { api: unknown }).api = {
    settings: {
      getSidebarSortModes: async () => ({ ...storedModes }),
      setSidebarSortMode: async (surface: string, mode: string) => {
        storedModes[surface] = mode
        return { success: true }
      }
    },
    onSettingsChanged: () => () => {}
  }
})

const mocks = vi.hoisted(() => ({
  query: {
    tags: [] as Array<{
      tag: string
      count: number
      color: string
      categoryId?: string | null
      sortOrder?: number
    }>,
    isLoading: false,
    error: null as Error | null
  },
  categoryRows: [] as Array<{ id: string; name: string; sortOrder: number }>,
  openSidebarItem: vi.fn()
}))

// The row-level middle-click / preference hooks reach useTabActions, which
// these renders have no TabProvider for — stub the whole open-target module.
vi.mock('@/hooks/use-open-target', () => ({
  useOpenTarget: () => ({ openInNewTab: vi.fn(), openToTheSide: vi.fn() }),
  useOpenPage: () => ({ openPage: vi.fn(), reuseActiveTab: false })
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      String(params?.count ?? key.split('.').at(-1) ?? key)
  })
}))

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => mocks.query
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: mocks.openSidebarItem })
}))

// Mirrors the real useTagCategories' bucketing (tag.categoryId -> category,
// falling back to Uncategorized) so tests can drive grouping purely through
// mocks.query.tags + mocks.categoryRows.
vi.mock('@/hooks/use-tag-categories', () => ({
  useTagCategories: () => {
    const categoryById = new Map(mocks.categoryRows.map((c) => [c.id, c] as const))
    const buckets = new Map<string, typeof mocks.query.tags>()
    const uncategorized: typeof mocks.query.tags = []

    for (const tag of mocks.query.tags) {
      if (tag.categoryId && categoryById.has(tag.categoryId)) {
        const bucket = buckets.get(tag.categoryId)
        if (bucket) bucket.push(tag)
        else buckets.set(tag.categoryId, [tag])
      } else {
        uncategorized.push(tag)
      }
    }

    const sortTags = (tags: typeof mocks.query.tags) =>
      [...tags].sort(
        (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.tag.localeCompare(b.tag)
      )

    const toHubTag = (t: (typeof mocks.query.tags)[number]) => ({
      tag: t.tag,
      color: t.color,
      icon: null,
      count: t.count,
      sortOrder: t.sortOrder ?? 0
    })

    const categories = mocks.categoryRows
      .map((row) => ({
        id: row.id,
        name: row.name,
        sortOrder: row.sortOrder,
        tags: sortTags(buckets.get(row.id) ?? []).map(toHubTag)
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder)

    return {
      categories,
      uncategorized: sortTags(uncategorized).map(toHubTag),
      isLoading: false,
      error: null,
      createCategory: vi.fn(),
      renameCategory: vi.fn(),
      deleteCategory: vi.fn(),
      createTag: vi.fn(),
      reorder: vi.fn()
    }
  }
}))

// A minimal, faithful-enough stand-in for the real Picker: Root tracks open
// state + value in context, Trigger toggles it and forwards its aria-label,
// Content only renders while open, and Item is a role="option" button that
// commits the value (mirrors the real PickerItem's role/behavior).
vi.mock('@/components/ui/picker', () => {
  interface PickerCtx {
    open: boolean
    setOpen: (open: boolean) => void
    value: string
    onValueChange: (value: string) => void
  }

  const PickerContext = createContext<PickerCtx | null>(null)

  function usePickerCtx(): PickerCtx {
    const ctx = useContext(PickerContext)
    if (!ctx) throw new Error('Picker.* must be rendered within Picker')
    return ctx
  }

  const Picker = ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => {
    const [open, setOpen] = useState(false)
    return (
      <PickerContext.Provider value={{ open, setOpen, value, onValueChange }}>
        {children}
      </PickerContext.Provider>
    )
  }

  // Spreads the rest, like the real PickerTrigger: callers identify the control
  // by `data-testid`/`data-sort-mode`, and a stand-in that swallowed them would
  // make those hooks look broken here while working in the app.
  Picker.Trigger = ({
    children,
    'aria-label': ariaLabel,
    variant: _variant,
    className: _className,
    ...rest
  }: {
    children: ReactNode
    'aria-label'?: string
    variant?: string
    className?: string
  } & Record<string, unknown>) => {
    const { open, setOpen } = usePickerCtx()
    return (
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        {...rest}
      >
        {children}
      </button>
    )
  }

  Picker.Content = ({ children }: { children: ReactNode }) => {
    const { open } = usePickerCtx()
    return open ? <div>{children}</div> : null
  }

  Picker.List = ({ children }: { children: ReactNode }) => <div>{children}</div>

  Picker.Item = ({ value, label }: { value: string; label: string }) => {
    const { onValueChange, setOpen } = usePickerCtx()
    return (
      <button
        type="button"
        role="option"
        onClick={() => {
          onValueChange(value)
          setOpen(false)
        }}
      >
        {label}
      </button>
    )
  }

  return { Picker }
})

function renderWithActions(props: Partial<React.ComponentProps<typeof SidebarTagList>> = {}) {
  function Harness() {
    const [actions, setActions] = useState<ReactNode>(null)
    return (
      <>
        <div data-testid="tag-actions">{actions}</div>
        <SidebarTagList onActionsReady={setActions} {...props} />
      </>
    )
  }

  return render(<Harness />)
}

// Default fixture for the grouping tests: a "Work" category with two tags
// (out of manual order, so switching sort is observable) plus one
// uncategorized tag, so both a named category heading and the Uncategorized
// heading render.
function renderSidebarTagList(props: Partial<React.ComponentProps<typeof SidebarTagList>> = {}) {
  mocks.query.tags = [
    { tag: 'meetings', count: 4, color: 'blue', categoryId: 'work', sortOrder: 1 },
    { tag: 'okr', count: 2, color: 'green', categoryId: 'work', sortOrder: 0 },
    { tag: 'inbox', count: 3, color: 'red', categoryId: null, sortOrder: 0 }
  ]
  mocks.categoryRows = [{ id: 'work', name: 'Work', sortOrder: 0 }]
  return renderWithActions(props)
}

describe('SidebarTagList', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.query.tags = []
    mocks.query.isLoading = false
    mocks.query.error = null
    mocks.categoryRows = []
    mocks.openSidebarItem.mockClear()
  })

  it('renders loading, error, and empty states', () => {
    mocks.query.isLoading = true
    const loading = render(<SidebarTagList />)
    expect(screen.getByText('loadingTags')).toBeInTheDocument()

    loading.unmount()
    mocks.query.isLoading = false
    mocks.query.error = new Error('no tags')
    const failed = render(<SidebarTagList />)
    expect(screen.getByText('failedToLoadTags')).toBeInTheDocument()

    failed.unmount()
    mocks.query.error = null
    render(<SidebarTagList />)
    expect(screen.getByText('noTagsYet')).toBeInTheDocument()
  })

  it('filters, sorts, expands, selects, and persists tag tree state', async () => {
    // This test exercises count-based show-more/expand mechanics, which need
    // a count-ordered tree; 'manual' (now the default) would order these
    // untagged-sortOrder fixtures alphabetically instead. Pin the sort
    // explicitly rather than depending on whatever the default happens to be.
    storedModes.tags = 'count-desc'
    mocks.query.tags = [
      { tag: 'work', count: 5, color: 'blue' },
      { tag: 'work/project', count: 3, color: 'green' },
      { tag: 'alpha', count: 2, color: 'red' },
      { tag: 'later', count: 1, color: 'yellow' },
      { tag: 'unused', count: 0, color: 'stone' }
    ]

    renderWithActions({ maxVisible: 1 })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Search tags' })).toBeInTheDocument()
    })

    expect(screen.getByTitle('work (8)')).toBeInTheDocument()
    expect(screen.queryByTitle('alpha (2)')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '2' }))
    expect(screen.getByTitle('alpha (2)')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'expand' }))
    expect(screen.getByTitle('work/project (3)')).toBeInTheDocument()
    expect(localStorage.getItem('sidebar-tags-expanded')).toContain('work')

    fireEvent.click(screen.getByTitle('alpha (2)'))
    expect(mocks.openSidebarItem).toHaveBeenCalledWith({
      type: 'tag',
      title: 'alpha',
      path: '/tags/alpha',
      entityId: 'alpha',
      color: 'red'
    })

    fireEvent.click(screen.getByTestId('sidebar-sort-tags'))
    fireEvent.click(screen.getByRole('option', { name: 'sortModeNameAsc' }))
    await waitFor(() => expect(storedModes.tags).toBe('name-asc'))

    fireEvent.click(screen.getByRole('button', { name: 'Search tags' }))
    const input = screen.getByPlaceholderText('filterTags')
    fireEvent.change(input, { target: { value: 'project' } })
    expect(screen.getByTitle('work/project (3)')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'missing' } })
    expect(screen.getByText('noMatchingTags')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByPlaceholderText('filterTags')).not.toBeInTheDocument()
  })

  it('fades the tag label only when its text overflows the available width', () => {
    mocks.query.tags = [{ tag: 'travel', count: 42, color: 'red' }]

    // jsdom default: scrollWidth === clientWidth === 0 → text fits → no fade mask
    const fits = render(<SidebarTagList />)
    expect(screen.getByText('travel').className).not.toContain('sidebar-label-fade-mask')
    fits.unmount()

    // scrollWidth > clientWidth → text overflows → fade mask applied
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    const client = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get: () => 100
    })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 40
    })
    try {
      render(<SidebarTagList />)
      expect(screen.getByText('travel').className).toContain('sidebar-label-fade-mask')
    } finally {
      if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scroll)
      if (client) Object.defineProperty(HTMLElement.prototype, 'clientWidth', client)
    }
  })

  it('groups tags under their category heading', () => {
    renderSidebarTagList()
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByText('Uncategorized')).toBeInTheDocument()
  })

  it('opens a tag tab instead of a drill-down', async () => {
    renderSidebarTagList()

    await userEvent.click(screen.getByRole('button', { name: /meetings/ }))

    expect(mocks.openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tag', entityId: 'meetings' })
    )
  })

  it('defaults to manual sort', async () => {
    renderSidebarTagList()
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-sort-tags')).toHaveAttribute('data-sort-mode', 'manual')
    })
  })

  it('carries an older per-device preference over to the synced setting once', async () => {
    localStorage.setItem('sidebar-tags-sort', 'alpha-desc')
    renderSidebarTagList()
    await waitFor(() => expect(storedModes.tags).toBe('name-desc'))
    // The legacy key survives: downgrading to a build that still reads it must
    // not find the preference gone.
    expect(localStorage.getItem('sidebar-tags-sort')).toBe('alpha-desc')
  })

  it('lets a mode already synced from another device beat the legacy key', async () => {
    localStorage.setItem('sidebar-tags-sort', 'alpha-desc')
    storedModes.tags = 'count-desc'
    renderSidebarTagList()
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-sort-tags')).toHaveAttribute(
        'data-sort-mode',
        'count-desc'
      )
    })
    expect(storedModes.tags).toBe('count-desc')
  })

  it('keeps the existing sort options working inside each category', async () => {
    renderSidebarTagList()
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-sort-tags')).toBeInTheDocument()
    })
    await userEvent.click(screen.getByTestId('sidebar-sort-tags'))
    await userEvent.click(screen.getByRole('option', { name: 'sortModeNameAsc' }))

    const work = within(screen.getByTestId('tag-group-work'))
    expect(work.getAllByRole('button').map((b) => b.textContent)).toEqual(['meetings', 'okr'])
  })
})
