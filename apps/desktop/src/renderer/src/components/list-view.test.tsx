import type React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ListView } from './list-view'
import type { InboxItemListItem, InboxItemType } from '@/types'

const mocks = vi.hoisted(() => ({
  retryTranscription: vi.fn(),
  updateInboxItem: vi.fn(),
  inputFocused: false,
  windowOpen: vi.fn()
}))

vi.mock('@/hooks/use-inbox', () => ({
  useRetryTranscription: () => ({ mutate: mocks.retryTranscription }),
  useUpdateInboxItem: () => ({ mutate: mocks.updateInboxItem })
}))

vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  isInputFocused: () => mocks.inputFocused
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
      <h2>{title}</h2>
      <span>{count}</span>
      {children}
    </section>
  ),
  InboxListItem: ({
    item,
    isQuickFileActive,
    quickFileQuery,
    quickFileHighlightedIndex,
    folders,
    isExiting,
    period,
    onPreview,
    onArchive,
    onSnooze,
    onQuickFileQueryChange,
    onQuickFileSubmit,
    onQuickFileCancel,
    onQuickFileArrowDown,
    onQuickFileArrowUp,
    onQuickFileFolderSelect,
    onRetryTranscription
  }: {
    item: InboxItemListItem
    isQuickFileActive: boolean
    quickFileQuery: string
    quickFileHighlightedIndex: number
    folders: Array<{ id: string; name: string }>
    isExiting: boolean
    period: string
    onPreview: (id: string) => void
    onArchive: (id: string) => void
    onSnooze?: (id: string, snoozeUntil: string) => void
    onQuickFileQueryChange: (query: string) => void
    onQuickFileSubmit: () => void
    onQuickFileCancel: () => void
    onQuickFileArrowDown: () => void
    onQuickFileArrowUp: () => void
    onQuickFileFolderSelect: (folder: { id: string; name: string }) => void
    onRetryTranscription: (id: string) => void
  }) => (
    <div data-item-id={item.id}>
      <span>
        {period} {isExiting ? 'exiting' : 'stable'}
      </span>
      <button type="button" onClick={() => onPreview(item.id)}>
        {item.title}
      </button>
      <button type="button" onClick={() => onArchive(item.id)}>
        archive {item.id}
      </button>
      <button type="button" onClick={() => onSnooze?.(item.id, '2026-05-11T10:00:00.000Z')}>
        snooze {item.id}
      </button>
      <button type="button" onClick={() => onRetryTranscription(item.id)}>
        retry {item.id}
      </button>
      {isQuickFileActive && (
        <div>
          <span>quick file {item.id}</span>
          <input
            aria-label={`quick query ${item.id}`}
            value={quickFileQuery}
            onChange={(event) => onQuickFileQueryChange(event.target.value)}
          />
          <span>folders {folders.length}</span>
          <span>highlight {quickFileHighlightedIndex}</span>
          <button type="button" onClick={onQuickFileArrowDown}>
            next folder
          </button>
          <button type="button" onClick={onQuickFileArrowUp}>
            previous folder
          </button>
          <button type="button" onClick={() => onQuickFileFolderSelect(folders[2])}>
            choose archive
          </button>
          <button type="button" onClick={onQuickFileSubmit}>
            submit quick
          </button>
          <button type="button" onClick={onQuickFileCancel}>
            cancel quick
          </button>
        </div>
      )}
    </div>
  )
}))

const createItem = (id: string, type: InboxItemType, title: string): InboxItemListItem =>
  ({
    id,
    type,
    title,
    rawContent: title,
    content: title,
    createdAt: new Date(),
    status: 'pending',
    viewedAt: undefined,
    snoozedUntil: null,
    archivedAt: null,
    sourceUrl: type === 'link' ? 'https://example.com/story' : null,
    metadata: null,
    thumbnailUrl: null,
    transcription: null,
    transcriptionStatus: null,
    duration: null,
    attachments: []
  }) as InboxItemListItem

const renderListView = (overrides: Partial<React.ComponentProps<typeof ListView>> = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0
      }
    }
  })
  const props: React.ComponentProps<typeof ListView> = {
    items: [
      createItem('item-1', 'link', 'First link'),
      createItem('item-2', 'voice', 'Voice note'),
      createItem('item-3', 'note', 'Plain note')
    ],
    selectedItemIds: new Set(),
    onPreview: vi.fn(),
    onArchive: vi.fn(),
    onQuickFile: vi.fn(),
    onSelectionChange: vi.fn(),
    onFocusedItemChange: vi.fn(),
    ...overrides
  }

  render(
    <QueryClientProvider client={queryClient}>
      <ListView {...props} />
    </QueryClientProvider>
  )

  return props
}

describe('ListView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.inputFocused = false
    window.api.notes.getFolders.mockResolvedValue([{ path: 'Work' }, { path: 'Archive/Read' }])
    Object.defineProperty(window, 'open', {
      value: mocks.windowOpen,
      writable: true
    })
  })

  it('drives keyboard preview, focus, archive, range selection, and external open shortcuts', async () => {
    const user = userEvent.setup()
    const props = renderListView()

    await user.keyboard(' ')
    expect(props.onPreview).toHaveBeenLastCalledWith('item-1')

    await user.keyboard('{ArrowDown} ')
    expect(props.onFocusedItemChange).toHaveBeenLastCalledWith('item-2')
    expect(props.onPreview).toHaveBeenLastCalledWith('item-2')

    await user.keyboard('x')
    expect(props.onSelectionChange).toHaveBeenLastCalledWith(new Set(['item-2']))

    await user.keyboard('{Control>}a{/Control}')
    expect(props.onSelectionChange).toHaveBeenLastCalledWith(
      new Set(['item-1', 'item-2', 'item-3'])
    )

    await user.keyboard('{ArrowUp}o')
    expect(mocks.windowOpen).toHaveBeenCalledWith(
      'https://example.com/story',
      '_blank',
      'noopener,noreferrer'
    )

    await user.click(screen.getByRole('button', { name: 'retry item-2' }))
    expect(mocks.retryTranscription).toHaveBeenCalledWith('item-2')
  })

  it('opens quick-file from the focused item and submits it', async () => {
    const user = userEvent.setup()
    const props = renderListView()

    await waitFor(() => expect(window.api.notes.getFolders).toHaveBeenCalled())

    await user.keyboard('f')
    await waitFor(() => expect(screen.getByText('quick file item-1')).toBeInTheDocument())
    await act(async () => undefined)
    expect(screen.getByText('folders 3')).toBeInTheDocument()

    await user.type(screen.getByLabelText('quick query item-1'), 'work')
    await user.click(screen.getByRole('button', { name: 'submit quick' }))
    expect(props.onQuickFile).toHaveBeenCalledWith('item-1', 'Work')
    await waitFor(() => expect(screen.queryByText('quick file item-1')).not.toBeInTheDocument())
  })

  it('ignores global shortcuts while inputs are focused or the preview is open', async () => {
    const user = userEvent.setup()
    const props = renderListView({ isPreviewOpen: true })

    await user.keyboard(' x{ArrowDown}{Backspace}')
    expect(props.onPreview).not.toHaveBeenCalled()
    expect(props.onSelectionChange).not.toHaveBeenCalled()
    expect(props.onArchive).not.toHaveBeenCalled()
    expect(props.onFocusedItemChange).not.toHaveBeenCalled()
  })

  it('drives archive, snooze, bulk escape, and extended keyboard navigation', async () => {
    const user = userEvent.setup()
    const props = renderListView({
      selectedItemIds: new Set(['item-1']),
      exitingItemIds: new Set(['item-2']),
      onSnooze: vi.fn()
    })

    expect(screen.getByText('TODAY exiting')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(props.onSelectionChange).toHaveBeenLastCalledWith(new Set())

    await user.keyboard('{Delete}')
    expect(props.onArchive).toHaveBeenLastCalledWith('item-1')

    await user.keyboard('{End}')
    expect(props.onFocusedItemChange).toHaveBeenLastCalledWith('item-3')

    await user.keyboard('{PageUp}')
    expect(props.onFocusedItemChange).toHaveBeenLastCalledWith('item-1')

    await user.keyboard('{PageDown}')
    expect(props.onFocusedItemChange).toHaveBeenLastCalledWith('item-3')

    await user.keyboard('{Home}')
    expect(props.onFocusedItemChange).toHaveBeenLastCalledWith('item-1')

    await user.click(screen.getByRole('button', { name: 'snooze item-1' }))
    expect(props.onSnooze).toHaveBeenCalledWith('item-1', '2026-05-11T10:00:00.000Z')
  })

  it('handles quick-file numeric selection, folder callbacks, cancel, and outside dismissal', async () => {
    const user = userEvent.setup()
    const props = renderListView()

    await waitFor(() => expect(window.api.notes.getFolders).toHaveBeenCalled())

    await user.keyboard('f')
    await waitFor(() => expect(screen.getByText('quick file item-1')).toBeInTheDocument())
    await user.type(screen.getByLabelText('quick query item-1'), 'work')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }))
    })
    expect(props.onQuickFile).toHaveBeenLastCalledWith('item-1', 'Work')

    await user.keyboard('f')
    await user.click(screen.getByRole('button', { name: 'next folder' }))
    await user.click(screen.getByRole('button', { name: 'previous folder' }))
    await user.click(screen.getByRole('button', { name: 'choose archive' }))
    expect(props.onQuickFile).toHaveBeenLastCalledWith('item-2', 'Archive/Read')

    await user.keyboard('f')
    await user.click(screen.getByRole('button', { name: 'cancel quick' }))
    expect(screen.queryByText('quick file item-1')).not.toBeInTheDocument()

    await user.keyboard('f')
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('quick file item-1')).not.toBeInTheDocument()
  })
})
