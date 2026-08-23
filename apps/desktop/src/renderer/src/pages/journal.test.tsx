import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { JournalPage } from './journal'
import React from 'react'

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  activeTab: {
    type: 'journal',
    viewState: { date: '2026-01-15' }
  } as any,
  openSettingsModal: vi.fn(),
  updateContent: vi.fn(),
  updateTags: vi.fn(),
  forceReload: vi.fn(),
  retrySave: vi.fn(),
  dismissSaveError: vi.fn(),
  toggleBookmark: vi.fn(),
  resolveWikiLink: vi.fn(),
  handlePropertyChange: vi.fn(),
  handleAddProperty: vi.fn(),
  handleDeleteProperty: vi.fn(),
  handlePropertyNameChange: vi.fn(),
  handlePropertyOrderChange: vi.fn(),
  setPropertiesCollapsed: vi.fn(),
  togglePropertiesCollapsed: vi.fn(),
  saveError: null as string | null,
  entryError: null as string | null,
  externalUpdateCount: 0,
  contentAreaMounts: 0,
  entry: {
    id: 'j2026-01-15',
    date: '2026-01-15',
    content: '# Today',
    tags: ['work'],
    wordCount: 2,
    characterCount: 7,
    createdAt: '2026-01-15T08:00:00.000Z',
    modifiedAt: '2026-01-15T09:00:00.000Z'
  } as any,
  findInPage: {
    isOpen: true,
    query: 'today',
    matchCount: 1,
    currentIndex: 0,
    inputRef: { current: null },
    setQuery: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    close: vi.fn()
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string, values?: Record<string, unknown>) => values?.target ?? key })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(() => 'toast-id'),
    info: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/contexts/tabs', () => ({
  // The page reads its date off ITS OWN tab now, not off the globally active
  // one, so the mocked session has to actually contain the tab.
  useTabs: () => ({
    openTab: mocks.openTab,
    state: {
      tabGroups: { 'group-1': { tabs: [{ id: 'tab-1', ...mocks.activeTab }] } }
    }
  }),
  useActiveTab: () => mocks.activeTab,
  useTabActionsOptional: () => null
}))

vi.mock('@/contexts/tabs/tab-identity', () => ({
  useTabIdentity: () => ({ tabId: 'tab-1', groupId: 'group-1' })
}))

vi.mock('@/contexts/settings-modal-context', () => ({
  useSettingsModal: () => ({ open: mocks.openSettingsModal })
}))

vi.mock('@/hooks/use-journal', () => ({
  useJournalEntry: () => ({
    entry: mocks.entry,
    isLoading: false,
    loadedForDate: mocks.activeTab.viewState?.date ?? '2026-01-15',
    error: mocks.entryError,
    saveError: mocks.saveError,
    externalUpdateCount: mocks.externalUpdateCount,
    updateContent: mocks.updateContent,
    updateTags: mocks.updateTags,
    forceReload: mocks.forceReload,
    retrySave: mocks.retrySave,
    dismissSaveError: mocks.dismissSaveError
  }),
  useJournalHeatmap: () => ({ data: [{ date: '2026-01-15', level: 2 }] }),
  useMonthEntries: () => ({
    data: [{ date: '2026-01-15', preview: 'Today', characterCount: 7 }]
  }),
  useYearStats: () => ({
    data: [{ month: 1, entryCount: 1, totalCharacterCount: 7, averageLevel: 2 }]
  })
}))

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteLinksQuery: () => ({
    incoming: [
      {
        sourceId: 'note-1',
        sourceTitle: 'Source Note',
        sourcePath: 'notes/Work/source.md',
        contexts: [{ snippet: 'See [[journal]]', linkStart: 4, linkEnd: 15 }]
      },
      {
        sourceId: 'j2026-01-14',
        sourceTitle: 'Yesterday',
        sourcePath: 'notes/Journal/2026-01-14.md',
        contexts: []
      },
      // Same sourceId as the first entry, but referenced through a relation
      // property instead of a wikilink — the two must resolve to different
      // `id`s (see backlinkId in components/note/backlinks/types.ts), or
      // BacklinksSection would key two sibling cards identically.
      {
        sourceId: 'note-1',
        sourceTitle: 'Source Note',
        sourcePath: 'notes/Work/source.md',
        contexts: [],
        via: { kind: 'property', propertyName: 'father' }
      }
    ],
    isLoading: false
  }),
  useNoteTagsQuery: () => ({
    tags: [
      { tag: 'work', color: 'blue' },
      { tag: 'life', color: 'red' }
    ]
  }),
  useNoteMutations: () => ({
    createNote: { mutateAsync: vi.fn() }
  })
}))

vi.mock('@/hooks/use-active-heading', () => ({
  useActiveHeading: () => ({ activeHeadingId: 'h1' })
}))

vi.mock('@/hooks/use-properties-collapsed', () => ({
  usePropertiesCollapsed: () => [
    false,
    mocks.togglePropertiesCollapsed,
    mocks.setPropertiesCollapsed
  ]
}))

vi.mock('@/hooks/use-property-section', () => ({
  usePropertySection: () => ({
    properties: [
      { id: 'p-date', name: 'date', value: '2026-01-15', type: 'date' },
      { id: 'p-mood', name: 'mood', value: 'focused', type: 'text' }
    ],
    newlyAddedPropertyId: null,
    handlePropertyChange: mocks.handlePropertyChange,
    handleAddProperty: mocks.handleAddProperty,
    handleDeleteProperty: mocks.handleDeleteProperty,
    handlePropertyNameChange: mocks.handlePropertyNameChange,
    handlePropertyOrderChange: mocks.handlePropertyOrderChange
  })
}))

vi.mock('@/hooks/use-journal-settings', () => ({
  useJournalSettings: () => ({ settings: { showStatsFooter: true }, isLoading: false })
}))

vi.mock('@/hooks/use-editor-settings', () => ({
  EDITOR_NORMAL_CONTENT_WIDTH: '640px',
  useEditorSettings: () => ({ settings: { toolbarMode: 'sticky', width: 'normal' } })
}))

vi.mock('@/hooks/use-bookmarks', () => ({
  useIsBookmarked: () => ({ isBookmarked: false, toggle: mocks.toggleBookmark })
}))

vi.mock('@/hooks/use-find-in-page', () => ({
  useFindInPage: () => mocks.findInPage
}))

vi.mock('@/lib/wikilink-resolver', () => ({
  resolveWikiLink: mocks.resolveWikiLink
}))

vi.mock('@/components/find-bar/find-bar', () => ({
  FindBar: ({ query, onQueryChange, onNext, onPrev, onClose }: any) => (
    <div data-testid="find-bar">
      {query}
      <button onClick={() => onQueryChange('next')}>query</button>
      <button onClick={onNext}>next match</button>
      <button onClick={onPrev}>prev match</button>
      <button onClick={onClose}>close find</button>
    </div>
  )
}))

vi.mock('@/components/journal', () => ({
  JournalErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  JournalBreadcrumb: ({
    onMonthClick,
    onYearClick,
    onTodayClick,
    onPreviousDay,
    onNextDay
  }: any) => (
    <div data-testid="breadcrumb">
      <button onClick={onPreviousDay}>prev day</button>
      <button onClick={onNextDay}>next day</button>
      <button onClick={() => onMonthClick(2026, 0)}>month</button>
      <button onClick={() => onYearClick(2026)}>year</button>
      <button onClick={onTodayClick}>today</button>
    </div>
  ),
  JournalHeaderActions: ({
    onPrevious,
    onNext,
    onToggleFullWidth,
    onBookmarkToggle,
    onVersionHistory,
    onExport,
    onOpenSettings
  }: any) => (
    <div data-testid="header-actions">
      <button onClick={onPrevious}>header prev</button>
      <button onClick={onNext}>header next</button>
      <button onClick={onToggleFullWidth}>width</button>
      <button onClick={onBookmarkToggle}>bookmark</button>
      <button onClick={onVersionHistory}>history</button>
      <button onClick={onExport}>export</button>
      <button onClick={onOpenSettings}>settings</button>
    </div>
  ),
  JournalDateDisplay: ({ viewState }: any) => (
    <div data-testid="date-display">{viewState.type}</div>
  ),
  JournalStatsFooter: ({ wordCount, characterCount }: any) => (
    <div data-testid="stats-footer">
      {wordCount}:{characterCount}
    </div>
  ),
  JournalMonthView: ({ year, month, onDayClick }: any) => (
    <div data-testid="month-view">
      {year}:{month}
      <button onClick={() => onDayClick('2026-01-20')}>open day</button>
    </div>
  ),
  JournalYearView: ({ year, onMonthClick }: any) => (
    <div data-testid="year-view">
      {year}
      <button onClick={() => onMonthClick(2)}>open month</button>
    </div>
  )
}))

vi.mock('@/components/note', () => ({
  ContentArea: ({
    initialContent,
    placeholder,
    externalContentRevision,
    onMarkdownChange,
    onLinkClick,
    onInternalLinkClick,
    onHeadingsChange,
    focusAtEndRef
  }: any) => {
    focusAtEndRef.current = vi.fn()
    // Counting mounts (not renders) is the whole point: an external update must
    // reach the live editor as a prop, never as a fresh editor instance.
    React.useEffect(() => {
      mocks.contentAreaMounts += 1
    }, [])
    return (
      <div
        data-testid="content-area"
        data-external-revision={String(externalContentRevision ?? 'none')}
      >
        {initialContent}:{placeholder}
        <div
          data-testid="blocknote-editor"
          contentEditable
          suppressContentEditableWarning
          tabIndex={0}
        >
          BlockNote editor
        </div>
        <button onClick={() => onMarkdownChange('updated')}>edit markdown</button>
        <button onClick={() => onLinkClick('https://memry.test')}>external link</button>
        <button onClick={() => onInternalLinkClick('Linked Note')}>internal link</button>
        <button onClick={() => onInternalLinkClick('#Intro')}>same-entry heading link</button>
        <button
          onClick={() => onHeadingsChange([{ id: 'h1', level: 1, text: 'Intro', position: 0 }])}
        >
          headings
        </button>
        {/* The heading block, as BlockNote renders it: inside the editor, not
            loose in the document. Both jump paths look it up through the page's
            own container ref, so a node outside it must NOT be found. */}
        <div data-id="h1">Intro</div>
      </div>
    )
  }
}))

vi.mock('@/components/note/backlinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/note/backlinks')>()),
  BacklinksSection: ({ backlinks, onBacklinkClick }: any) => (
    <div data-testid="backlinks">
      {backlinks.map((backlink: any) => (
        <button
          key={backlink.id}
          data-id={backlink.id}
          onClick={() => onBacklinkClick(backlink.noteId)}
        >
          {backlink.noteTitle}
        </button>
      ))}
    </div>
  )
}))

vi.mock('@/components/note/tags-row', () => ({
  TagsRow: ({ tags, onAddTag, onCreateTag, onRemoveTag }: any) => (
    <div data-testid="tags-row">
      {tags.map((tag: any) => tag.name).join(',')}
      <button onClick={() => onAddTag('life')}>add tag</button>
      <button onClick={() => onCreateTag('new', 'green')}>create tag</button>
      <button onClick={() => onRemoveTag('work')}>remove tag</button>
    </div>
  )
}))

vi.mock('@/components/note/info-section', () => ({
  InfoSection: ({ properties, onAddProperty, onToggleExpand }: any) => (
    <div data-testid="info-section">
      {properties.map((property: any) => property.name).join(',')}
      <button onClick={() => onAddProperty({ name: 'energy', type: 'text' })}>add property</button>
      <button onClick={onToggleExpand}>collapse props</button>
    </div>
  )
}))

vi.mock('@/components/note/ghost-affordance-row', () => ({
  GhostAffordanceRow: ({ onAddTag, onCreateTag, onAddProperty }: any) => (
    <div data-testid="ghost-row">
      <button onClick={() => onAddTag('life')}>ghost tag</button>
      <button onClick={() => onCreateTag('ghost', 'stone')}>ghost create</button>
      <button onClick={() => onAddProperty({ name: 'focus', type: 'text' })}>ghost prop</button>
    </div>
  )
}))

vi.mock('@/components/shared', () => ({
  OutlineInfoPanel: ({ headings, onHeadingClick, activeHeadingId, stats }: any) => (
    <div data-testid="outline">
      {activeHeadingId}:{stats?.wordCount}
      {headings.map((heading: any) => (
        <button key={heading.id} onClick={() => onHeadingClick(heading.id)}>
          {heading.text}
        </button>
      ))}
    </div>
  )
}))

vi.mock('@/components/note/export-dialog', () => ({
  ExportDialog: ({ open, noteTitle }: any) => (
    <div data-testid="export-dialog">{open ? noteTitle : 'closed export'}</div>
  )
}))

vi.mock('@/components/note/version-history', () => ({
  VersionHistory: ({ open, onRestore }: any) => (
    <div data-testid="version-history">
      {open ? 'open history' : 'closed history'}
      <button onClick={onRestore}>restore version</button>
    </div>
  )
}))

describe('JournalPage', () => {
  /** Every element `scrollIntoView` was called on, in order. */
  let scrolledInto: Element[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    scrolledInto = []
    mocks.activeTab = { type: 'journal', viewState: { date: '2026-01-15' } }
    mocks.saveError = null
    mocks.entryError = null
    mocks.externalUpdateCount = 0
    mocks.contentAreaMounts = 0
    mocks.entry = { ...mocks.entry, id: 'j2026-01-15', date: '2026-01-15', content: '# Today' }
    mocks.resolveWikiLink.mockResolvedValue({ type: 'note', id: 'note-2', title: 'Linked Note' })
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => 'false'),
      setItem: vi.fn()
    })
    // Same block id as the in-pane heading, deliberately outside the editor
    // container and earlier in the document — this is what the other pane of a
    // split view looks like. An unscoped `document.querySelector` finds THIS
    // one, so the tests below check which element was scrolled, not just that
    // something was.
    document.body.innerHTML = '<div data-id="h1" data-outside-pane></div>'
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolledInto.push(this)
    })
  })

  it('hands an external update to the live editor instead of remounting it', () => {
    const { rerender } = render(<JournalPage />)

    expect(screen.getByTestId('content-area')).toHaveTextContent('# Today')
    expect(mocks.contentAreaMounts).toBe(1)

    // A sync/agent/on-disk edit lands: useJournalEntry swaps the entry and bumps
    // externalUpdateCount.
    mocks.entry = { ...mocks.entry, content: '# Edited elsewhere' }
    mocks.externalUpdateCount = 1
    rerender(<JournalPage />)

    // The new content must be visible...
    expect(screen.getByTestId('content-area')).toHaveTextContent('# Edited elsewhere')
    expect(screen.getByTestId('content-area')).toHaveAttribute('data-external-revision', '1')
    // ...without throwing away the editor instance.
    expect(mocks.contentAreaMounts).toBe(1)
  })

  it('renders the day editor and drives tags, properties, backlinks, and links', async () => {
    render(<JournalPage />)

    expect(screen.getByTestId('content-area')).toHaveTextContent('# Today')
    expect(screen.getByTestId('tags-row')).toHaveTextContent('work')
    expect(screen.getByTestId('info-section')).toHaveTextContent('mood')
    expect(screen.getByTestId('stats-footer')).toHaveTextContent('2:7')

    fireEvent.click(screen.getByText('edit markdown'))
    expect(mocks.updateContent).toHaveBeenCalledWith('updated')

    fireEvent.click(screen.getByText('add tag'))
    fireEvent.click(screen.getByText('create tag'))
    fireEvent.click(screen.getByText('remove tag'))
    expect(mocks.updateTags).toHaveBeenCalledWith(['work', 'life'])
    expect(mocks.updateTags).toHaveBeenCalledWith(['work', 'new'])
    expect(mocks.updateTags).toHaveBeenCalledWith([])

    fireEvent.click(screen.getByText('add property'))
    expect(mocks.setPropertiesCollapsed).toHaveBeenCalledWith(false)
    expect(mocks.handleAddProperty).toHaveBeenCalledWith({ name: 'energy', type: 'text' })

    fireEvent.click(screen.getAllByText('Source Note')[0])
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'note-1' })
    )

    fireEvent.click(screen.getByText('Yesterday'))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'journal', viewState: { date: '2026-01-14' } })
    )

    fireEvent.click(screen.getByText('internal link'))
    await waitFor(() =>
      expect(mocks.openTab).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'note', entityId: 'note-2' })
      )
    )

    fireEvent.click(screen.getByText('headings'))
    fireEvent.click(screen.getByRole('button', { name: 'Intro' }))
    // The outline scrolls THIS pane's block, not the node with the same id
    // sitting earlier in the document.
    expect(scrolledInto).toHaveLength(1)
    expect(scrolledInto[0]?.hasAttribute('data-outside-pane')).toBe(false)
  })

  it('jumps to a heading inside the entry for [[#Heading]] instead of opening a tab', () => {
    render(<JournalPage />)

    // The editor has to have emitted its headings first — the link carries the
    // heading's TEXT, and only `onHeadingsChange` maps that to a block id.
    fireEvent.click(screen.getByText('headings'))
    fireEvent.click(screen.getByText('same-entry heading link'))

    expect(scrolledInto).toHaveLength(1)
    expect(scrolledInto[0]?.hasAttribute('data-outside-pane')).toBe(false)
    // No lookup, no tab: `[[#Heading]]` addresses the entry it is written in.
    expect(mocks.resolveWikiLink).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('leaves a [[#Heading]] naming no heading in the entry inert', () => {
    render(<JournalPage />)

    // Headings never emitted, so the page has no block id for "Intro". The
    // target still must not fall through to a note lookup — `#Intro` names no
    // note, and resolving it would open (or offer to create) one.
    fireEvent.click(screen.getByText('same-entry heading link'))
    expect(scrolledInto).toHaveLength(0)
    expect(mocks.resolveWikiLink).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('assigns distinct backlink ids to a wikilink entry and a property entry sharing a sourceId', () => {
    // Exercises the real page transform (only BacklinksSection itself is
    // mocked) — this is what actually computes `id` via backlinkId(). If the
    // transform reverted to `id: bl.sourceId` for every entry, both buttons
    // below would carry the same data-id.
    render(<JournalPage />)

    const sourceNoteButtons = screen.getAllByText('Source Note').map((el) => el.closest('button'))
    const ids = sourceNoteButtons.map((button) => button?.getAttribute('data-id'))

    expect(ids).toEqual(['note-1', 'note-1:property:father'])
  })

  it('navigates month and year views and header actions', () => {
    render(<JournalPage />)

    fireEvent.click(screen.getByText('header prev'))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'journal', viewState: { date: '2026-01-14' } })
    )

    fireEvent.click(screen.getByText('header next'))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'journal', viewState: { date: '2026-01-16' } })
    )

    fireEvent.click(screen.getByText('month'))
    expect(screen.getByTestId('month-view')).toHaveTextContent('2026:0')
    fireEvent.click(screen.getByText('header prev'))
    expect(screen.getByTestId('month-view')).toHaveTextContent('2025:11')
    fireEvent.click(screen.getByText('header next'))
    expect(screen.getByTestId('month-view')).toHaveTextContent('2026:0')

    fireEvent.click(screen.getByText('open day'))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'journal', viewState: { date: '2026-01-20' } })
    )

    fireEvent.click(screen.getByText('year'))
    expect(screen.getByTestId('year-view')).toHaveTextContent('2026')
    fireEvent.click(screen.getByText('header prev'))
    expect(screen.getByTestId('year-view')).toHaveTextContent('2025')
    fireEvent.click(screen.getByText('header next'))
    expect(screen.getByTestId('year-view')).toHaveTextContent('2026')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'journal', viewState: { date: '2026-01-15' } })
    )

    fireEvent.click(screen.getByText('year'))
    fireEvent.click(screen.getByText('open month'))
    expect(screen.getByTestId('month-view')).toHaveTextContent('2026:2')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByTestId('year-view')).toHaveTextContent('2026')

    fireEvent.click(screen.getByText('width'))
    fireEvent.click(screen.getByText('bookmark'))
    fireEvent.click(screen.getByText('settings'))
    expect(localStorage.setItem).toHaveBeenCalledWith('memry_journal_full_width', 'true')
    expect(mocks.toggleBookmark).toHaveBeenCalled()
    expect(mocks.openSettingsModal).toHaveBeenCalledWith('journal')
  })

  it('navigates day view with arrow keys after BlockNote loses focus', () => {
    render(<JournalPage />)

    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'journal', viewState: { date: '2026-01-14' } })
    )

    fireEvent.keyDown(document, { key: 'ArrowRight' })
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'journal', viewState: { date: '2026-01-16' } })
    )

    mocks.openTab.mockClear()
    const blocknoteEditor = screen.getByTestId('blocknote-editor')
    blocknoteEditor.focus()
    expect(document.activeElement).toBe(blocknoteEditor)

    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(mocks.openTab).not.toHaveBeenCalled()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).not.toBe(blocknoteEditor)

    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'journal', viewState: { date: '2026-01-14' } })
    )
  })

  it('routes external links and every wiki-link resolution branch', async () => {
    const { toast } = await import('sonner')
    const open = vi.fn()
    vi.stubGlobal('open', open)
    mocks.resolveWikiLink
      .mockResolvedValueOnce({
        type: 'file',
        id: 'file-1',
        title: 'Plan.pdf',
        icon: 'file'
      })
      .mockResolvedValueOnce({ type: 'create', title: 'Linked Note' })
      .mockResolvedValueOnce({ type: 'not-found' })
      .mockRejectedValueOnce(new Error('resolver failed'))

    render(<JournalPage />)

    fireEvent.click(screen.getByText('external link'))
    expect(open).toHaveBeenCalledWith('https://memry.test', '_blank', 'noopener,noreferrer')

    fireEvent.click(screen.getByText('internal link'))
    await waitFor(() =>
      expect(mocks.openTab).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'file', entityId: 'file-1' })
      )
    )

    // The old dead-end "not found" toast is now the create-confirm dialog
    // (#1716); Cancel leaves everything as it was.
    fireEvent.click(screen.getByText('internal link'))
    expect(await screen.findByText('wikiLinkCreateDialog.body')).toBeInTheDocument()
    fireEvent.click(screen.getByText('button.cancel'))
    await waitFor(() =>
      expect(screen.queryByText('wikiLinkCreateDialog.body')).not.toBeInTheDocument()
    )
    expect(toast.info).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('internal link'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Linked Note'))

    fireEvent.click(screen.getByText('internal link'))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('toast.openLinkedItemFailed'))
  })

  it('shows entry errors, save retry toast, export, history, and find controls', async () => {
    const { toast } = await import('sonner')
    mocks.entryError = 'Load failed'
    mocks.saveError = 'Save failed'

    render(<JournalPage />)

    expect(screen.getByText(/Load failed/)).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith(
      'Save failed',
      expect.objectContaining({ description: 'toast.unsavedRetry' })
    )

    fireEvent.click(screen.getByText('query'))
    fireEvent.click(screen.getByText('next match'))
    fireEvent.click(screen.getByText('prev match'))
    fireEvent.click(screen.getByText('close find'))
    expect(mocks.findInPage.setQuery).toHaveBeenCalledWith('next')
    expect(mocks.findInPage.next).toHaveBeenCalled()
    expect(mocks.findInPage.prev).toHaveBeenCalled()
    expect(mocks.findInPage.close).toHaveBeenCalled()

    fireEvent.click(screen.getByText('export'))
    expect(screen.getByTestId('export-dialog')).not.toHaveTextContent('closed export')

    fireEvent.click(screen.getByText('history'))
    expect(screen.getByTestId('version-history')).toHaveTextContent('open history')

    fireEvent.click(screen.getByText('restore version'))
    await waitFor(() => expect(mocks.forceReload).toHaveBeenCalled())
  })
})
