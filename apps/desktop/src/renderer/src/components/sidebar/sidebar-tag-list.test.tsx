import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState, type ReactNode } from 'react'

import { SidebarTagList } from './sidebar-tag-list'

const mocks = vi.hoisted(() => ({
  query: {
    tags: [] as Array<{ tag: string; count: number; color: string }>,
    isLoading: false,
    error: null as Error | null
  }
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
  useSidebarNavigation: () => ({ openSidebarItem: vi.fn() })
}))

vi.mock('@/components/ui/picker', () => {
  const Picker = ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <div>
      {children}
      <select
        aria-label="sort tags"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        <option value="count-desc">count-desc</option>
        <option value="count-asc">count-asc</option>
        <option value="alpha-asc">alpha-asc</option>
        <option value="alpha-desc">alpha-desc</option>
      </select>
    </div>
  )
  Picker.Trigger = ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  )
  Picker.Content = ({ children }: { children: ReactNode }) => <div>{children}</div>
  Picker.List = ({ children }: { children: ReactNode }) => <div>{children}</div>
  Picker.Item = ({ label }: { label: string }) => <span>{label}</span>
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

describe('SidebarTagList', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.query.tags = []
    mocks.query.isLoading = false
    mocks.query.error = null
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
    const onTagClick = vi.fn()
    mocks.query.tags = [
      { tag: 'work', count: 5, color: 'blue' },
      { tag: 'work/project', count: 3, color: 'green' },
      { tag: 'alpha', count: 2, color: 'red' },
      { tag: 'later', count: 1, color: 'yellow' },
      { tag: 'unused', count: 0, color: 'stone' }
    ]

    renderWithActions({ maxVisible: 1, selectedTag: 'alpha', onTagClick })

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
    expect(onTagClick).toHaveBeenCalledWith('alpha', 'red')

    fireEvent.change(screen.getByLabelText('sort tags'), { target: { value: 'alpha-asc' } })
    expect(localStorage.getItem('sidebar-tags-sort')).toBe('alpha-asc')

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
})
