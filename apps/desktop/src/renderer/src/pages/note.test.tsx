import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@tests/utils/render'
import { NotePage } from './note'
import { toast } from 'sonner'
import { useEffect, useState } from 'react'
import type React from 'react'

const mocks = vi.hoisted(() => ({
  noteState: {
    note: null as Record<string, unknown> | null,
    isLoading: false,
    error: null as Error | null
  },
  refetchNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  renameNote: vi.fn(),
  deleteNote: vi.fn(),
  moveNote: vi.fn(),
  openTab: vi.fn(),
  closeTab: vi.fn(),
  setTabDeleted: vi.fn(),
  updateTabTitleByEntityId: vi.fn(),
  revealInFinder: vi.fn(),
  openExternal: vi.fn(),
  openSidebarItem: vi.fn(),
  invalidateQueries: vi.fn(),
  handleAddProperty: vi.fn(),
  handleDeleteProperty: vi.fn(),
  handlePropertyChange: vi.fn(),
  handlePropertyNameChange: vi.fn(),
  handlePropertyOrderChange: vi.fn(),
  propertyOnBlocked: null as
    ((action: 'update' | 'add' | 'remove' | 'rename' | 'reorder') => void) | null,
  setPropertiesCollapsed: vi.fn(),
  togglePropertiesCollapsed: vi.fn(),
  toggleBookmark: vi.fn(),
  setReminder: vi.fn(),
  setLocalOnly: vi.fn(),
  notesUpdate: vi.fn(),
  resolveWikiLink: vi.fn(),
  registerPendingSave: vi.fn(),
  unregisterPendingSave: vi.fn(),
  pickerOnValueChange: null as ((value: string) => void) | null,
  contentAreaMounts: 0,
  onDeleted: vi.fn(),
  onUpdated: vi.fn(),
  onRenamed: vi.fn(),
  deletedHandler: null as ((event: { id: string }) => void) | null,
  updatedHandler: null as
    ((event: { id: string; changes: Record<string, unknown>; source?: string }) => void) | null,
  renamedHandler: null as ((event: { id: string; newTitle: string }) => void) | null,
  findInPage: {
    isOpen: true,
    query: 'ship',
    matchCount: 2,
    currentIndex: 1,
    inputRef: { current: null },
    open: vi.fn(),
    setQuery: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    close: vi.fn()
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  // Keyless calls still render as the bare key; interpolated ones append their
  // values so a test can prove the caller actually passed them through.
  useT: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key
  })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries })
  }
})

vi.mock('@/hooks/use-notes-query', () => ({
  graphKeys: { local: (id: string) => ['graph', id] },
  notesKeys: { note: (id: string) => ['notes', 'note', id] },
  useNote: () => ({
    note: mocks.noteState.note,
    isLoading: mocks.noteState.isLoading,
    error: mocks.noteState.error,
    refetch: mocks.refetchNote
  }),
  useNoteMutations: () => ({
    createNote: { mutateAsync: mocks.createNote },
    updateNote: { mutateAsync: mocks.updateNote },
    renameNote: { mutateAsync: mocks.renameNote },
    deleteNote: { mutateAsync: mocks.deleteNote },
    moveNote: { mutateAsync: mocks.moveNote }
  }),
  useNoteLinksQuery: () => ({
    incoming: [
      {
        sourceId: 'backlink-1',
        sourceTitle: 'Backlink Note',
        sourcePath: 'notes/Work/backlink.md',
        contexts: [{ snippet: 'See [[Test Note]]', linkStart: 4, linkEnd: 17 }]
      },
      // Same sourceId as above, but referenced through a relation property
      // instead of a wikilink — must resolve to a different `id` (see
      // backlinkId in components/note/backlinks/types.ts).
      {
        sourceId: 'backlink-1',
        sourceTitle: 'Backlink Note',
        sourcePath: 'notes/Work/backlink.md',
        contexts: [],
        via: { kind: 'property', propertyName: 'father' }
      }
    ],
    isLoading: false
  }),
  useNoteTagsQuery: () => ({
    tags: [
      { tag: 'work', color: 'blue' },
      { tag: 'later', color: 'green' }
    ]
  })
}))

vi.mock('@/hooks/use-property-section', () => ({
  usePropertySection: ({
    onBlocked
  }: {
    onBlocked: (action: 'update' | 'add' | 'remove' | 'rename' | 'reorder') => void
  }) => {
    mocks.propertyOnBlocked = onBlocked
    return {
      properties: [{ id: 'p1', name: 'Status', value: 'Draft', type: 'text' }],
      newlyAddedPropertyId: null,
      handlePropertyChange: mocks.handlePropertyChange,
      handleAddProperty: mocks.handleAddProperty,
      handleDeleteProperty: mocks.handleDeleteProperty,
      handlePropertyNameChange: mocks.handlePropertyNameChange,
      handlePropertyOrderChange: mocks.handlePropertyOrderChange
    }
  }
}))

vi.mock('@/hooks/use-properties-collapsed', () => ({
  usePropertiesCollapsed: () => [
    false,
    mocks.togglePropertiesCollapsed,
    mocks.setPropertiesCollapsed
  ]
}))

vi.mock('@/hooks/use-tasks-linked-to-note', () => ({
  useTasksLinkedToNote: () => ({
    tasks: [{ id: 'task-1', title: 'Linked task', projectId: 'project-1' }],
    isLoading: false
  })
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    setLocalOnly: mocks.setLocalOnly,
    update: mocks.notesUpdate,
    revealInFinder: mocks.revealInFinder,
    openExternal: mocks.openExternal,
    // #800 getFile probe (note.tsx): null → treated as a real markdown note.
    getFile: vi.fn(async () => null)
  },
  onNoteDeleted: (handler: (event: { id: string }) => void) => {
    mocks.deletedHandler = handler
    mocks.onDeleted(handler)
    return vi.fn()
  },
  onNoteUpdated: (
    handler: (event: { id: string; changes: Record<string, unknown>; source?: string }) => void
  ) => {
    mocks.updatedHandler = handler
    mocks.onUpdated(handler)
    return vi.fn()
  },
  onNoteRenamed: (handler: (event: { id: string; newTitle: string }) => void) => {
    mocks.renamedHandler = handler
    mocks.onRenamed(handler)
    return vi.fn()
  }
}))

vi.mock('@/lib/wikilink-resolver', () => ({
  resolveWikiLink: mocks.resolveWikiLink
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    openTab: mocks.openTab,
    closeTab: mocks.closeTab,
    setTabDeleted: mocks.setTabDeleted,
    updateTabTitleByEntityId: mocks.updateTabTitleByEntityId
  }),
  useActiveTab: () => ({
    id: '/notes/note-1',
    entityId: 'note-1',
    viewState: { highlightText: 'Important', highlightStart: 1, highlightEnd: 10 }
  })
}))

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: mocks.openSidebarItem })
}))

vi.mock('@/hooks/use-note-reminders', () => ({
  useNoteReminders: () => ({
    hasActiveReminder: false,
    actions: { setReminder: mocks.setReminder }
  })
}))

vi.mock('@/hooks/use-bookmarks', () => ({
  useIsBookmarked: () => ({ isBookmarked: false, toggle: mocks.toggleBookmark })
}))

vi.mock('@/hooks/use-editor-settings', () => ({
  EDITOR_NORMAL_CONTENT_WIDTH: '640px',
  useEditorSettings: () => ({
    settings: { toolbarMode: 'floating', width: 'normal' }
  })
}))

vi.mock('@/hooks/use-find-in-page', () => ({
  useFindInPage: () => mocks.findInPage
}))

vi.mock('@/hooks/use-graph-data', () => ({
  graphKeys: { local: (id: string) => ['graph', id] }
}))

vi.mock('@/lib/save-registry', () => ({
  registerPendingSave: mocks.registerPendingSave,
  unregisterPendingSave: mocks.unregisterPendingSave
}))

vi.mock('@/components/note', () => ({
  NoteLayout: ({
    children,
    headings,
    actions,
    topBar,
    breadcrumb,
    stats,
    sideRail,
    marqueeZoneRef,
    onHeadingClick
  }: {
    children: React.ReactNode
    headings: Array<{ id: string }>
    actions: React.ReactNode
    topBar: React.ReactNode
    breadcrumb: React.ReactNode
    stats?: { wordCount?: number }
    sideRail?: React.ReactNode
    marqueeZoneRef: (element: HTMLDivElement | null) => void
    onHeadingClick: (id: string) => void
  }) => (
    <div>
      <div ref={marqueeZoneRef} data-testid="marquee-zone" />
      <div data-testid="heading-count">{headings.length}</div>
      <div data-testid="word-count">{stats?.wordCount}</div>
      <button type="button" onClick={() => onHeadingClick('heading-1')}>
        Jump heading
      </button>
      {topBar}
      {breadcrumb}
      {actions}
      {children}
      {sideRail}
    </div>
  ),
  ContentArea: ({
    initialContent,
    externalContentRevision,
    onMarkdownChange,
    onHeadingsChange,
    onLinkClick,
    onInternalLinkClick,
    onInlineTagsChange,
    focusAtEndRef
  }: {
    initialContent: string
    externalContentRevision?: number
    onMarkdownChange: (markdown: string) => void
    onHeadingsChange: (
      headings: Array<{ id: string; level: number; text: string; position: number }>
    ) => void
    onLinkClick: (href: string) => void
    onInternalLinkClick: (target: string) => void
    onInlineTagsChange: (tags: string[], origin: 'load' | 'edit') => void
    focusAtEndRef: React.MutableRefObject<(() => void) | null>
  }) => {
    const [content] = useState(initialContent)
    focusAtEndRef.current = mocks.refetchNote
    // Counting mounts (not renders) is the point: an update from elsewhere must
    // reach the live editor as a prop, never as a fresh editor instance.
    useEffect(() => {
      mocks.contentAreaMounts += 1
    }, [])
    return (
      <div>
        {/* frozen at mount — changes only when the editor is rebuilt */}
        <div data-testid="editor-content">{content}</div>
        {/* the live prop the editor re-reads when the revision moves */}
        <div data-testid="editor-live-content">{initialContent}</div>
        <div data-testid="editor-external-revision">
          {String(externalContentRevision ?? 'none')}
        </div>
        <div data-id="heading-1" />
        <button type="button" onClick={() => onMarkdownChange('# Changed')}>
          Change markdown
        </button>
        <button
          type="button"
          onClick={() =>
            onHeadingsChange([{ id: 'heading-1', level: 1, text: 'Intro', position: 0 }])
          }
        >
          Change headings
        </button>
        <button type="button" onClick={() => onLinkClick('https://memry.test')}>
          External link
        </button>
        <button type="button" onClick={() => onInternalLinkClick('Existing Note')}>
          Internal note link
        </button>
        <button type="button" onClick={() => onInternalLinkClick('Diagram.pdf')}>
          Internal file link
        </button>
        <button type="button" onClick={() => onInternalLinkClick('New Note')}>
          Internal create link
        </button>
        <button type="button" onClick={() => onInternalLinkClick('Missing.png')}>
          Internal missing file
        </button>
        {/* What opening the note reports: the tags the body already carried. */}
        <button type="button" onClick={() => onInlineTagsChange(['work'], 'load')}>
          Load inline tags
        </button>
        <button type="button" onClick={() => onInlineTagsChange(['Work'], 'load')}>
          Load cased inline tags
        </button>
        <button type="button" onClick={() => onInlineTagsChange(['work', 'urgent'], 'edit')}>
          Sync inline tags
        </button>
        <button type="button" onClick={() => onInlineTagsChange([], 'edit')}>
          Clear inline tags
        </button>
      </div>
    )
  }
}))

vi.mock('@/components/note/note-title', () => ({
  NoteTitle: ({
    title,
    onTitleChange
  }: {
    title: string
    onTitleChange: (title: string) => void
  }) => (
    <button type="button" onClick={() => onTitleChange('Renamed Note')}>
      {title}
    </button>
  )
}))

vi.mock('@/components/note/tags-row', () => ({
  TagsRow: ({
    tags,
    onAddTag,
    onCreateTag,
    onRemoveTag,
    onTagClick
  }: {
    tags: Array<{ id: string; name: string; color: string }>
    onAddTag: (id: string) => void
    onCreateTag: (name: string, color: string) => void
    onRemoveTag: (id: string) => void
    onTagClick: (tag: { name: string; color: string }) => void
  }) => (
    <div>
      <span>{tags.map((tag) => tag.name).join(',')}</span>
      <button type="button" onClick={() => onAddTag('later')}>
        Add tag
      </button>
      <button type="button" onClick={() => onCreateTag('urgent', 'red')}>
        Create tag
      </button>
      <button type="button" onClick={() => onRemoveTag('work')}>
        Remove tag
      </button>
      <button type="button" onClick={() => onTagClick({ name: 'work', color: 'blue' })}>
        Open tag
      </button>
    </div>
  )
}))

vi.mock('@/components/note/info-section', () => ({
  InfoSection: ({
    onToggleExpand,
    onAddProperty,
    onPropertyChange
  }: {
    onToggleExpand: () => void
    onAddProperty: (property: unknown) => void
    onPropertyChange: (id: string, value: unknown) => void
  }) => (
    <div>
      <button type="button" onClick={onToggleExpand}>
        Toggle properties
      </button>
      <button type="button" onClick={() => onAddProperty({ name: 'Mood', type: 'text' })}>
        Add property
      </button>
      <button type="button" onClick={() => onPropertyChange('p1', 'Done')}>
        Change property
      </button>
    </div>
  )
}))

vi.mock('@/components/note/ghost-affordance-row', () => ({
  GhostAffordanceRow: ({ onAddProperty }: { onAddProperty: (property: unknown) => void }) => (
    <button type="button" onClick={() => onAddProperty({ name: 'Ghost', type: 'text' })}>
      Ghost property
    </button>
  )
}))

vi.mock('@/components/note/backlinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/note/backlinks')>()),
  BacklinksSection: ({
    backlinks,
    onBacklinkClick
  }: {
    backlinks: { id: string }[]
    onBacklinkClick: (noteId: string, mention?: { snippet: string }) => void
  }) => (
    <div>
      <button
        type="button"
        onClick={() => onBacklinkClick('backlink-1', { snippet: '[[Test Note]]' })}
      >
        Open backlink
      </button>
      {backlinks.map((backlink) => (
        <span key={backlink.id} data-testid="backlink-id">
          {backlink.id}
        </span>
      ))}
    </div>
  )
}))

vi.mock('@/components/note/linked-tasks', () => ({
  LinkedTasksSection: ({ onTaskClick }: { onTaskClick: (id: string) => void }) => (
    <button type="button" onClick={() => onTaskClick('task-1')}>
      Open linked task
    </button>
  )
}))

vi.mock('@/components/reminder', () => ({
  ReminderPicker: ({
    trigger,
    onSelect
  }: {
    trigger: React.ReactNode
    onSelect: (date: Date) => void
  }) => (
    <div>
      {trigger}
      <button type="button" onClick={() => onSelect(new Date('2026-05-10'))}>
        Pick reminder
      </button>
    </div>
  )
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/picker', () => ({
  Picker: Object.assign(
    ({
      children,
      onValueChange
    }: {
      children: React.ReactNode
      onValueChange?: (value: string) => void
    }) => {
      mocks.pickerOnValueChange = onValueChange ?? null
      return <div>{children}</div>
    },
    {
      Trigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      List: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      Item: ({
        label,
        value,
        icon,
        trailing
      }: {
        label: string
        value: string
        icon?: React.ReactNode
        trailing?: React.ReactNode
      }) => (
        <button type="button" data-value={value} onClick={() => mocks.pickerOnValueChange?.(value)}>
          {icon}
          {label}
          {trailing}
        </button>
      ),
      Separator: () => <hr />
    }
  )
}))

vi.mock('@/components/ui/switch', () => ({
  Switch: () => <span data-testid="switch" />
}))

vi.mock('@/components/folder-view/move-to-folder-dialog', () => ({
  MoveToFolderDialog: ({
    open,
    noteIds,
    currentFolder,
    onMove
  }: {
    open: boolean
    noteIds: string[]
    currentFolder?: string
    onMove: (folder: string) => void
  }) =>
    open ? (
      <div data-testid="move-dialog">
        <span>{`move:${noteIds.join(',')}:${currentFolder ?? ''}`}</span>
        <button type="button" onClick={() => onMove('Work')}>
          Confirm move
        </button>
      </div>
    ) : null
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="delete-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogCancel: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  AlertDialogAction: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  )
}))

vi.mock('@/components/note/export-dialog', () => ({
  ExportDialog: ({ open, noteTitle }: { open: boolean; noteTitle: string }) =>
    open ? <div>Export {noteTitle}</div> : null
}))

vi.mock('@/components/note/version-history', () => ({
  VersionHistory: ({ open, noteTitle }: { open: boolean; noteTitle: string }) =>
    open ? <div>Version {noteTitle}</div> : null
}))

vi.mock('@/components/note/editor-error-boundary', () => ({
  EditorErrorBoundary: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/graph/local-graph-panel', () => ({
  LocalGraphPanel: ({
    onClose,
    onOpenFullGraph
  }: {
    onClose: () => void
    onOpenFullGraph: () => void
  }) => (
    <div>
      Local graph
      <button type="button" onClick={onClose}>
        Close local graph
      </button>
      <button type="button" onClick={onOpenFullGraph}>
        Open full graph
      </button>
    </div>
  )
}))

vi.mock('@/components/note/note-breadcrumb', () => ({
  NoteBreadcrumb: ({ noteTitle }: { noteTitle: string }) => <span>{noteTitle}</span>
}))

vi.mock('@/components/find-bar/find-bar', () => ({
  FindBar: ({
    onClose,
    onNext,
    onPrev
  }: {
    onClose: () => void
    onNext: () => void
    onPrev: () => void
  }) => (
    <div>
      <button type="button" onClick={onNext}>
        Find next
      </button>
      <button type="button" onClick={onPrev}>
        Find prev
      </button>
      <button type="button" onClick={onClose}>
        Close find
      </button>
    </div>
  )
}))

const note = {
  id: 'note-1',
  title: 'Test Note',
  path: 'notes/Test Note.md',
  content: 'Original body',
  tags: ['work'],
  frontmatter: { localOnly: false, fullWidth: false },
  wordCount: 2,
  created: new Date('2026-05-01'),
  modified: new Date('2026-05-09')
}

describe('NotePage', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    mocks.noteState.note = note
    mocks.noteState.isLoading = false
    mocks.noteState.error = null
    mocks.updateNote.mockResolvedValue({ success: true })
    mocks.renameNote.mockResolvedValue({ success: true })
    mocks.deleteNote.mockResolvedValue({ success: true })
    mocks.moveNote.mockResolvedValue({ success: true })
    mocks.revealInFinder.mockResolvedValue(undefined)
    mocks.openExternal.mockResolvedValue(undefined)
    mocks.createNote.mockResolvedValue({
      success: true,
      note: { id: 'created-note', title: 'New Note' }
    })
    mocks.setLocalOnly.mockResolvedValue({ success: true })
    mocks.notesUpdate.mockResolvedValue({ success: true })
    mocks.pickerOnValueChange = null
    mocks.propertyOnBlocked = null
    mocks.contentAreaMounts = 0
    Element.prototype.scrollIntoView = vi.fn()
    mocks.resolveWikiLink.mockImplementation((target: string) => {
      if (target === 'Existing Note')
        return Promise.resolve({ type: 'note', id: 'existing-note', title: 'Existing Note' })
      if (target === 'Diagram.pdf')
        return Promise.resolve({ type: 'file', id: 'file-1', title: 'Diagram.pdf', icon: 'file' })
      if (target === 'New Note') return Promise.resolve({ type: 'create' })
      return Promise.resolve({ type: 'not-found' })
    })
  })

  it('renders empty, loading, and error states', async () => {
    const { rerender } = renderWithProviders(<NotePage />)
    expect(screen.getByText('page.empty.title')).toBeInTheDocument()

    mocks.noteState.isLoading = true
    rerender(<NotePage noteId="note-1" />)
    expect(screen.queryByText('Test Note')).not.toBeInTheDocument()

    mocks.noteState.isLoading = false
    mocks.noteState.error = new Error('load failed')
    rerender(<NotePage noteId="note-1" />)
    expect(await screen.findByText('load failed')).toBeInTheDocument()
    fireEvent.click(screen.getByText('button.retry'))
    expect(mocks.refetchNote).toHaveBeenCalled()
  })

  it('saves title, tags, properties, backlinks, and linked task navigation', async () => {
    renderWithProviders(<NotePage noteId="note-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Test Note' }))
    expect(mocks.renameNote).toHaveBeenCalledWith({ id: 'note-1', newTitle: 'Renamed Note' })

    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }))
    expect(mocks.updateNote).toHaveBeenCalledWith({ id: 'note-1', tags: ['work', 'later'] })

    fireEvent.click(screen.getByRole('button', { name: 'Create tag' }))
    expect(mocks.updateNote).toHaveBeenCalledWith({ id: 'note-1', tags: ['work', 'urgent'] })

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag' }))
    expect(mocks.updateNote).toHaveBeenCalledWith({ id: 'note-1', tags: [] })

    fireEvent.click(screen.getByRole('button', { name: 'Open tag' }))
    expect(mocks.openSidebarItem).toHaveBeenCalledWith({
      type: 'tag',
      title: 'work',
      path: '/tags/work',
      entityId: 'work',
      color: 'blue'
    })

    fireEvent.click(screen.getByRole('button', { name: 'Add property' }))
    expect(mocks.setPropertiesCollapsed).toHaveBeenCalledWith(false)
    expect(mocks.handleAddProperty).toHaveBeenCalledWith({ name: 'Mood', type: 'text' })

    fireEvent.click(screen.getByRole('button', { name: 'Open backlink' }))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'backlink-1' })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open linked task' }))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tasks',
        viewState: expect.objectContaining({ openTaskId: 'task-1', selectedProjectId: 'project-1' })
      })
    )
  })

  it('assigns distinct backlink ids to a wikilink entry and a property entry sharing a sourceId', async () => {
    // Exercises the real page transform (only BacklinksSection itself is
    // mocked) — this is what actually computes `id` via backlinkId(). If the
    // transform reverted to `id: bl.sourceId` for every entry, both spans
    // below would carry the same text.
    renderWithProviders(<NotePage noteId="note-1" />)

    await screen.findByRole('button', { name: 'Test Note' })
    const ids = screen.getAllByTestId('backlink-id').map((el) => el.textContent)
    expect(ids).toEqual(['backlink-1', 'backlink-1:property:father'])
  })

  it('omits the review rail when there are no comments, keeping note controls', async () => {
    renderWithProviders(<NotePage noteId="note-1" />)

    expect(screen.queryByLabelText('comments.railAria')).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Add tag' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add property' })).toBeInTheDocument()
    expect(screen.getByTestId('editor-content')).toHaveTextContent('Original body')
  })

  it('debounces markdown saves and syncs inline tags', async () => {
    vi.useFakeTimers()
    renderWithProviders(<NotePage noteId="note-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'editor.toolbar.showLocalGraph' }))
    expect(screen.getByText('Local graph')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Change markdown' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(mocks.updateNote).toHaveBeenCalledWith({ id: 'note-1', content: '# Changed' })
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['graph', 'note-1'] })

    fireEvent.click(screen.getByRole('button', { name: 'Sync inline tags' }))
    await waitFor(() =>
      expect(mocks.updateNote).toHaveBeenCalledWith({ id: 'note-1', tags: ['work', 'urgent'] })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear inline tags' }))
    await waitFor(() => expect(mocks.updateNote).toHaveBeenCalledWith({ id: 'note-1', tags: [] }))
  })

  it('does not write the note when opening it reports its inline tags', async () => {
    // #given a note opened with `#work` in its body (#1454)
    renderWithProviders(<NotePage noteId="note-1" />)
    await screen.findByRole('button', { name: 'Load inline tags' })

    // #when the editor reports the tag set it loaded with
    fireEvent.click(screen.getByRole('button', { name: 'Load inline tags' }))
    await act(async () => {
      await Promise.resolve()
    })

    // #then nothing is persisted — opening a note may not modify it
    const tagWrites = mocks.updateNote.mock.calls.filter(
      ([input]) => (input as { tags?: string[] }).tags !== undefined
    )
    expect(tagWrites).toEqual([])
  })

  it('does not rewrite the note when a loaded tag differs only in case', async () => {
    // #given the index keeps the frontmatter spelling ('work') while the body
    // says '#Work'. Before the origin was threaded through, `tagsToAdd` saw
    // 'Work' as new and merely OPENING the note wrote tags: ['work', 'Work'].
    renderWithProviders(<NotePage noteId="note-1" />)
    await screen.findByRole('button', { name: 'Load cased inline tags' })

    // #when the editor reports what it loaded
    fireEvent.click(screen.getByRole('button', { name: 'Load cased inline tags' }))
    await act(async () => {
      await Promise.resolve()
    })

    // #then nothing is written — a load is not an edit
    expect(mocks.updateNote).not.toHaveBeenCalledWith(
      expect.objectContaining({ tags: expect.anything() })
    )
  })

  it('still removes a tag when the user deletes the last inline tag after opening', async () => {
    // #given a note opened with `#work` in its body, so the baseline is set by
    // the load report rather than by a write
    renderWithProviders(<NotePage noteId="note-1" />)
    await screen.findByRole('button', { name: 'Load inline tags' })
    fireEvent.click(screen.getByRole('button', { name: 'Load inline tags' }))

    // #when the user deletes it
    fireEvent.click(screen.getByRole('button', { name: 'Clear inline tags' }))

    // #then the tag comes off the note. Without the load baseline the page
    // would have no record of `work` ever being inline and would drop this.
    await waitFor(() => expect(mocks.updateNote).toHaveBeenCalledWith({ id: 'note-1', tags: [] }))
  })

  it('flushes pending markdown saves through the registry and unmount cleanup', async () => {
    vi.useFakeTimers()
    const first = renderWithProviders(<NotePage noteId="note-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Change markdown' }))
    const flush = mocks.registerPendingSave.mock.calls[0]?.[1] as (() => Promise<void>) | undefined
    await act(async () => {
      await flush?.()
    })

    expect(mocks.updateNote).toHaveBeenCalledWith({ id: 'note-1', content: '# Changed' })
    first.unmount()
    expect(mocks.unregisterPendingSave).toHaveBeenCalledWith('note-page:note-1')

    vi.clearAllMocks()
    mocks.updateNote.mockResolvedValue({ success: true })
    const second = renderWithProviders(<NotePage noteId="note-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Change markdown' }))
    second.unmount()

    expect(mocks.updateNote).toHaveBeenCalledWith({ id: 'note-1', content: '# Changed' })
    expect(mocks.unregisterPendingSave).toHaveBeenCalledWith('note-page:note-1')
  })

  it('handles toolbar actions, external links, headings, and marquee focus', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    renderWithProviders(<NotePage noteId="note-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Pick reminder' }))
    expect(mocks.setReminder).toHaveBeenCalledWith(new Date('2026-05-10'), undefined)

    fireEvent.click(screen.getByTitle('editor.toolbar.addBookmark'))
    expect(mocks.toggleBookmark).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'External link' }))
    expect(openSpy).toHaveBeenCalledWith('https://memry.test', '_blank', 'noopener,noreferrer')

    fireEvent.click(screen.getByRole('button', { name: 'Jump heading' }))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start'
    })

    mocks.refetchNote.mockClear()
    fireEvent.mouseDown(screen.getByTestId('marquee-zone'), { button: 0 })
    expect(mocks.refetchNote).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'editor.toolbar.showLocalGraph' }))
    expect(screen.getByText('Local graph')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open full graph' }))
    expect(mocks.openTab).toHaveBeenCalledWith(expect.objectContaining({ type: 'graph' }))

    fireEvent.click(screen.getByRole('button', { name: 'Close local graph' }))
    expect(screen.queryByText('Local graph')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'editor.toolbar.versionHistory' }))
    expect(screen.getByText('Version Test Note')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'editor.toolbar.export' }))
    expect(screen.getByText('Export Test Note')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'editor.toolbar.fullWidth' }))
    await waitFor(() =>
      expect(mocks.notesUpdate).toHaveBeenCalledWith({
        id: 'note-1',
        frontmatter: { fullWidth: true }
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'editor.toolbar.setLocalOnly' }))
    await waitFor(() => expect(mocks.setLocalOnly).toHaveBeenCalledWith('note-1', true))
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['notes', 'localOnlyCount'] })

    openSpy.mockRestore()
  })

  it('routes wiki links to notes, files, creation, and missing-file errors', async () => {
    renderWithProviders(<NotePage noteId="note-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Internal note link' }))
    await waitFor(() =>
      expect(mocks.openTab).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'note', entityId: 'existing-note' })
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'Internal file link' }))
    await waitFor(() =>
      expect(mocks.openTab).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'file', entityId: 'file-1' })
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'Internal create link' }))
    await waitFor(() =>
      expect(mocks.openTab).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'note', entityId: 'created-note' })
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'Internal missing file' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('page.toast.fileNotFound:{"target":"Missing.png"}')
    )

    mocks.createNote.mockResolvedValueOnce({ success: false })
    fireEvent.click(screen.getByRole('button', { name: 'Internal create link' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('page.toast.createLinkedFailed'))

    mocks.resolveWikiLink.mockRejectedValueOnce(new Error('resolve failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Internal note link' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('page.toast.openLinkedFailed'))
  })

  it('reacts to note events and find controls', async () => {
    renderWithProviders(<NotePage noteId="note-1" />)

    expect(mocks.registerPendingSave).toHaveBeenCalledWith('note-page:note-1', expect.any(Function))

    await screen.findByRole('button', { name: 'Find next' })

    act(() => {
      mocks.deletedHandler?.({ id: 'note-1' })
      mocks.renamedHandler?.({ id: 'note-1', newTitle: 'Remote title' })
      mocks.updatedHandler?.({
        id: 'note-1',
        source: 'external',
        changes: { content: 'Remote body' }
      })
    })

    expect(mocks.setTabDeleted).toHaveBeenCalledWith('note-1', true)
    expect(mocks.updateTabTitleByEntityId).toHaveBeenCalledWith('note-1', 'Remote title')

    fireEvent.click(screen.getByRole('button', { name: 'Find next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Find prev' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close find' }))
    expect(mocks.findInPage.next).toHaveBeenCalled()
    expect(mocks.findInPage.prev).toHaveBeenCalled()
    expect(mocks.findInPage.close).toHaveBeenCalled()
  })

  // Was "remounts the editor for agent-driven note content updates". The update
  // still has to become visible; it must now do so through the live editor
  // instead of destroying and rebuilding it. `editor-content` is frozen at mount,
  // so it staying stale while `editor-live-content` moves is exactly the proof.
  it('hands an agent-driven content update to the live editor instead of remounting it', async () => {
    renderWithProviders(<NotePage noteId="note-1" />)
    expect(await screen.findByTestId('editor-content')).toHaveTextContent('Original body')
    expect(mocks.contentAreaMounts).toBe(1)

    act(() => {
      mocks.updatedHandler?.({
        id: 'note-1',
        source: 'internal',
        changes: { content: 'Agent edited body' }
      })
    })

    expect(screen.getByTestId('editor-live-content')).toHaveTextContent('Agent edited body')
    expect(screen.getByTestId('editor-external-revision')).toHaveTextContent('1')
    expect(mocks.contentAreaMounts).toBe(1)
  })

  it('hands an on-disk external content update to the live editor without remounting', async () => {
    renderWithProviders(<NotePage noteId="note-1" />)
    expect(await screen.findByTestId('editor-content')).toHaveTextContent('Original body')
    expect(mocks.contentAreaMounts).toBe(1)

    act(() => {
      mocks.updatedHandler?.({
        id: 'note-1',
        source: 'external',
        changes: { content: 'Edited on disk' }
      })
    })

    expect(screen.getByTestId('editor-live-content')).toHaveTextContent('Edited on disk')
    expect(screen.getByTestId('editor-external-revision')).toHaveTextContent('1')
    expect(mocks.contentAreaMounts).toBe(1)
  })

  // The other direction: a local edit round-tripping through the save path must
  // not look like an external update. `handleMarkdownChange` stamps
  // `lastSavedContent`, so the echoed event is dropped — no revision bump, no
  // reload, nothing to clobber what the user is typing.
  it('does not bump the editor revision for a note update echoing a local save', async () => {
    renderWithProviders(<NotePage noteId="note-1" />)
    await screen.findByTestId('editor-content')

    fireEvent.click(screen.getByRole('button', { name: 'Change markdown' }))
    // handleMarkdownChange debounces the save by a real 1000ms before it stamps
    // lastSavedContent, which is what makes the echo recognisable.
    await waitFor(() => expect(mocks.updateNote).toHaveBeenCalled(), { timeout: 3000 })
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      mocks.updatedHandler?.({
        id: 'note-1',
        source: 'internal',
        changes: { content: '# Changed' }
      })
    })

    expect(screen.getByTestId('editor-external-revision')).toHaveTextContent('0')
    expect(mocks.contentAreaMounts).toBe(1)
  })

  // The CRDT write-back fires 500ms after any Y.Doc change — including local
  // typing, ahead of the 1000ms save — and it now carries `content`. Remounting
  // on it would destroy the editor mid-keystroke, and the IPC CRDT provider has
  // already applied those bytes anyway.
  it('does not remount the editor for CRDT write-back updates', async () => {
    renderWithProviders(<NotePage noteId="note-1" />)
    expect(await screen.findByTestId('editor-content')).toHaveTextContent('Original body')

    act(() => {
      mocks.updatedHandler?.({
        id: 'note-1',
        source: 'sync',
        changes: { content: 'Write-back body' }
      })
    })

    expect(screen.getByTestId('editor-content')).toHaveTextContent('Original body')
    expect(screen.getByTestId('editor-external-revision')).toHaveTextContent('0')
    expect(mocks.contentAreaMounts).toBe(1)
  })

  it('blocks mutations after the note is deleted', async () => {
    renderWithProviders(<NotePage noteId="note-1" />)

    await screen.findByRole('button', { name: 'Test Note' })

    act(() => {
      mocks.deletedHandler?.({ id: 'note-1' })
    })

    vi.clearAllMocks()
    mocks.updateNote.mockResolvedValue({ success: true })
    mocks.renameNote.mockResolvedValue({ success: true })

    fireEvent.click(screen.getByRole('button', { name: 'Test Note' }))
    expect(mocks.renameNote).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('page.toast.cannotRenameDeleted')

    fireEvent.click(screen.getByRole('button', { name: 'Change markdown' }))
    expect(mocks.updateNote).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('page.toast.cannotSaveDeleted')

    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create tag' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag' }))
    expect(mocks.updateNote).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('phaseI.toasts.cannotAddTagThisNoteWasDeleted')
    expect(toast.error).toHaveBeenCalledWith('phaseI.toasts.cannotRemoveTagThisNoteWasDeleted')

    fireEvent.click(screen.getByRole('button', { name: 'editor.toolbar.setLocalOnly' }))
    expect(mocks.setLocalOnly).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith(
      'phaseI.toasts.cannotChangeLocalOnlyThisNoteWasDeleted'
    )

    fireEvent.click(screen.getByRole('button', { name: 'editor.toolbar.fullWidth' }))
    expect(mocks.notesUpdate).not.toHaveBeenCalled()

    act(() => {
      mocks.propertyOnBlocked?.('remove')
    })
    expect(toast.error).toHaveBeenCalledWith('Cannot delete property - this note was deleted')
  })

  describe('note-view menu file actions', () => {
    it('opens find in page from the menu', async () => {
      renderWithProviders(<NotePage noteId="note-1" />)
      fireEvent.click(await screen.findByRole('button', { name: 'editor.toolbar.find' }))
      expect(mocks.findInPage.open).toHaveBeenCalled()
    })

    it('copies the vault-relative path to the clipboard', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })

      renderWithProviders(<NotePage noteId="note-1" />)
      fireEvent.click(await screen.findByRole('button', { name: 'editor.toolbar.copyPath' }))

      await waitFor(() => expect(writeText).toHaveBeenCalledWith('notes/Test Note.md'))
      expect(toast.success).toHaveBeenCalledWith('page.toast.pathCopied')
    })

    it('reveals the note in the OS file manager', async () => {
      renderWithProviders(<NotePage noteId="note-1" />)
      fireEvent.click(await screen.findByRole('button', { name: 'editor.toolbar.revealInFinder' }))
      await waitFor(() => expect(mocks.revealInFinder).toHaveBeenCalledWith('note-1'))
    })

    it('opens the note in the default app', async () => {
      renderWithProviders(<NotePage noteId="note-1" />)
      fireEvent.click(
        await screen.findByRole('button', { name: 'editor.toolbar.openInDefaultApp' })
      )
      await waitFor(() => expect(mocks.openExternal).toHaveBeenCalledWith('note-1'))
    })

    it('dispatches a reveal-in-sidebar event', async () => {
      const listener = vi.fn()
      window.addEventListener('reveal-in-sidebar', listener)
      renderWithProviders(<NotePage noteId="note-1" />)

      fireEvent.click(await screen.findByRole('button', { name: 'editor.toolbar.revealInSidebar' }))

      expect(listener).toHaveBeenCalledTimes(1)
      const event = listener.mock.calls[0][0] as CustomEvent
      expect(event.detail).toEqual({ path: '/notes/note-1', entityId: 'note-1' })
      window.removeEventListener('reveal-in-sidebar', listener)
    })

    it('moves the note to a folder via the dialog', async () => {
      renderWithProviders(<NotePage noteId="note-1" />)

      // Dialog is closed until the menu item is chosen
      expect(screen.queryByTestId('move-dialog')).not.toBeInTheDocument()

      fireEvent.click(await screen.findByRole('button', { name: 'editor.toolbar.moveToFolder' }))
      const dialog = screen.getByTestId('move-dialog')
      // current folder is derived from the note path
      expect(dialog).toHaveTextContent('move:note-1:notes')

      fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))
      await waitFor(() =>
        expect(mocks.moveNote).toHaveBeenCalledWith({ id: 'note-1', newFolder: 'Work' })
      )
      expect(toast.success).toHaveBeenCalledWith('page.toast.moved')
    })

    it('deletes the note after confirmation and closes its tab', async () => {
      renderWithProviders(<NotePage noteId="note-1" />)

      // Confirmation not shown until the delete item is chosen
      expect(screen.queryByTestId('delete-dialog')).not.toBeInTheDocument()

      fireEvent.click(await screen.findByRole('button', { name: 'editor.toolbar.delete' }))
      expect(screen.getByTestId('delete-dialog')).toBeInTheDocument()
      // Nothing deleted just by opening the dialog
      expect(mocks.deleteNote).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'page.deleteConfirm.confirm' }))
      await waitFor(() => expect(mocks.deleteNote).toHaveBeenCalledWith('note-1'))
      expect(mocks.closeTab).toHaveBeenCalledWith('/notes/note-1')
    })

    it('does not delete when the delete op reports failure', async () => {
      mocks.deleteNote.mockResolvedValueOnce({ success: false, error: 'nope' })
      renderWithProviders(<NotePage noteId="note-1" />)

      fireEvent.click(await screen.findByRole('button', { name: 'editor.toolbar.delete' }))
      fireEvent.click(screen.getByRole('button', { name: 'page.deleteConfirm.confirm' }))

      await waitFor(() => expect(mocks.deleteNote).toHaveBeenCalledWith('note-1'))
      expect(mocks.closeTab).not.toHaveBeenCalled()
      expect(toast.error).toHaveBeenCalledWith('nope')
    })

    it('surfaces an error toast when copy path fails', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('clipboard blocked'))
      Object.assign(navigator, { clipboard: { writeText } })

      renderWithProviders(<NotePage noteId="note-1" />)
      fireEvent.click(await screen.findByRole('button', { name: 'editor.toolbar.copyPath' }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('clipboard blocked'))
    })

    it('surfaces an error toast when reveal in Finder fails', async () => {
      mocks.revealInFinder.mockRejectedValueOnce(new Error('reveal failed'))
      renderWithProviders(<NotePage noteId="note-1" />)

      fireEvent.click(await screen.findByRole('button', { name: 'editor.toolbar.revealInFinder' }))
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('reveal failed'))
    })

    it('surfaces an error toast when open in default app fails', async () => {
      mocks.openExternal.mockRejectedValueOnce(new Error('open failed'))
      renderWithProviders(<NotePage noteId="note-1" />)

      fireEvent.click(
        await screen.findByRole('button', { name: 'editor.toolbar.openInDefaultApp' })
      )
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('open failed'))
    })

    it('surfaces an error toast when the move op reports failure', async () => {
      mocks.moveNote.mockResolvedValueOnce({ success: false, error: 'move blocked' })
      renderWithProviders(<NotePage noteId="note-1" />)

      fireEvent.click(await screen.findByRole('button', { name: 'editor.toolbar.moveToFolder' }))
      fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('move blocked'))
    })

    it('surfaces an error toast when delete throws', async () => {
      mocks.deleteNote.mockRejectedValueOnce(new Error('delete crashed'))
      renderWithProviders(<NotePage noteId="note-1" />)

      fireEvent.click(await screen.findByRole('button', { name: 'editor.toolbar.delete' }))
      fireEvent.click(screen.getByRole('button', { name: 'page.deleteConfirm.confirm' }))

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('delete crashed'))
      expect(mocks.closeTab).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // Large-file class: an explanation, never an empty editor
  // ==========================================================================

  describe('large-file class', () => {
    it('opens the read-only viewer instead of mounting an empty editor', async () => {
      // #given a note the main process classified as large-file: no body was
      // delivered, so mounting the editor would show a blank document
      mocks.noteState.note = {
        ...note,
        content: '',
        contentOmitted: true,
        sizeClass: 'large-file',
        largeFile: { reason: 'file-bytes', fileBytes: 18_700_000, largestBlockBytes: null }
      }

      // #when
      renderWithProviders(<NotePage noteId="note-1" />)

      // #then — the read-only viewer is what the user sees, quoting the file
      // size against the byte ceiling...
      const viewer = await screen.findByTestId('large-file-viewer')
      expect(viewer).toHaveTextContent('page.largeFile.reason.fileBytes')
      expect(viewer).toHaveTextContent('17.8 MB')
      // ...and the editor never mounted, so there is no empty document to mistake
      // for data loss
      expect(mocks.contentAreaMounts).toBe(0)
      expect(screen.queryByTestId('editor-content')).not.toBeInTheDocument()
    })

    it('names the block bound when that is what the file broke', async () => {
      // #given the log-dump shape: under the byte ceiling, one giant block
      mocks.noteState.note = {
        ...note,
        content: '',
        contentOmitted: true,
        sizeClass: 'large-file',
        largeFile: { reason: 'block-bytes', fileBytes: 900_000, largestBlockBytes: 890_000 }
      }

      // #when
      renderWithProviders(<NotePage noteId="note-1" />)

      // #then — the reason has to name the block bound, or "too large" reads as
      // a lie for a file well under the byte ceiling. The test i18n renders keys
      // rather than English, so the key and its interpolation are the assertion.
      const viewer = await screen.findByTestId('large-file-viewer')
      expect(viewer).toHaveTextContent('page.largeFile.reason.blockBytes')
      expect(viewer).not.toHaveTextContent('page.largeFile.reason.fileBytes')
      // the size quoted is the offending block, not the whole file
      expect(viewer).toHaveTextContent('869.1 KB')
      // and the badge rides along, so a read-only file never looks editable
      expect(viewer).toHaveTextContent('page.largeFile.badge')
    })

    it('still mounts the editor for an ordinary note', async () => {
      // #given the default note, which carries no sizeClass at all — the shape
      // every existing vault produces
      renderWithProviders(<NotePage noteId="note-1" />)

      // #then
      expect(await screen.findByTestId('editor-content')).toBeInTheDocument()
      expect(screen.queryByTestId('large-file-viewer')).not.toBeInTheDocument()
      expect(mocks.contentAreaMounts).toBe(1)
    })
  })
})
