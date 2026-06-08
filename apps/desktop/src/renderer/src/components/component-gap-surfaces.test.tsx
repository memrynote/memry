import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, userEvent } from '@tests/utils/render'

import { ReminderDetail } from './inbox-detail/reminder-detail'
import { InboxContentEditor } from './inbox-detail/inbox-content-editor'
import { BacklinksSection } from './note/backlinks/BacklinksSection'
import { ExportDialog } from './note/export-dialog'

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  snooze: vi.fn(),
  markViewed: vi.fn(),
  logError: vi.fn(),
  exportPdf: vi.fn(),
  exportHtml: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  tryParseHTMLToBlocks: vi.fn(),
  replaceBlocks: vi.fn(),
  blocksToHTMLLossy: vi.fn(),
  editorFocus: vi.fn(),
  extractTitleFromBlocks: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key.endsWith('.summary')) return `${values?.notes} notes, ${values?.references} refs`
      if (key.endsWith('.more')) return `Show ${values?.count} more`
      if (key.endsWith('.showMore')) return `Show ${values?.count} more`
      if (key.endsWith('.sortBy')) return `Sort by ${values?.sort}`
      if (key.endsWith('.journalTitle')) return `Journal ${values?.date}`
      if (key.endsWith('.highlighted')) return `Highlighted: ${values?.text}`
      if (key.endsWith('.description')) return `Export ${values?.title}`
      return key.split('.').at(-1) ?? key
    }
  })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({
    getFixedT: () => (key: string) => key
  })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: mocks.openTab })
}))

vi.mock('@/services/inbox-service', () => ({
  inboxService: {
    snooze: mocks.snooze,
    markViewed: mocks.markViewed
  }
}))

vi.mock('@/hooks/use-inbox', () => ({
  inboxKeys: {
    lists: () => ['inbox', 'lists'],
    stats: () => ['inbox', 'stats']
  }
}))

vi.mock('@/components/snooze/snooze-picker', () => ({
  SnoozePicker: ({
    trigger,
    onSnooze,
    disabled
  }: {
    trigger: React.ReactNode
    onSnooze: (value: string) => void
    disabled?: boolean
  }) => (
    <div>
      {trigger}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onSnooze('2026-05-11T10:00:00.000Z')}
      >
        Custom snooze option
      </button>
    </div>
  )
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mocks.logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    exportPdf: mocks.exportPdf,
    exportHtml: mocks.exportHtml
  }
}))

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError
  }
}))

vi.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'dark' })
}))

vi.mock('@blocknote/react', () => ({
  useCreateBlockNote: () => ({
    document: [{ type: 'paragraph', content: 'First title' }],
    tryParseHTMLToBlocks: mocks.tryParseHTMLToBlocks,
    replaceBlocks: mocks.replaceBlocks,
    blocksToHTMLLossy: mocks.blocksToHTMLLossy
  })
}))

vi.mock('@blocknote/shadcn', () => ({
  BlockNoteView: ({
    onChange,
    editable,
    theme
  }: {
    onChange: () => void
    editable: boolean
    theme: string
  }) => (
    <div data-testid="blocknote-view" data-editable={String(editable)} data-theme={theme}>
      <div className="bn-editor">
        <div
          className="bn-block-content"
          contentEditable
          suppressContentEditableWarning
          onFocus={mocks.editorFocus}
        >
          Editor
        </div>
      </div>
      <button type="button" onClick={onChange}>
        Change content
      </button>
    </div>
  )
}))

vi.mock('@/lib/blocknote-title', () => ({
  extractTitleFromBlocks: mocks.extractTitleFromBlocks
}))

describe('major renderer gap surfaces', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T09:00:00.000Z'))
    vi.clearAllMocks()
    mocks.snooze.mockResolvedValue(undefined)
    mocks.markViewed.mockResolvedValue(undefined)
    mocks.exportPdf.mockResolvedValue({ success: true, path: '/tmp/note.pdf' })
    mocks.exportHtml.mockResolvedValue({ success: true, path: '/tmp/note.html' })
    mocks.tryParseHTMLToBlocks.mockReturnValue([{ type: 'paragraph', content: 'Parsed' }])
    mocks.blocksToHTMLLossy.mockReturnValue('<p>Saved</p>')
    mocks.extractTitleFromBlocks.mockReturnValue('First title')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders reminder metadata, navigates to sources, marks viewed, and snoozes reminders', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const item = {
      id: 'reminder-1',
      type: 'reminder',
      title: 'Remember highlight',
      content: null,
      createdAt: new Date().toISOString(),
      viewedAt: null,
      metadata: {
        targetType: 'highlight',
        targetId: 'note-1',
        targetTitle: 'Launch Plan',
        remindAt: '2026-05-10T12:00:00.000Z',
        reminderNote: 'Follow up',
        highlightStart: 5,
        highlightEnd: 12,
        highlightText: 'ship this'
      }
    }

    renderWithProviders(<ReminderDetail item={item as never} />)

    expect(screen.getByText('Follow up')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Launch Plan/ }))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'note',
        entityId: 'note-1',
        viewState: {
          highlightStart: 5,
          highlightEnd: 12,
          highlightText: 'ship this'
        }
      })
    )

    await user.click(screen.getByRole('button', { name: 'markViewed' }))
    await waitFor(() => expect(mocks.markViewed).toHaveBeenCalledWith('reminder-1'))
    expect(await screen.findByText('viewed')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'presetTomorrow' }))
    await waitFor(() =>
      expect(mocks.snooze).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'reminder-1' }))
    )

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Custom snooze option' })).not.toBeDisabled()
    )
    await user.click(screen.getByRole('button', { name: 'Custom snooze option' }))
    await waitFor(() =>
      expect(mocks.snooze).toHaveBeenLastCalledWith({
        itemId: 'reminder-1',
        snoozeUntil: '2026-05-11T10:00:00.000Z'
      })
    )
  })

  it('covers reminder missing metadata, journal navigation, and service failures', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { rerender } = renderWithProviders(
      <ReminderDetail item={{ id: 'no-meta', metadata: undefined } as never} />
    )
    expect(screen.getByText('dataUnavailable')).toBeInTheDocument()

    mocks.markViewed.mockRejectedValueOnce(new Error('offline'))
    rerender(
      <ReminderDetail
        item={
          {
            id: 'journal-reminder',
            viewedAt: null,
            metadata: {
              targetType: 'journal',
              targetId: '2026-05-10',
              remindAt: '2026-05-10T12:00:00.000Z'
            }
          } as never
        }
      />
    )

    await user.click(screen.getByRole('button', { name: /Journal/ }))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'journal', viewState: { date: '2026-05-10' } })
    )

    mocks.snooze.mockRejectedValueOnce(new Error('offline'))
    await user.click(screen.getByRole('button', { name: 'presetTomorrow' }))
    await waitFor(() =>
      expect(mocks.logError).toHaveBeenCalledWith('Failed to snooze reminder', expect.any(Error))
    )
  })

  it('sorts, expands, and selects backlinks with loading and empty states', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onBacklinkClick = vi.fn()
    const onSortChange = vi.fn()
    const backlinks = [
      {
        id: 'b',
        noteId: 'note-b',
        noteTitle: 'Beta',
        date: new Date('2026-05-08'),
        mentions: [
          { id: 'm1', snippet: 'Mentions [[Current]] once', linkStart: 9, linkEnd: 20 },
          { id: 'm2', snippet: 'Again [[Current]]', linkStart: 6, linkEnd: 17 }
        ]
      },
      {
        id: 'a',
        noteId: 'note-a',
        noteTitle: 'Alpha',
        date: new Date('2026-05-09'),
        mentions: [{ id: 'm3', snippet: 'Alpha [[Current]]', linkStart: 6, linkEnd: 17 }]
      },
      {
        id: 'c',
        noteId: 'note-c',
        noteTitle: 'Gamma',
        date: new Date('2026-05-07'),
        mentions: [{ id: 'm4', snippet: 'Gamma [[Current]]', linkStart: 6, linkEnd: 17 }]
      }
    ]

    const loading = render(<BacklinksSection isLoading />)
    expect(screen.getByText('loading')).toBeInTheDocument()
    loading.unmount()

    const empty = render(<BacklinksSection backlinks={[]} onBacklinkClick={onBacklinkClick} />)
    expect(empty.container).toBeEmptyDOMElement()
    empty.unmount()

    render(
      <BacklinksSection
        backlinks={backlinks}
        initialCount={1}
        onBacklinkClick={onBacklinkClick}
        onSortChange={onSortChange}
      />
    )

    await user.click(screen.getByRole('button', { name: /Sort by/ }))
    await user.click(screen.getByText('sortAlpha'))
    expect(onSortChange).toHaveBeenCalledWith('alphabetical')

    await user.click(screen.getByRole('link', { name: 'Alpha' }))
    expect(onBacklinkClick).toHaveBeenCalledWith('note-a', undefined)

    await user.click(screen.getByRole('button', { name: 'Show 2 more' }))
    expect(screen.getByText('Beta')).toBeInTheDocument()
    await user.click(screen.getByText(/Mentions/))
    expect(onBacklinkClick).toHaveBeenCalledWith('note-b', expect.objectContaining({ id: 'm1' }))

    await user.click(screen.getByRole('button', { name: 'collapseSection' }))
    expect(screen.queryByRole('list', { name: 'listAria' })).not.toBeInTheDocument()
  })

  it('exports notes as PDF and HTML, handles errors, escape, and delayed reset', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onOpenChange = vi.fn()
    const pdfDialog = renderWithProviders(
      <ExportDialog open onOpenChange={onOpenChange} noteId="note-1" noteTitle="Plan" />
    )

    await user.click(screen.getByRole('button', { name: 'export' }))
    await waitFor(() =>
      expect(mocks.exportPdf).toHaveBeenCalledWith({
        noteId: 'note-1',
        includeMetadata: true,
        pageSize: 'A4'
      })
    )
    expect(mocks.toastSuccess).toHaveBeenCalledWith('phaseI.toasts.noteExportedSuccessfully', {
      description: '/tmp/note.pdf'
    })
    act(() => vi.advanceTimersByTime(800))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    pdfDialog.unmount()
    act(() => vi.advanceTimersByTime(200))

    const htmlDialog = renderWithProviders(
      <ExportDialog open onOpenChange={onOpenChange} noteId="note-1" noteTitle="Plan" />
    )
    await user.click(screen.getByRole('radio', { name: /html/ }))
    await user.click(screen.getByRole('button', { name: 'export' }))
    await waitFor(() =>
      expect(mocks.exportHtml).toHaveBeenCalledWith({ noteId: 'note-1', includeMetadata: true })
    )
    htmlDialog.unmount()

    mocks.exportHtml.mockResolvedValueOnce({ success: false, error: 'No permission' })
    const failedHtmlDialog = renderWithProviders(
      <ExportDialog open onOpenChange={onOpenChange} noteId="note-1" noteTitle="Plan" />
    )
    await user.click(screen.getByRole('radio', { name: /html/ }))
    await user.click(screen.getByRole('button', { name: 'export' }))
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('failed', { description: 'No permission' })
    )
    failedHtmlDialog.unmount()

    renderWithProviders(
      <ExportDialog open onOpenChange={onOpenChange} noteId="note-1" noteTitle="Plan" />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('loads inbox editor content, reports changes, handles parse fallback, and focuses the editor', async () => {
    const onContentChange = vi.fn()
    const onTitleChange = vi.fn()
    const editorRender = render(
      <InboxContentEditor
        initialContent="<p>Hello</p>"
        onContentChange={onContentChange}
        onTitleChange={onTitleChange}
        placeholder="Write"
        className="extra"
      />
    )

    await waitFor(() =>
      expect(mocks.replaceBlocks).toHaveBeenCalledWith(
        [{ type: 'paragraph', content: 'First title' }],
        [{ type: 'paragraph', content: 'Parsed' }]
      )
    )
    expect(screen.getByTestId('blocknote-view')).toHaveAttribute('data-theme', 'dark')

    fireEvent.click(screen.getByRole('button', { name: 'Change content' }))
    expect(onTitleChange).toHaveBeenCalledWith('First title')
    expect(onContentChange).toHaveBeenCalledWith('<p>Saved</p>')

    fireEvent.mouseDown(screen.getByRole('region', { name: 'contentEditor' }))
    expect(mocks.editorFocus).toHaveBeenCalled()

    mocks.tryParseHTMLToBlocks.mockImplementationOnce(() => {
      throw new Error('not html')
    })
    editorRender.unmount()
    mocks.replaceBlocks.mockClear()
    render(<InboxContentEditor initialContent="Plain text" editable={false} />)
    await waitFor(() =>
      expect(mocks.replaceBlocks).toHaveBeenCalledWith(
        [{ type: 'paragraph', content: 'First title' }],
        [{ type: 'paragraph', content: 'Plain text' }]
      )
    )
    expect(screen.getByTestId('blocknote-view')).toHaveAttribute('data-editable', 'false')
  })

  it('restores inbox editor indentation from BlockNote nesting metadata', async () => {
    const parent = { type: 'paragraph', content: 'Parent', children: [] }
    const child = { type: 'paragraph', content: 'Child', children: [] }
    mocks.tryParseHTMLToBlocks.mockReturnValueOnce([parent, child])

    render(<InboxContentEditor initialContent='<p>Parent</p><p data-nesting-level="1">Child</p>' />)

    await waitFor(() =>
      expect(mocks.replaceBlocks).toHaveBeenCalledWith(
        [{ type: 'paragraph', content: 'First title' }],
        [{ ...parent, children: [{ ...child, children: [] }] }]
      )
    )
  })
})
