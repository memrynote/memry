import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@tests/utils/render'
import { InboxListView } from './inbox-list-view'
import type React from 'react'
import { toast } from 'sonner'

const mocks = vi.hoisted(() => ({
  inboxState: {
    items: [] as Array<Record<string, unknown>>,
    isLoading: false,
    error: null as Error | null,
    detailItem: null as Record<string, unknown> | null
  },
  remindersPanel: {
    upcoming: [] as Array<Record<string, unknown>>,
    past: [] as Array<Record<string, unknown>>,
    upcomingCount: 0,
    isLoading: false
  },
  refetch: vi.fn(),
  fileItem: vi.fn(),
  bulkArchive: vi.fn(),
  archiveWithUndo: vi.fn(),
  snooze: vi.fn(),
  captureImage: vi.fn(),
  openTab: vi.fn(),
  invalidateQueries: vi.fn(),
  detectClusters: vi.fn(),
  getClusterKey: vi.fn(),
  isInputFocused: vi.fn(),
  keyboardOptions: null as {
    onRefresh: () => void
    onArchiveFocusedItem: (itemId: string, nextItemId: string | null) => void
    onOpenBulkArchiveDialog: () => void
    onOpenSourceUrl: (url: string) => void
  } | null
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string, values?: Record<string, unknown>) => values?.count ?? key })
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries })
  }
})

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: mocks.openTab }),
  // The detail panel's open item lives in the tab; outside a tab provider the
  // hook degrades to plain local state, which is what these tests exercise.
  useTabActionsOptional: () => null
}))

// Spread the real (dependency-free) module so DENSITY_CONFIG is always complete; a
// minimal partial mock could surface as `DENSITY_CONFIG.compact` undefined when test
// files share module state in the full coverage run.
vi.mock('@/hooks/use-display-density', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-display-density')>())
}))

vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  isInputFocused: mocks.isInputFocused
}))

vi.mock('@/hooks/use-inbox-keyboard', () => ({
  useInboxKeyboard: vi.fn((options) => {
    mocks.keyboardOptions = options
  })
}))

vi.mock('@/hooks/use-undoable-action', () => ({
  useUndoableAction: () => ({ archiveWithUndo: mocks.archiveWithUndo })
}))

vi.mock('@/hooks/use-notes-query', () => ({
  notesKeys: { note: (id: string) => ['notes', id] }
}))

vi.mock('@/hooks/use-inbox', () => ({
  inboxKeys: { lists: () => ['inbox', 'list'] },
  useInboxList: () => ({
    items: mocks.inboxState.items,
    isLoading: mocks.inboxState.isLoading,
    error: mocks.inboxState.error,
    refetch: mocks.refetch
  }),
  useInboxItem: (id: string | null) => ({
    item: id ? mocks.inboxState.detailItem : null,
    isLoading: false
  }),
  useArchiveInboxItem: () => ({ mutateAsync: vi.fn() }),
  useBulkArchiveInboxItems: () => ({ mutateAsync: mocks.bulkArchive }),
  useFileInboxItem: () => ({ mutateAsync: mocks.fileItem }),
  useInboxStats: () => ({
    stats: { processedToday: 2, processedThisWeek: 7, currentStreak: 3 }
  })
}))

vi.mock('@/services/inbox-service', () => ({
  inboxService: {
    markViewed: vi.fn(),
    snooze: mocks.snooze,
    captureImage: mocks.captureImage
  }
}))

vi.mock('@/hooks/use-inbox-reminders-panel', () => ({
  useInboxRemindersPanel: () => mocks.remindersPanel
}))

vi.mock('@/components/inbox/inbox-reminders-list', () => ({
  InboxRemindersList: ({ panel }: { panel: { upcoming: unknown[]; past: unknown[] } }) => (
    <div
      data-testid="reminders-panel"
      data-upcoming={panel.upcoming.length}
      data-past={panel.past.length}
    />
  )
}))

vi.mock('@/lib/ai-clustering', () => ({
  detectClusters: mocks.detectClusters,
  getClusterKey: mocks.getClusterKey
}))

vi.mock('@/lib/ipc-error', () => ({
  extractErrorMessage: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  )
}))

vi.mock('@/components/list-view', () => ({
  ListView: ({
    items,
    onPreview,
    onArchive,
    onSnooze,
    onQuickFile,
    onSelectionChange,
    onFocusedItemChange
  }: {
    items: Array<{ id: string; title: string }>
    onPreview: (id: string) => void
    onArchive: (id: string) => void
    onSnooze: (id: string, until: string) => void
    onQuickFile: (id: string, folder: string) => void
    onSelectionChange: (selection: Set<string>) => void
    onFocusedItemChange: (id: string | null) => void
  }) => (
    <div>
      {items.map((item) => (
        <span key={item.id}>{item.title}</span>
      ))}
      <button type="button" onClick={() => onPreview('item-1')}>
        Preview item
      </button>
      <button type="button" onClick={() => onArchive('item-1')}>
        Archive item
      </button>
      <button type="button" onClick={() => onSnooze('item-1', '2026-05-11T10:00:00.000Z')}>
        Snooze item
      </button>
      <button type="button" onClick={() => onQuickFile('item-1', 'Inbox')}>
        Quick file item
      </button>
      <button type="button" onClick={() => onSelectionChange(new Set(['item-1']))}>
        Select item
      </button>
      <button type="button" onClick={() => onFocusedItemChange('item-1')}>
        Focus item
      </button>
    </div>
  )
}))

vi.mock('@/components/inbox-detail', () => ({
  InboxDetailPanel: ({
    isOpen,
    item,
    onClose,
    onFile,
    onArchive
  }: {
    isOpen: boolean
    item: { id: string; title: string } | null
    onClose: () => void
    onFile: (
      id: string,
      folder: string,
      tags: string[],
      targets: Array<{ kind: 'note'; noteId: string } | { kind: 'new'; title: string }>,
      imageMode?: 'embed' | 'link'
    ) => void
    onArchive: (id: string) => void
  }) =>
    isOpen ? (
      <div>
        <span>Detail {item?.title}</span>
        <button
          type="button"
          onClick={() =>
            onFile('item-1', 'Filed', ['work'], [{ kind: 'note', noteId: 'note-1' }], 'embed')
          }
        >
          Detail file
        </button>
        <button type="button" onClick={() => onArchive('item-1')}>
          Detail archive
        </button>
        <button type="button" onClick={onClose}>
          Detail close
        </button>
      </div>
    ) : null
}))

vi.mock('@/components/bulk/bulk-action-bar', () => ({
  BulkActionBar: ({
    selectedCount,
    onFileAll,
    onTagAll,
    onArchiveAll,
    onSnoozeAll,
    aiSuggestion,
    onAddSuggestionToSelection,
    onDismissSuggestion
  }: {
    selectedCount: number
    onFileAll: () => void
    onTagAll: () => void
    onArchiveAll: () => void
    onSnoozeAll: (until: string) => void
    aiSuggestion: unknown
    onAddSuggestionToSelection: () => void
    onDismissSuggestion: () => void
  }) =>
    selectedCount > 0 ? (
      <div>
        <span>Selected {selectedCount}</span>
        <button type="button" onClick={onFileAll}>
          Bulk file all
        </button>
        <button type="button" onClick={onTagAll}>
          Bulk tag all
        </button>
        <button type="button" onClick={onArchiveAll}>
          Bulk archive all
        </button>
        <button type="button" onClick={() => onSnoozeAll('2026-05-12T12:00:00.000Z')}>
          Bulk snooze all
        </button>
        {aiSuggestion ? (
          <>
            <button type="button" onClick={onAddSuggestionToSelection}>
              Add suggestion
            </button>
            <button type="button" onClick={onDismissSuggestion}>
              Dismiss suggestion
            </button>
          </>
        ) : null}
      </div>
    ) : null
}))

vi.mock('@/components/bulk/bulk-file-panel', () => ({
  BulkFilePanel: ({
    isOpen,
    onFile,
    onClose
  }: {
    isOpen: boolean
    onFile: (ids: string[], folder: string, tags: string[]) => void
    onClose: () => void
  }) =>
    isOpen ? (
      <div>
        <button type="button" onClick={() => onFile(['item-1'], 'Filed', ['work'])}>
          Confirm bulk file
        </button>
        <button type="button" onClick={onClose}>
          Close bulk file
        </button>
      </div>
    ) : null
}))

vi.mock('@/components/bulk/bulk-tag-popover', () => ({
  BulkTagPopover: ({
    isOpen,
    onApplyTags,
    onOpenChange
  }: {
    isOpen: boolean
    onApplyTags: (tags: string[]) => void
    onOpenChange: (open: boolean) => void
  }) =>
    isOpen ? (
      <div>
        <button type="button" onClick={() => onApplyTags(['later'])}>
          Confirm bulk tag
        </button>
        <button type="button" onClick={() => onOpenChange(false)}>
          Close bulk tag
        </button>
      </div>
    ) : null
}))

vi.mock('@/components/bulk/archive-confirmation-dialog', () => ({
  ArchiveConfirmationDialog: ({
    isOpen,
    onConfirm,
    onCancel
  }: {
    isOpen: boolean
    onConfirm: () => void
    onCancel: () => void
  }) =>
    isOpen ? (
      <div>
        <button type="button" onClick={onConfirm}>
          Confirm bulk archive
        </button>
        <button type="button" onClick={onCancel}>
          Cancel bulk archive
        </button>
      </div>
    ) : null
}))

vi.mock('@/components/empty-state/empty-state', () => ({
  EmptyState: ({
    itemsProcessedToday,
    processedThisWeek,
    currentStreak
  }: {
    itemsProcessedToday: number
    processedThisWeek: number
    currentStreak: number
  }) => (
    <div>
      Empty {itemsProcessedToday}/{processedThisWeek}/{currentStreak}
    </div>
  )
}))

const item = {
  id: 'item-1',
  type: 'link',
  title: 'Saved Link',
  content: 'Read later',
  createdAt: new Date('2026-05-09'),
  thumbnailUrl: null,
  sourceUrl: 'https://memry.test',
  tags: ['work'],
  isStale: false,
  processingStatus: 'completed'
}

function setWindowBulkMocks() {
  const api = window.api as unknown as {
    inbox: {
      bulkFile: ReturnType<typeof vi.fn>
      bulkTag: ReturnType<typeof vi.fn>
      bulkSnooze: ReturnType<typeof vi.fn>
    }
  }
  api.inbox.bulkFile = vi.fn().mockResolvedValue({ success: true, processedCount: 1, errors: [] })
  api.inbox.bulkTag = vi.fn().mockResolvedValue({ success: true, processedCount: 1, errors: [] })
  api.inbox.bulkSnooze = vi.fn().mockResolvedValue({ success: true, processedCount: 1, errors: [] })
  return api.inbox
}

describe('InboxListView', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    mocks.inboxState.items = [item]
    mocks.inboxState.isLoading = false
    mocks.inboxState.error = null
    mocks.inboxState.detailItem = item
    mocks.remindersPanel = { upcoming: [], past: [], upcomingCount: 0, isLoading: false }
    mocks.fileItem.mockResolvedValue({ success: true })
    mocks.bulkArchive.mockResolvedValue({ success: true })
    mocks.archiveWithUndo.mockResolvedValue(undefined)
    mocks.snooze.mockResolvedValue({ success: true })
    mocks.captureImage.mockResolvedValue({ success: true })
    mocks.detectClusters.mockReturnValue({ items: [item], reason: 'same tag' })
    mocks.getClusterKey.mockReturnValue('cluster-1')
    mocks.isInputFocused.mockReturnValue(false)
    mocks.keyboardOptions = null
    setWindowBulkMocks()
  })

  it('renders loading, error, and empty states', () => {
    const { rerender } = renderWithProviders(
      <InboxListView selectedTypes={new Set()} showSnoozedItems={false} />
    )
    expect(screen.getByText('Saved Link')).toBeInTheDocument()

    mocks.inboxState.isLoading = true
    rerender(<InboxListView selectedTypes={new Set()} showSnoozedItems={false} />)
    expect(screen.getByText('loading.inbox')).toBeInTheDocument()

    mocks.inboxState.isLoading = false
    mocks.inboxState.error = new Error('broken')
    rerender(<InboxListView selectedTypes={new Set()} showSnoozedItems={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'loading.tryAgain' }))
    expect(mocks.refetch).toHaveBeenCalled()

    mocks.inboxState.error = null
    mocks.inboxState.items = []
    rerender(<InboxListView selectedTypes={new Set()} showSnoozedItems={false} />)
    expect(screen.getByText('Empty 2/7/3')).toBeInTheDocument()
  })

  it('renders the reminders panel instead of the list in the snoozed view', () => {
    mocks.remindersPanel = {
      upcoming: [{ key: 'u1' }, { key: 'u2' }],
      past: [{ key: 'p1' }],
      upcomingCount: 2,
      isLoading: false
    }

    renderWithProviders(<InboxListView selectedTypes={new Set()} showSnoozedItems />)

    const panel = screen.getByTestId('reminders-panel')
    expect(panel).toHaveAttribute('data-upcoming', '2')
    expect(panel).toHaveAttribute('data-past', '1')
    // The normal inbox list rows are not shown in the reminders view.
    expect(screen.queryByText('Saved Link')).not.toBeInTheDocument()
  })

  it('previews, files, archives, and snoozes individual items', async () => {
    vi.useFakeTimers()

    const renderFresh = () =>
      renderWithProviders(<InboxListView selectedTypes={new Set()} showSnoozedItems={false} />)

    let view = renderFresh()
    fireEvent.click(screen.getByRole('button', { name: 'Preview item' }))
    expect(screen.getByText('Detail Saved Link')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Detail file' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mocks.fileItem).toHaveBeenCalledWith({
      itemId: 'item-1',
      destination: {
        type: 'note',
        targets: [{ kind: 'note', noteId: 'note-1' }],
        path: 'Filed'
      },
      tags: ['work'],
      imageMode: 'embed'
    })
    view.unmount()

    view = renderFresh()
    fireEvent.click(screen.getByRole('button', { name: 'Quick file item' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mocks.fileItem).toHaveBeenCalledWith({
      itemId: 'item-1',
      destination: { type: 'folder', path: 'Inbox' },
      tags: []
    })
    view.unmount()

    view = renderFresh()
    fireEvent.click(screen.getByRole('button', { name: 'Archive item' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mocks.archiveWithUndo).toHaveBeenCalledWith('item-1', 'Saved Link')
    view.unmount()

    renderFresh()
    fireEvent.click(screen.getByRole('button', { name: 'Snooze item' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mocks.snooze).toHaveBeenCalledWith({
      itemId: 'item-1',
      snoozeUntil: '2026-05-11T10:00:00.000Z'
    })
  })

  it('executes bulk file, tag, archive, snooze, and suggestion flows', async () => {
    vi.useFakeTimers()

    const renderSelected = () => {
      const inboxApi = setWindowBulkMocks()
      const view = renderWithProviders(
        <InboxListView selectedTypes={new Set()} showSnoozedItems={false} />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Select item' }))
      expect(screen.getByText('Selected 1')).toBeInTheDocument()
      return { inboxApi, view }
    }

    let { inboxApi, view } = renderSelected()
    fireEvent.click(screen.getByRole('button', { name: 'Bulk file all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bulk file' }))
    expect(inboxApi.bulkFile).toHaveBeenCalledWith({
      itemIds: ['item-1'],
      destination: { type: 'folder', path: 'Filed' },
      tags: ['work']
    })
    view.unmount()
    ;({ inboxApi, view } = renderSelected())
    fireEvent.click(screen.getByRole('button', { name: 'Bulk tag all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bulk tag' }))
    expect(inboxApi.bulkTag).toHaveBeenCalledWith({ itemIds: ['item-1'], tags: ['later'] })
    view.unmount()
    ;({ inboxApi, view } = renderSelected())
    fireEvent.click(screen.getByRole('button', { name: 'Bulk snooze all' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(inboxApi.bulkSnooze).toHaveBeenCalledWith({
      itemIds: ['item-1'],
      snoozeUntil: '2026-05-12T12:00:00.000Z'
    })
    view.unmount()
    ;({ view } = renderSelected())
    fireEvent.click(screen.getByRole('button', { name: 'Bulk archive all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bulk archive' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mocks.bulkArchive).toHaveBeenCalledWith({ itemIds: ['item-1'] })
    view.unmount()

    renderSelected()
    fireEvent.click(screen.getByRole('button', { name: 'Add suggestion' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss suggestion' }))
    expect(mocks.getClusterKey).toHaveBeenCalled()
  })

  it('opens focus-token details', async () => {
    renderWithProviders(
      <InboxListView
        selectedTypes={new Set()}
        showSnoozedItems={false}
        focusItemId="item-1"
        focusToken={1}
      />
    )

    await waitFor(() => expect(screen.getByText('Detail Saved Link')).toBeInTheDocument())
  })

  it('uses keyboard callbacks for refresh, source URLs, archive focus, and bulk archive dialog', async () => {
    vi.useFakeTimers()
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    renderWithProviders(<InboxListView selectedTypes={new Set()} showSnoozedItems={false} />)

    mocks.keyboardOptions?.onRefresh()
    expect(mocks.refetch).toHaveBeenCalled()

    mocks.keyboardOptions?.onOpenSourceUrl('https://memry.test/source')
    expect(openSpy).toHaveBeenCalledWith(
      'https://memry.test/source',
      '_blank',
      'noopener,noreferrer'
    )

    act(() => {
      mocks.keyboardOptions?.onOpenBulkArchiveDialog()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel bulk archive' }))

    act(() => {
      mocks.keyboardOptions?.onArchiveFocusedItem('item-1', 'next-item')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(mocks.archiveWithUndo).toHaveBeenCalledWith('item-1', 'Saved Link')

    openSpy.mockRestore()
  })

  it('falls back to list data when detail data is not loaded', () => {
    mocks.inboxState.detailItem = null

    renderWithProviders(<InboxListView selectedTypes={new Set()} showSnoozedItems={false} />)

    fireEvent.click(screen.getByRole('button', { name: 'Preview item' }))
    expect(screen.getByText('Detail Saved Link')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Detail close' }))
    expect(screen.queryByText('Detail Saved Link')).not.toBeInTheDocument()
  })

  it('rolls back failed individual archive, file, and snooze actions', async () => {
    vi.useFakeTimers()

    const renderFresh = () =>
      renderWithProviders(<InboxListView selectedTypes={new Set()} showSnoozedItems={false} />)

    mocks.archiveWithUndo.mockRejectedValueOnce(new Error('archive failed'))
    let view = renderFresh()
    fireEvent.click(screen.getByRole('button', { name: 'Archive item' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(toast.error).toHaveBeenCalledWith('toast.failedArchiveItem')
    view.unmount()

    mocks.fileItem.mockResolvedValueOnce({ success: false, error: 'file failed' })
    view = renderFresh()
    fireEvent.click(screen.getByRole('button', { name: 'Quick file item' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(toast.error).toHaveBeenCalledWith('file failed')
    view.unmount()

    mocks.snooze.mockResolvedValueOnce({ success: false, error: 'snooze failed' })
    renderFresh()
    fireEvent.click(screen.getByRole('button', { name: 'Snooze item' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(toast.error).toHaveBeenCalledWith('snooze failed')
  })

  it('handles bulk partial success and failure paths', async () => {
    vi.useFakeTimers()

    const renderSelected = () => {
      const inboxApi = setWindowBulkMocks()
      const view = renderWithProviders(
        <InboxListView selectedTypes={new Set()} showSnoozedItems={false} />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Select item' }))
      return { inboxApi, view }
    }

    let { inboxApi, view } = renderSelected()
    inboxApi.bulkFile.mockResolvedValueOnce({
      success: false,
      processedCount: 1,
      errors: ['failed later']
    })
    fireEvent.click(screen.getByRole('button', { name: 'Bulk file all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bulk file' }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('toast.filedPartial'))
    view.unmount()
    ;({ inboxApi, view } = renderSelected())
    inboxApi.bulkFile.mockResolvedValueOnce({ success: false, processedCount: 0, errors: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Bulk file all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bulk file' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('toast.failedFileItems'))
    view.unmount()
    ;({ inboxApi, view } = renderSelected())
    inboxApi.bulkTag.mockResolvedValueOnce({ success: false, processedCount: 0, errors: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Bulk tag all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bulk tag' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('toast.failedApplyTags'))
    view.unmount()
    ;({ view } = renderSelected())
    mocks.bulkArchive.mockRejectedValueOnce(new Error('archive failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Bulk archive all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm bulk archive' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(toast.error).toHaveBeenCalledWith('toast.failedArchiveItems')
    view.unmount()
    ;({ inboxApi } = renderSelected())
    inboxApi.bulkSnooze.mockResolvedValueOnce({ success: false, processedCount: 0, errors: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Bulk snooze all' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(toast.error).toHaveBeenCalledWith('toast.failedSnooze')
  })

  it('filters by selected item type and toggles preview detail state', () => {
    const { rerender } = renderWithProviders(
      <InboxListView selectedTypes={new Set(['voice'])} showSnoozedItems={false} />
    )
    expect(screen.getByText('Empty 2/7/3')).toBeInTheDocument()

    rerender(<InboxListView selectedTypes={new Set(['link'])} showSnoozedItems={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Preview item' }))
    expect(screen.getByText('Detail Saved Link')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Preview item' }))
    expect(screen.queryByText('Detail Saved Link')).not.toBeInTheDocument()
  })

  it('captures dropped and pasted images while rejecting unsupported image files', async () => {
    const view = renderWithProviders(
      <InboxListView selectedTypes={new Set()} showSnoozedItems={false} />
    )
    const dropTarget = screen.getByText('Saved Link')
    const pngFile = new File(['png-data'], 'capture.png', { type: 'image/png' })
    const bmpFile = new File(['bmp-data'], 'capture.bmp', { type: 'image/bmp' })
    Object.defineProperty(pngFile, 'arrayBuffer', {
      value: vi.fn(async () => new ArrayBuffer(8))
    })

    await act(async () => {
      fireEvent.dragOver(dropTarget, {
        dataTransfer: {
          types: ['Files'],
          files: [pngFile],
          dropEffect: 'none'
        }
      })
    })
    expect(screen.getByText('loading.dropImageTitle')).toBeInTheDocument()

    await act(async () => {
      fireEvent.drop(dropTarget, {
        dataTransfer: {
          files: [pngFile, bmpFile]
        }
      })
    })
    expect(mocks.captureImage).toHaveBeenCalledWith({
      data: expect.any(ArrayBuffer),
      filename: 'capture.png',
      mimeType: 'image/png'
    })
    expect(toast.error).toHaveBeenCalledWith('loading.unsupportedImageType')

    mocks.captureImage.mockClear()
    const pasteEvent = new Event('paste') as ClipboardEvent
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [
          {
            type: 'image/png',
            getAsFile: () => pngFile
          }
        ]
      }
    })
    Object.defineProperty(pasteEvent, 'preventDefault', { value: vi.fn() })

    await act(async () => {
      window.dispatchEvent(pasteEvent)
    })
    expect(pasteEvent.preventDefault).toHaveBeenCalled()
    expect(mocks.captureImage).toHaveBeenCalledTimes(1)

    view.unmount()
  })

  it('reports image capture size and service failures', async () => {
    const hugeFile = new File(['x'], 'huge.png', { type: 'image/png' })
    Object.defineProperty(hugeFile, 'size', { value: 51 * 1024 * 1024 })
    renderWithProviders(<InboxListView selectedTypes={new Set()} showSnoozedItems={false} />)

    await act(async () => {
      fireEvent.drop(screen.getByText('Saved Link'), {
        dataTransfer: {
          files: [hugeFile]
        }
      })
    })
    expect(toast.error).toHaveBeenCalledWith('loading.imageTooLarge')

    mocks.captureImage.mockResolvedValueOnce({ success: false, error: 'capture failed' })
    const pngFile = new File(['png-data'], 'capture.png', { type: 'image/png' })
    Object.defineProperty(pngFile, 'arrayBuffer', {
      value: vi.fn(async () => new ArrayBuffer(8))
    })
    await act(async () => {
      fireEvent.drop(screen.getByText('Saved Link'), {
        dataTransfer: {
          files: [pngFile]
        }
      })
    })
    expect(toast.error).toHaveBeenCalledWith('capture failed')
  })
})
