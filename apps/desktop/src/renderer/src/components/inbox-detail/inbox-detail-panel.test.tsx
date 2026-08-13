import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { InboxDetailPanel } from './inbox-detail-panel'
import type { InboxItemListItem } from '@/types'

const invalidateQueries = vi.fn()
const retryMutate = vi.fn()
const updateMutate = vi.fn()
const isInputFocusedMock = vi.fn()
let querySuggestions = [
  {
    destination: { type: 'folder', path: 'Projects/memrynote' },
    confidence: 0.9,
    suggestedTags: ['suggested']
  }
]

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params?.modifier ? `${key.split('.').at(-1)} ${params.modifier}` : key.split('.').at(-1),
    i18n: { dir: () => 'ltr' }
  })
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
  useQuery: (options: { enabled?: boolean; queryFn: () => Promise<unknown> }) => {
    if (options.enabled) void options.queryFn()
    return { data: querySuggestions }
  }
}))

vi.mock('@/contexts/day-panel-context', () => ({
  useDayPanel: () => ({ isOpen: true, width: 320 })
}))

vi.mock('@/hooks/use-inbox', () => ({
  useRetryTranscription: () => ({ mutate: retryMutate, isPending: false }),
  useUpdateInboxItem: () => ({ mutate: updateMutate })
}))

vi.mock('@/hooks/use-keyboard-shortcuts', () => ({
  isMac: false,
  isInputFocused: () => isInputFocusedMock()
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn() })
}))

vi.mock('./content-section', () => ({
  ContentSkeleton: () => <div>content skeleton</div>,
  ContentSection: ({
    item,
    onRetryTranscription,
    onContentChange
  }: {
    item: { title: string; type: string }
    onRetryTranscription?: () => void
    onContentChange?: (content: string) => void
  }) => (
    <div>
      content {item.type} {item.title}
      <button type="button" onClick={onRetryTranscription}>
        retry transcription
      </button>
      <button type="button" onClick={() => onContentChange?.('edited content')}>
        edit content
      </button>
    </div>
  )
}))

vi.mock('./detail-header', () => ({
  DetailHeader: ({ type, onClose }: { type: string; onClose: () => void }) => (
    <header>
      header {type}
      <button type="button" onClick={onClose}>
        close
      </button>
    </header>
  )
}))

vi.mock('./note-detail', () => ({
  NoteDetail: ({
    item,
    onContentChange,
    onTitleChange
  }: {
    item: { title: string }
    onContentChange?: (content: string) => void
    onTitleChange?: (title: string) => void
  }) => (
    <div>
      note detail {item.title}
      <button type="button" onClick={() => onTitleChange?.('Renamed note')}>
        rename note
      </button>
      <button type="button" onClick={() => onContentChange?.('body update')}>
        update note body
      </button>
    </div>
  )
}))

vi.mock('./convert-actions', () => ({
  ConvertActions: () => null
}))

vi.mock('./type-selector', () => ({
  TypeSelector: () => <div data-testid="type-selector" />
}))

vi.mock('./filing-section', async () => {
  const React = await vi.importActual<typeof import('react')>('react')
  return {
    useFilingState: ({ item, isOpen }: { item: { id: string } | null; isOpen: boolean }) => {
      const [selectedFolder, setSelectedFolder] = React.useState<any>(null)
      const [tags, setTags] = React.useState<string[]>([])
      const [linkedNotes, setLinkedNotes] = React.useState<Array<{ id: string }>>([])

      React.useEffect(() => {
        setSelectedFolder(null)
        setTags([])
        setLinkedNotes([])
      }, [item?.id, isOpen])

      return {
        selectedFolder,
        tags,
        linkedNotes,
        setSelectedFolder,
        setTags,
        setLinkedNotes,
        canFile: Boolean(selectedFolder)
      }
    },
    FilingSection: ({
      onFolderSelect,
      onTagsChange,
      onLinkedNotesChange
    }: {
      onFolderSelect: (folder: { id: string; path: string }) => void
      onTagsChange: (tags: string[]) => void
      onLinkedNotesChange: (notes: Array<{ id: string }>) => void
    }) => (
      <section>
        filing section
        <button type="button" onClick={() => onFolderSelect({ id: 'Projects', path: 'Projects' })}>
          select folder
        </button>
        <button type="button" onClick={() => onTagsChange(['tag-a'])}>
          set tags
        </button>
        <button type="button" onClick={() => onLinkedNotesChange([{ id: 'note-link' }])}>
          link note
        </button>
      </section>
    )
  }
})

const baseItem: InboxItemListItem = {
  id: 'inbox-1',
  type: 'note',
  title: 'Inbox note',
  content: 'Body',
  createdAt: new Date('2026-05-10T10:00:00Z'),
  thumbnailUrl: null,
  sourceUrl: null,
  tags: [],
  isStale: false,
  processingStatus: 'complete'
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof InboxDetailPanel>> = {}) {
  const props = {
    isOpen: true,
    item: baseItem,
    onClose: vi.fn(),
    onFile: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onDelete: vi.fn(),
    ...overrides
  }
  render(<InboxDetailPanel {...props} />)
  return props
}

describe('InboxDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    isInputFocusedMock.mockReturnValue(false)
    querySuggestions = [
      {
        destination: { type: 'folder', path: 'Projects/memrynote' },
        confidence: 0.9,
        suggestedTags: ['suggested']
      }
    ]
    ;(window as any).api = {
      inbox: {
        getSuggestions: vi.fn().mockResolvedValue({ suggestions: [] }),
        trackSuggestion: vi.fn().mockResolvedValue(undefined)
      },
      // The panel reads the image filing preference (#807); without these the
      // settings hook throws before anything renders.
      settings: {
        getInboxSettings: vi.fn().mockResolvedValue({
          reviewReminderEnabled: false,
          reviewReminderTime: '18:00',
          imageFilingMode: 'embed',
          imageFilingModeRemembered: false
        }),
        setInboxSettings: vi.fn().mockResolvedValue({ success: true })
      },
      onSettingsChanged: vi.fn(() => () => {})
    }
  })

  it('shows the type selector for text items but hides it for note-only ones', () => {
    renderPanel()
    expect(screen.getByTestId('type-selector')).toBeInTheDocument()

    cleanup()
    renderPanel({ item: { ...baseItem, id: 'inbox-image', type: 'image' as const } })
    expect(screen.queryByTestId('type-selector')).not.toBeInTheDocument()
  })

  it('renders loading and closed states without item content', () => {
    renderPanel({ item: null, isLoading: true, isOpen: false })

    expect(screen.getByTestId('inbox-detail-panel')).toHaveAttribute('data-state', 'closed')
    expect(screen.getByText('content skeleton')).toBeInTheDocument()
  })

  it('files a note with selected folder, tags, links, suggestion feedback, and close', async () => {
    const user = userEvent.setup()
    const props = renderPanel()

    await user.click(screen.getByRole('button', { name: 'select folder' }))
    await user.click(screen.getByRole('button', { name: 'set tags' }))
    await user.click(screen.getByRole('button', { name: 'link note' }))
    await user.click(screen.getByRole('button', { name: /file/ }))

    expect((window as any).api.inbox.trackSuggestion).toHaveBeenCalledWith({
      itemId: 'inbox-1',
      itemType: 'note',
      suggestedTo: 'Projects/memrynote',
      actualTo: 'Projects',
      confidence: 0.9,
      suggestedTags: ['suggested'],
      actualTags: ['tag-a']
    })
    expect(props.onFile).toHaveBeenCalledWith(
      'inbox-1',
      'Projects',
      ['tag-a'],
      [{ kind: 'note', noteId: 'note-link' }],
      undefined
    )
    expect(props.onClose).toHaveBeenCalled()
  })

  it('supports archive, shortcut close, suggestion number shortcuts, and command-enter filing', async () => {
    const props = renderPanel()

    fireEvent.keyDown(document, { key: '1' })
    fireEvent.keyDown(document, { key: 'Enter', ctrlKey: true })

    await waitFor(() =>
      expect(props.onFile).toHaveBeenCalledWith('inbox-1', 'Projects/memrynote', [], [], undefined)
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /archive/ }))
    expect(props.onArchive).toHaveBeenCalledWith('inbox-1')
  })

  it('saves note content after debounce and invalidates suggestions', async () => {
    vi.useFakeTimers()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()

    await user.click(screen.getByRole('button', { name: 'rename note' }))
    await user.click(screen.getByRole('button', { name: 'update note body' }))
    await user.click(screen.getByRole('button', { name: 'update note body' }))

    vi.advanceTimersByTime(1500)

    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'inbox-1', content: 'body update', title: 'Renamed note' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    )
    const options = updateMutate.mock.calls[0][1]
    options.onSuccess()
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['inbox', 'suggestions', 'inbox-1']
    })
  })

  it('handles voice title save and retry transcription', async () => {
    const user = userEvent.setup()
    renderPanel({
      item: {
        ...baseItem,
        id: 'voice-1',
        type: 'voice' as const,
        title: 'Voice title'
      }
    })

    const titleInput = screen.getByDisplayValue('Voice title')
    await user.clear(titleInput)
    await user.type(titleInput, 'Updated voice{Enter}')
    expect(updateMutate).toHaveBeenCalledWith({ id: 'voice-1', title: 'Updated voice' })

    await user.click(screen.getByRole('button', { name: 'retry transcription' }))
    expect(retryMutate).toHaveBeenCalledWith('voice-1')
  })

  // #808: image and PDF attachments used to render no title at all, so a capture
  // named after the OS filename could never be corrected.
  it.each(['image', 'pdf'] as const)('renames a %s attachment from the panel', async (type) => {
    const user = userEvent.setup()
    renderPanel({
      item: { ...baseItem, id: `${type}-1`, type, title: 'scan_final_v3' }
    })

    const titleInput = screen.getByDisplayValue('scan_final_v3')
    await user.clear(titleInput)
    await user.type(titleInput, 'Quarterly report{Enter}')

    expect(updateMutate).toHaveBeenCalledWith({ id: `${type}-1`, title: 'Quarterly report' })
  })

  it('reverts to the previous title when an attachment name is cleared', async () => {
    const user = userEvent.setup()
    renderPanel({
      item: { ...baseItem, id: 'image-2', type: 'image' as const, title: 'Whiteboard' }
    })

    const titleInput = screen.getByDisplayValue('Whiteboard')
    await user.clear(titleInput)
    await user.tab()

    expect(updateMutate).not.toHaveBeenCalled()
    expect(titleInput).toHaveValue('Whiteboard')
  })

  it('leaves an unchanged attachment title alone', async () => {
    const user = userEvent.setup()
    renderPanel({
      item: { ...baseItem, id: 'pdf-2', type: 'pdf' as const, title: 'Invoice' }
    })

    await user.click(screen.getByDisplayValue('Invoice'))
    await user.tab()

    expect(updateMutate).not.toHaveBeenCalled()
  })

  it('keeps an attachment title read-only in the archived panel', () => {
    renderPanel({
      readOnly: true,
      item: { ...baseItem, id: 'image-3', type: 'image' as const, title: 'Archived shot' }
    })

    expect(screen.queryByDisplayValue('Archived shot')).not.toBeInTheDocument()
    expect(screen.getByText('Archived shot')).toBeInTheDocument()
  })

  it('renders read-only restore and delete actions without filing controls', async () => {
    const user = userEvent.setup()
    const props = renderPanel({ readOnly: true })

    expect(screen.queryByText('filing section')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /restore/ }))
    await user.click(screen.getByRole('button', { name: /delete/ }))

    expect(props.onRestore).toHaveBeenCalledWith('inbox-1')
    expect(props.onDelete).toHaveBeenCalledWith('inbox-1')
  })

  it('handles focused-input escape, reminder archive, and suggestion fetch failures', async () => {
    const user = userEvent.setup()
    isInputFocusedMock.mockReturnValue(true)
    ;(window as any).api.inbox.getSuggestions.mockRejectedValueOnce(new Error('offline'))

    const props = renderPanel({
      item: {
        ...baseItem,
        id: 'reminder-1',
        type: 'reminder' as const,
        title: 'Reminder item'
      }
    })

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalled()
    expect(screen.queryByText('filing section')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /archive/ }))
    expect(props.onArchive).toHaveBeenCalledWith('reminder-1')

    await waitFor(() => expect((window as any).api.inbox.getSuggestions).toHaveBeenCalled())
  })

  it('resizes content, clears resize state, and resets manual height on item changes', () => {
    const props = {
      isOpen: true,
      item: baseItem,
      onClose: vi.fn(),
      onFile: vi.fn(),
      onArchive: vi.fn()
    }
    const { rerender } = render(<InboxDetailPanel {...props} />)
    const separator = screen.getByRole('separator', { name: 'resizeFiling' })
    const contentPane = separator.parentElement?.firstElementChild as HTMLElement
    const container = separator.parentElement as HTMLElement

    Object.defineProperty(contentPane, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: 160 })
    })
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ height: 420 })
    })

    fireEvent.mouseDown(separator, { clientY: 100 })
    fireEvent.mouseMove(document, { clientY: 160 })
    expect(contentPane.style.height).toBe('220px')
    expect(document.body.style.cursor).toBe('row-resize')

    fireEvent.mouseUp(document)
    expect(document.body.style.cursor).toBe('')

    rerender(
      <InboxDetailPanel
        {...props}
        item={{
          ...baseItem,
          id: 'inbox-2',
          title: 'Second note'
        }}
      />
    )
    expect(screen.getByText(/note detail Second note/)).toBeInTheDocument()
  })

  it('skips unchanged voice titles and clears pending content timers on unmount', async () => {
    vi.useFakeTimers()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { unmount } = render(
      <InboxDetailPanel
        isOpen
        item={{ ...baseItem, id: 'voice-2', type: 'voice' as const, title: 'Voice title' }}
        onClose={vi.fn()}
        onFile={vi.fn()}
        onArchive={vi.fn()}
      />
    )

    const titleInput = screen.getByDisplayValue('Voice title')
    fireEvent.blur(titleInput)
    expect(updateMutate).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'edit content' }))
    unmount()
    vi.advanceTimersByTime(1500)
    expect(updateMutate).not.toHaveBeenCalled()
  })
})
