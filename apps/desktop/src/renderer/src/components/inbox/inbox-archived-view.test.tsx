import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { InboxArchivedView } from './inbox-archived-view'

const mocks = vi.hoisted(() => ({
  archivedState: {
    items: [] as any[],
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    loadMore: vi.fn()
  },
  detailState: {
    item: null as any,
    isLoading: false
  },
  unarchive: {
    mutate: vi.fn(),
    isPending: false,
    variables: null as string | null
  },
  deletePermanent: {
    mutate: vi.fn(),
    isPending: false,
    variables: null as string | null
  }
}))

vi.mock('@/hooks/use-inbox', () => ({
  useInboxArchived: vi.fn(() => mocks.archivedState),
  useInboxItem: vi.fn(() => mocks.detailState),
  useUnarchiveInboxItem: vi.fn(() => mocks.unarchive),
  useDeletePermanentInboxItem: vi.fn(() => mocks.deletePermanent)
}))

vi.mock('@/components/inbox', () => ({
  InboxListSection: ({
    title,
    count,
    children
  }: {
    title: string
    count: number
    children: React.ReactNode
  }) => (
    <section aria-label={title}>
      <h2>
        {title} {count}
      </h2>
      {children}
    </section>
  ),
  ListTypeIcon: ({ type }: { type: string }) => <span data-testid={`type-${type}`} />
}))

vi.mock('@/components/inbox-detail', () => ({
  InboxDetailPanel: ({
    isOpen,
    item,
    onClose,
    onRestore,
    onDelete
  }: {
    isOpen: boolean
    item: { id: string; title: string } | null
    onClose: () => void
    onRestore: (id: string) => void
    onDelete: (id: string) => void
  }) =>
    isOpen ? (
      <aside aria-label="detail panel">
        <span>{item?.title}</span>
        <button type="button" onClick={onClose}>
          close detail
        </button>
        <button type="button" onClick={() => item && onRestore(item.id)}>
          restore detail
        </button>
        <button type="button" onClick={() => item && onDelete(item.id)}>
          delete detail
        </button>
      </aside>
    ) : null
}))

const makeItem = (id: string, title: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: 'link',
  title,
  content: null,
  rawContent: null,
  sourceUrl: 'https://example.com/article',
  createdAt: new Date('2026-05-01T10:00:00.000Z'),
  archivedAt: new Date('2026-05-10T10:00:00.000Z'),
  status: 'archived',
  viewedAt: null,
  snoozedUntil: null,
  metadata: null,
  attachments: [],
  ...overrides
})

describe('InboxArchivedView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.archivedState.items = []
    mocks.archivedState.hasMore = false
    mocks.archivedState.isLoading = false
    mocks.archivedState.isLoadingMore = false
    mocks.archivedState.loadMore = vi.fn()
    mocks.detailState.item = null
    mocks.detailState.isLoading = false
    mocks.unarchive.mutate = vi.fn()
    mocks.unarchive.isPending = false
    mocks.unarchive.variables = null
    mocks.deletePermanent.mutate = vi.fn()
    mocks.deletePermanent.isPending = false
    mocks.deletePermanent.variables = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders loading and empty archived states', () => {
    mocks.archivedState.isLoading = true
    const { rerender } = render(<InboxArchivedView />)
    expect(document.querySelector('.animate-spin')).toBeInTheDocument()

    mocks.archivedState.isLoading = false
    rerender(<InboxArchivedView />)
    expect(screen.getByText(/archived/i)).toBeInTheDocument()

    rerender(<InboxArchivedView searchQuery="missing" />)
    act(() => vi.advanceTimersByTime(250))
    expect(screen.getByText(/matching archived/i)).toBeInTheDocument()
  })

  it('groups archived items, opens detail, restores, deletes, and toggles preview', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    mocks.archivedState.items = [
      makeItem('older', 'Older item', { archivedAt: new Date('2026-04-01T10:00:00.000Z') }),
      makeItem('newer', 'Newer item', { archivedAt: new Date('2026-05-10T10:00:00.000Z') })
    ]
    mocks.detailState.item = makeItem('newer', 'Loaded detail')

    render(<InboxArchivedView searchQuery="new" />)
    act(() => vi.advanceTimersByTime(250))

    const listItems = screen.getAllByRole('listitem')
    expect(within(listItems[0]).getByText('Newer item')).toBeInTheDocument()
    expect(within(listItems[0]).getByText('example.com')).toBeInTheDocument()

    await user.click(listItems[0])
    expect(screen.getByLabelText('detail panel')).toHaveTextContent('Loaded detail')
    await user.click(listItems[0])
    expect(screen.queryByLabelText('detail panel')).not.toBeInTheDocument()
    await user.click(listItems[0])

    await user.click(within(listItems[0]).getByRole('button', { name: /restore to inbox/i }))
    expect(mocks.unarchive.mutate).toHaveBeenCalledWith('newer')
    expect(screen.queryByLabelText('detail panel')).not.toBeInTheDocument()

    await user.click(listItems[1])
    await user.click(within(listItems[1]).getByRole('button', { name: /delete permanently/i }))
    expect(mocks.deletePermanent.mutate).toHaveBeenCalledWith('older')
  })

  it('loads more when the sentinel intersects', () => {
    let observerCallback: IntersectionObserverCallback | undefined
    const observe = vi.fn()
    const unobserve = vi.fn()
    vi.spyOn(globalThis, 'IntersectionObserver').mockImplementation(
      function TestIntersectionObserver(callback: IntersectionObserverCallback) {
        observerCallback = callback
        return { observe, unobserve, disconnect: vi.fn() } as unknown as IntersectionObserver
      } as unknown as typeof IntersectionObserver
    )
    mocks.archivedState.items = [makeItem('one', 'One')]
    mocks.archivedState.hasMore = true

    const { unmount } = render(<InboxArchivedView />)

    expect(observe).toHaveBeenCalled()
    act(() => {
      observerCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
    expect(mocks.archivedState.loadMore).toHaveBeenCalledTimes(1)

    unmount()
    expect(unobserve).toHaveBeenCalled()
  })
})
