import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { FolderViewPage } from './folder-view'
import type React from 'react'

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  closeTab: vi.fn(),
  getActiveTab: vi.fn(),
  activeTab: { id: 'tab-1' } as { id: string } | null,
  openSidebarItem: vi.fn(),
  setDensity: vi.fn(),
  setFolderIcon: vi.fn(),
  createNote: vi.fn(),
  moveNote: vi.fn(),
  deleteNote: vi.fn(),
  refresh: vi.fn(),
  removeNotesOptimistically: vi.fn(),
  updateNoteProperty: vi.fn(),
  updateNoteTags: vi.fn(),
  setActiveViewIndex: vi.fn(),
  updateView: vi.fn(),
  addView: vi.fn(),
  deleteView: vi.fn(),
  renameView: vi.fn(),
  setViewAsDefault: vi.fn(),
  updateColumns: vi.fn(),
  updateSorting: vi.fn(),
  updateFilters: vi.fn(),
  updateDisplayName: vi.fn(),
  updateSummaryConfig: vi.fn(),
  toggleShowSummaries: vi.fn(),
  updateGroupBy: vi.fn(),
  addFormula: vi.fn(),
  updateFormula: vi.fn(),
  deleteFormula: vi.fn(),
  renameTag: vi.fn(async () => ({ success: true })),
  updateTagIcon: vi.fn(async () => ({ success: true })),
  deleteTag: vi.fn(async () => ({ success: true })),
  renamedHandler: null as ((event: { oldName: string; newName: string }) => void) | null,
  deletedHandler: null as ((event: { tag: string }) => void) | null,
  folderState: {
    isLoading: false,
    error: null as string | null,
    folderNotFound: false,
    activeView: null as unknown,
    notes: [] as unknown[]
  }
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string, values?: Record<string, unknown>) => values?.count ?? key })
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({
    openTab: mocks.openTab,
    closeTab: mocks.closeTab,
    getActiveTab: mocks.getActiveTab
  }),
  useActiveTab: () => mocks.activeTab
}))

vi.mock('@/services/tags-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/tags-service')>()
  return {
    ...actual,
    tagsService: {
      ...actual.tagsService,
      renameTag: mocks.renameTag,
      updateTagIcon: mocks.updateTagIcon,
      deleteTag: mocks.deleteTag
    },
    onTagRenamed: (handler: (event: { oldName: string; newName: string }) => void) => {
      mocks.renamedHandler = handler
      return vi.fn()
    },
    onTagDeleted: (handler: (event: { tag: string }) => void) => {
      mocks.deletedHandler = handler
      return vi.fn()
    }
  }
})

vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: mocks.openSidebarItem })
}))

vi.mock('@/hooks/use-display-density', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-display-density')>()),
  useDisplayDensity: () => ({ density: 'comfortable', setDensity: mocks.setDensity })
}))

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({ tags: [{ tag: 'work', color: 'blue' }] }),
  useNoteFoldersQuery: () => ({ folders: [], setFolderIcon: mocks.setFolderIcon }),
  useNoteMutations: () => ({ createNote: { mutateAsync: mocks.createNote } })
}))

vi.mock('@/components/folder-view/folder-emoji-chip', () => ({
  FolderEmojiChip: () => <div data-testid="folder-emoji-chip" />
}))

vi.mock('@/services/notes-service', () => ({
  notesService: {
    move: mocks.moveNote,
    delete: mocks.deleteNote
  }
}))

vi.mock('@/hooks/use-folder-view', () => ({
  useFolderView: () => ({
    views: [{ id: 'default', name: 'Default' }],
    activeViewIndex: 0,
    activeView:
      mocks.folderState.activeView ??
      ({
        id: 'default',
        name: 'Default',
        columns: [{ id: 'title', displayName: 'Title', width: 150 }],
        order: [],
        showSummaries: false
      } as unknown),
    notes: mocks.folderState.notes,
    totalNotes: mocks.folderState.notes.length,
    unfilteredCount: mocks.folderState.notes.length,
    isLoading: mocks.folderState.isLoading,
    error: mocks.folderState.error,
    folderNotFound: mocks.folderState.folderNotFound,
    setActiveViewIndex: mocks.setActiveViewIndex,
    updateView: mocks.updateView,
    addView: mocks.addView,
    deleteView: mocks.deleteView,
    renameView: mocks.renameView,
    setViewAsDefault: mocks.setViewAsDefault,
    updateColumns: mocks.updateColumns,
    updateSorting: mocks.updateSorting,
    updateFilters: mocks.updateFilters,
    updateDisplayName: mocks.updateDisplayName,
    updateSummaryConfig: mocks.updateSummaryConfig,
    toggleShowSummaries: mocks.toggleShowSummaries,
    updateGroupBy: mocks.updateGroupBy,
    availableProperties: [{ name: 'rating', type: 'rating' }],
    builtInColumns: [{ id: 'title', displayName: 'Title' }],
    formulas: [],
    formulasMap: {},
    summaries: {},
    addFormula: mocks.addFormula,
    updateFormula: mocks.updateFormula,
    deleteFormula: mocks.deleteFormula,
    refresh: mocks.refresh,
    removeNotesOptimistically: mocks.removeNotesOptimistically,
    updateNoteProperty: mocks.updateNoteProperty,
    updateNoteTags: mocks.updateNoteTags
  })
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  )
}))

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: (props: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-testid="skeleton" {...props} />
  )
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuCheckboxItem: ({
    children,
    onCheckedChange
  }: {
    children: React.ReactNode
    onCheckedChange: () => void
  }) => (
    <button type="button" onClick={onCheckedChange}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onClick
  }: {
    children: React.ReactNode
    onClick?: () => void
  }) => (
    <button type="button" role="menuitem" onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({
    children,
    onClick
  }: {
    children: React.ReactNode
    onClick: () => void
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  )
}))

vi.mock('@/components/folder-view/folder-view-empty-state', () => ({
  FolderViewEmptyState: ({
    variant,
    onRetry,
    onGoBack
  }: {
    variant: string
    onRetry?: () => void
    onGoBack?: () => void
  }) => (
    <div>
      <span>{variant}</span>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Retry folder
        </button>
      )}
      {onGoBack && (
        <button type="button" onClick={onGoBack}>
          Go back folder
        </button>
      )}
    </div>
  )
}))

vi.mock('@/components/folder-view/column-selector', () => ({
  ColumnSelector: ({
    onColumnsChange,
    onSearchChange,
    onFormulaAdd,
    onSummaryChange
  }: {
    onColumnsChange: (columns: unknown) => void
    onSearchChange: (value: string) => void
    onFormulaAdd: (formula: unknown) => void
    onSummaryChange: (summary: unknown) => void
  }) => (
    <div>
      <button type="button" onClick={() => onSearchChange('title')}>
        Search columns
      </button>
      <button type="button" onClick={() => onColumnsChange([])}>
        Change columns
      </button>
      <button type="button" onClick={() => onFormulaAdd({ id: 'f1' })}>
        Add formula
      </button>
      <button type="button" onClick={() => onSummaryChange({ title: 'count' })}>
        Change summary
      </button>
    </div>
  )
}))

vi.mock('@/components/folder-view/filter-builder', () => ({
  FilterBuilder: ({
    onFiltersChange,
    lockedCondition
  }: {
    onFiltersChange: (filters: unknown) => void
    lockedCondition?: { label: string; color?: string }
  }) => (
    <div>
      {lockedCondition && <span data-testid="locked-condition">{lockedCondition.label}</span>}
      <button type="button" onClick={() => onFiltersChange({ op: 'and', conditions: [] })}>
        Change filters
      </button>
    </div>
  )
}))

vi.mock('@/components/folder-view/group-by-selector', () => ({
  GroupBySelector: ({ onGroupByChange }: { onGroupByChange: (groupBy: unknown) => void }) => (
    <button type="button" onClick={() => onGroupByChange({ columnId: 'rating' })}>
      Group folder
    </button>
  )
}))

vi.mock('@/components/folder-view/sort-selector', () => ({
  SortSelector: ({ onSortingChange }: { onSortingChange: (order: unknown) => void }) => (
    <button
      type="button"
      onClick={() => onSortingChange([{ property: 'title', direction: 'asc' }])}
    >
      Sort header
    </button>
  )
}))

vi.mock('@/components/folder-view/view-switcher', () => ({
  ViewSwitcher: ({
    onViewChange,
    onAddView,
    onUpdateView,
    onSetViewAsDefault,
    onDeleteView
  }: {
    onViewChange: (index: number) => void
    onAddView: () => void
    onUpdateView: (id: string, updates: unknown) => void
    onSetViewAsDefault: (id: string) => void
    onDeleteView: (id: string) => void
  }) => (
    <div>
      <button type="button" onClick={() => onViewChange(0)}>
        Pick view
      </button>
      <button type="button" onClick={onAddView}>
        Add view
      </button>
      <button type="button" onClick={() => onUpdateView('default', { name: 'Renamed' })}>
        Rename view
      </button>
      <button type="button" onClick={() => onSetViewAsDefault('default')}>
        Default view
      </button>
      <button type="button" onClick={() => onDeleteView('default')}>
        Delete view
      </button>
    </div>
  )
}))

vi.mock('@/components/folder-view/folder-table-view', () => ({
  FolderTableView: ({
    notes,
    onNoteOpen,
    onOpenInNewTab,
    onFolderClick,
    onTagClick,
    onTagRemove,
    onPropertyUpdate,
    onSortingChange,
    onDisplayNameChange,
    onDelete,
    onMoveToFolder,
    onCreateNote,
    onClearAll,
    onSelectionChange
  }: {
    notes: Array<{ id: string; title: string }>
    onNoteOpen: (id: string) => void
    onOpenInNewTab: (id: string) => void
    onFolderClick: (path: string) => void
    onTagClick: (tag: string) => void
    onTagRemove: (id: string, tag: string) => void
    onPropertyUpdate: (id: string, property: string, value: unknown) => void
    onSortingChange: (sort: unknown) => void
    onDisplayNameChange: (id: string, name: string) => void
    onDelete: (ids: string[]) => void
    onMoveToFolder: (ids: string[]) => void
    onCreateNote: () => void
    onClearAll: () => void
    onSelectionChange: (selection: Set<string>) => void
  }) => (
    <div>
      <span>{notes[0]?.title}</span>
      <button type="button" onClick={() => onNoteOpen('note-1')}>
        Open note
      </button>
      <button type="button" onClick={() => onNoteOpen('task-1')}>
        Open task row
      </button>
      <button type="button" onClick={() => onNoteOpen('inbox-1')}>
        Open inbox row
      </button>
      <button type="button" onClick={() => onOpenInNewTab('note-1')}>
        Open note new tab
      </button>
      <button type="button" onClick={() => onFolderClick('/Child')}>
        Open child folder
      </button>
      <button type="button" onClick={() => onTagClick('work')}>
        Open tag
      </button>
      <button type="button" onClick={() => onTagRemove('note-1', 'work')}>
        Remove tag
      </button>
      <button type="button" onClick={() => onTagRemove('task-1', 'work')}>
        Remove tag on task row
      </button>
      <button type="button" onClick={() => onTagRemove('inbox-1', 'work')}>
        Remove tag on inbox row
      </button>
      <button type="button" onClick={() => onPropertyUpdate('note-1', 'rating', 5)}>
        Update property
      </button>
      <button type="button" onClick={() => onSortingChange([{ id: 'title' }])}>
        Sort folder
      </button>
      <button type="button" onClick={() => onDisplayNameChange('title', 'Name')}>
        Rename column
      </button>
      <button type="button" onClick={() => onSelectionChange(new Set(['note-1']))}>
        Select note
      </button>
      <button type="button" onClick={() => onSelectionChange(new Set(['note-1', 'task-1']))}>
        Select mixed rows
      </button>
      <button type="button" onClick={() => onSelectionChange(new Set(['note-1', 'note-2']))}>
        Select two notes
      </button>
      <button type="button" onClick={() => onDelete(['note-1'])}>
        Delete note
      </button>
      <button type="button" onClick={() => onMoveToFolder(['note-1'])}>
        Move note
      </button>
      <button type="button" onClick={onCreateNote}>
        Create table note
      </button>
      <button type="button" onClick={onClearAll}>
        Clear table filters
      </button>
    </div>
  )
}))

vi.mock('@/components/folder-view/grouped-table', () => ({
  GroupedTable: (props: {
    notes: Array<{ id: string; title: string }>
    onNoteOpen: (id: string) => void
  }) => (
    <div>
      <span>Grouped {props.notes[0]?.title}</span>
      <button type="button" onClick={() => props.onNoteOpen('note-1')}>
        Open grouped note
      </button>
    </div>
  )
}))

vi.mock('@/components/folder-view/move-to-folder-dialog', () => ({
  MoveToFolderDialog: ({ open, onMove }: { open: boolean; onMove: (folder: string) => void }) =>
    open ? (
      <button type="button" onClick={() => onMove('Archive')}>
        Confirm move
      </button>
    ) : null
}))

vi.mock('@/components/folder-view/bulk-action-bar', () => ({
  BulkActionBar: ({
    scope,
    selectedRows,
    count,
    onDelete,
    onMove,
    onAddTag,
    onClear
  }: {
    scope?: { kind: string }
    selectedRows?: Array<{ id: string; kind?: string }>
    count: number
    onDelete: () => void
    onMove: () => void
    onAddTag: (tag: string) => void
    onClear: () => void
  }) => (
    <div>
      <span data-testid="bulk-scope-kind">{scope?.kind ?? ''}</span>
      <span data-testid="bulk-selected-rows">{JSON.stringify(selectedRows ?? [])}</span>
      <span data-testid="bulk-count">{count}</span>
      <button type="button" onClick={onDelete}>
        Bulk delete
      </button>
      <button type="button" onClick={onMove}>
        Bulk move
      </button>
      <button type="button" onClick={() => onAddTag('urgent')}>
        Bulk add tag
      </button>
      <button type="button" onClick={onClear}>
        Clear bulk selection
      </button>
    </div>
  )
}))

const note = {
  id: 'note-1',
  title: 'Folder Note',
  emoji: 'x',
  tags: ['work']
}

// Task/inbox rows, as `NoteWithProperties` looks under tag scope (`kind`
// absent means 'note' — see use-folder-view.ts).
const taskRow = {
  id: 'task-1',
  title: 'Tag Task',
  emoji: null,
  tags: ['work'],
  kind: 'task' as const
}

const inboxRow = {
  id: 'inbox-1',
  title: 'Tag Inbox Item',
  emoji: null,
  tags: ['work'],
  kind: 'inbox' as const
}

// A second plain note row, used to prove a selection that stays fully
// visible across a filter change is left alone (pruning must not be
// over-eager).
const secondNote = {
  id: 'note-2',
  title: 'Second Folder Note',
  emoji: null,
  tags: ['work']
}

describe('FolderViewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.folderState.isLoading = false
    mocks.folderState.error = null
    mocks.folderState.folderNotFound = false
    mocks.folderState.activeView = null
    mocks.folderState.notes = [note]
    mocks.getActiveTab.mockReturnValue({ id: 'folder-tab' })
    mocks.activeTab = { id: 'tab-1' }
    mocks.renamedHandler = null
    mocks.deletedHandler = null
    mocks.createNote.mockResolvedValue({
      success: true,
      note: { id: 'new-note', title: 'Untitled' }
    })
    mocks.moveNote.mockResolvedValue({ success: true })
    mocks.deleteNote.mockResolvedValue({ success: true })
  })

  it('drives the standard folder table workflows', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'folder', path: 'Work/Plans' }} />)

    expect(screen.getByText('Plans')).toBeInTheDocument()
    expect(screen.getByText('Folder Note')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open note' }))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'note-1', title: 'Folder Note' })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open child folder' }))
    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'folder', entityId: 'Work/Plans/Child' })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open tag' }))
    expect(mocks.openSidebarItem).toHaveBeenCalledWith({
      type: 'tag',
      title: 'work',
      path: '/tags/work',
      entityId: 'work',
      color: 'blue'
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag' }))
    expect(mocks.updateNoteTags).toHaveBeenCalledWith('note-1', [])

    fireEvent.click(screen.getByRole('button', { name: 'Update property' }))
    expect(mocks.updateNoteProperty).toHaveBeenCalledWith('note-1', 'rating', 5)

    fireEvent.click(screen.getByRole('button', { name: 'Create table note' }))
    await waitFor(() =>
      expect(mocks.createNote).toHaveBeenCalledWith({ title: 'Untitled', folder: 'Work/Plans' })
    )
    await waitFor(() =>
      expect(mocks.openTab).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'note', entityId: 'new-note' })
      )
    )

    fireEvent.click(screen.getByRole('button', { name: 'Clear table filters' }))
    expect(mocks.updateFilters).toHaveBeenCalledWith(undefined)
  })

  it('drives view toolbar and destructive dialogs', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'folder', path: 'Work/Plans' }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add view' }))
    expect(mocks.addView).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Change columns' }))
    expect(mocks.updateColumns).toHaveBeenCalledWith([])

    fireEvent.click(screen.getByRole('button', { name: 'Add formula' }))
    expect(mocks.addFormula).toHaveBeenCalledWith({ id: 'f1' })

    fireEvent.click(screen.getByRole('button', { name: 'Delete note' }))
    fireEvent.click(screen.getByRole('button', { name: 'button.delete' }))
    await waitFor(() => expect(mocks.removeNotesOptimistically).toHaveBeenCalledWith(['note-1']))
    expect(mocks.deleteNote).toHaveBeenCalledWith('note-1')

    fireEvent.click(screen.getByRole('button', { name: 'Move note' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm move' }))
    await waitFor(() => expect(mocks.moveNote).toHaveBeenCalledWith('note-1', 'Archive'))
  })

  it('renders grouped, loading, error, and not-found states', async () => {
    mocks.folderState.activeView = {
      id: 'grouped',
      name: 'Grouped',
      columns: [{ id: 'title', displayName: 'Title', width: 150 }],
      groupBy: { columnId: 'rating' },
      showSummaries: false
    }
    const { rerender } = renderWithProviders(
      <FolderViewPage scope={{ kind: 'folder', path: 'Work' }} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open grouped note' }))
    expect(mocks.openTab).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'note-1' }))

    mocks.folderState.activeView = null
    mocks.folderState.isLoading = true
    rerender(<FolderViewPage scope={{ kind: 'folder', path: 'Work' }} />)
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0)

    mocks.folderState.isLoading = false
    mocks.folderState.error = 'No folder'
    rerender(<FolderViewPage scope={{ kind: 'folder', path: 'Work' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry folder' }))
    expect(mocks.refresh).toHaveBeenCalled()

    mocks.folderState.error = null
    mocks.folderState.folderNotFound = true
    rerender(<FolderViewPage scope={{ kind: 'folder', path: 'Work' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Go back folder' }))
    expect(mocks.closeTab).toHaveBeenCalledWith('folder-tab')
  })
})

describe('FolderViewPage tag scope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.folderState.isLoading = false
    mocks.folderState.error = null
    mocks.folderState.folderNotFound = false
    mocks.folderState.activeView = null
    mocks.folderState.notes = [note]
    mocks.activeTab = { id: 'tab-1' }
    mocks.renamedHandler = null
    mocks.deletedHandler = null
    mocks.createNote.mockResolvedValue({
      success: true,
      note: { id: 'new-note', title: 'Untitled' }
    })
  })

  it('renders the tag chip and item count instead of a breadcrumb', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)
    expect(await screen.findByText('araba')).toBeInTheDocument()
  })

  it('still renders a folder breadcrumb under folder scope', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'folder', path: 'projects' }} />)
    expect(await screen.findByText('projects')).toBeInTheDocument()
  })

  it('segments a hierarchical tag into its parts', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba/lastik' }} />)
    expect(await screen.findByText('araba')).toBeInTheDocument()
    expect(screen.getByText('lastik')).toBeInTheDocument()
  })

  it('closes the tab when the tag is renamed from another window', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)
    await screen.findByText('araba')

    mocks.renamedHandler?.({ oldName: 'araba', newName: 'oto' })

    await waitFor(() => expect(mocks.closeTab).toHaveBeenCalledWith('tab-1'))
  })

  it('does not close the tab when a different tag is renamed', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)
    await screen.findByText('araba')

    mocks.renamedHandler?.({ oldName: 'other', newName: 'oto' })

    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  it('closes the tab when the tag is deleted from another window', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)
    await screen.findByText('araba')

    mocks.deletedHandler?.({ tag: 'araba' })

    await waitFor(() => expect(mocks.closeTab).toHaveBeenCalledWith('tab-1'))
  })

  it('does not close the tab when a different tag is deleted', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)
    await screen.findByText('araba')

    mocks.deletedHandler?.({ tag: 'other' })

    expect(mocks.closeTab).not.toHaveBeenCalled()
  })

  it('applies the scoped tag to a note created from the header', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Create table note' }))

    await waitFor(() =>
      expect(mocks.createNote).toHaveBeenCalledWith(expect.objectContaining({ tags: ['araba'] }))
    )
  })
})

describe('FolderViewPage tag scope row opening by kind', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.folderState.isLoading = false
    mocks.folderState.error = null
    mocks.folderState.folderNotFound = false
    mocks.folderState.activeView = null
    mocks.folderState.notes = [note, taskRow, inboxRow]
    mocks.activeTab = { id: 'tab-1' }
  })

  it('opens a note row through sidebar navigation, not a plain tab', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Open note' }))

    expect(mocks.openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'note-1', title: 'Folder Note' })
    )
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('opens a task row in the Tasks page with no selectedProjectId', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Open task row' }))

    expect(mocks.openSidebarItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tasks',
        viewState: expect.objectContaining({ openTaskId: 'task-1' })
      })
    )
    const [item] = mocks.openSidebarItem.mock.calls[0]
    expect(item.viewState).not.toHaveProperty('selectedProjectId')
  })

  it('opens an inbox row with a fresh focus token on every open', async () => {
    // Real Date.now() resolution (1ms) could tie two back-to-back clicks on
    // a fast machine — spy with a strictly-increasing counter so the "fresh
    // token" assertion is deterministic, not a timing race.
    let now = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => ++now)

    try {
      renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)
      const openInboxButton = await screen.findByRole('button', { name: 'Open inbox row' })

      await userEvent.click(openInboxButton)
      await userEvent.click(openInboxButton)

      expect(mocks.openSidebarItem).toHaveBeenCalledTimes(2)
      expect(mocks.openSidebarItem).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          type: 'inbox',
          viewState: expect.objectContaining({ focusInboxItemId: 'inbox-1' })
        })
      )
      const [first, second] = mocks.openSidebarItem.mock.calls.map(
        (call) => call[0].viewState.focusedAt
      )
      expect(first).toBeDefined()
      expect(second).not.toBe(first)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('still opens a folder-scope row as a plain tab, not via sidebar navigation', async () => {
    mocks.folderState.notes = [note]
    renderWithProviders(<FolderViewPage scope={{ kind: 'folder', path: 'Work' }} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Open note' }))

    expect(mocks.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'note', entityId: 'note-1' })
    )
    expect(mocks.openSidebarItem).not.toHaveBeenCalled()
  })
})

describe('FolderViewPage locked filter condition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.folderState.isLoading = false
    mocks.folderState.error = null
    mocks.folderState.folderNotFound = false
    mocks.folderState.activeView = null
    mocks.folderState.notes = [note]
  })

  it('passes a locked tag condition to the filter builder under tag scope', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)

    expect(await screen.findByTestId('locked-condition')).toBeInTheDocument()
  })

  it('passes no locked condition under folder scope', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'folder', path: 'Work' }} />)

    await screen.findByText('Folder Note')
    expect(screen.queryByTestId('locked-condition')).not.toBeInTheDocument()
  })
})

describe('FolderViewPage bulk action bar wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.folderState.isLoading = false
    mocks.folderState.error = null
    mocks.folderState.folderNotFound = false
    mocks.folderState.activeView = null
    mocks.folderState.notes = [note, taskRow]
  })

  it('passes the live scope and the actual selected rows (not stale/partial) to the bulk bar', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Select mixed rows' }))

    expect(await screen.findByTestId('bulk-scope-kind')).toHaveTextContent('tag')
    const selectedRowsJson = screen.getByTestId('bulk-selected-rows').textContent
    expect(JSON.parse(selectedRowsJson ?? '[]')).toEqual([
      { id: 'note-1' },
      { id: 'task-1', kind: 'task' }
    ])
  })

  it('does not render a scope for the bulk bar under folder scope', async () => {
    mocks.folderState.notes = [note]
    renderWithProviders(<FolderViewPage scope={{ kind: 'folder', path: 'Work' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Select note' }))

    expect(await screen.findByTestId('bulk-scope-kind')).toHaveTextContent('folder')
  })
})

describe('FolderViewPage tag mutations stay note-only', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.folderState.isLoading = false
    mocks.folderState.error = null
    mocks.folderState.folderNotFound = false
    mocks.folderState.activeView = null
    mocks.folderState.notes = [note, taskRow, inboxRow]
  })

  it('bulk add tag hits the note IPC once per note row and never with a task or inbox id', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Select mixed rows' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Bulk add tag' }))

    await waitFor(() =>
      expect(mocks.updateNoteTags).toHaveBeenCalledWith('note-1', ['work', 'urgent'])
    )
    expect(mocks.updateNoteTags).toHaveBeenCalledTimes(1)
    expect(mocks.updateNoteTags).not.toHaveBeenCalledWith('task-1', expect.anything())
    expect(mocks.updateNoteTags).not.toHaveBeenCalledWith('inbox-1', expect.anything())
  })

  it('removing a tag chip on a task row does not touch the note IPC', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Remove tag on task row' }))

    expect(mocks.updateNoteTags).not.toHaveBeenCalled()
  })

  it('removing a tag chip on an inbox row does not touch the note IPC', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Remove tag on inbox row' }))

    expect(mocks.updateNoteTags).not.toHaveBeenCalled()
  })

  it('still removes a tag chip on a note row under tag scope', async () => {
    renderWithProviders(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Remove tag' }))

    expect(mocks.updateNoteTags).toHaveBeenCalledWith('note-1', [])
  })

  it('still bulk adds a tag to every selected row under folder scope', async () => {
    mocks.folderState.notes = [note, secondNote]
    renderWithProviders(<FolderViewPage scope={{ kind: 'folder', path: 'Work' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Select two notes' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Bulk add tag' }))

    await waitFor(() =>
      expect(mocks.updateNoteTags).toHaveBeenCalledWith('note-1', ['work', 'urgent'])
    )
    expect(mocks.updateNoteTags).toHaveBeenCalledWith('note-2', ['work', 'urgent'])
    expect(mocks.updateNoteTags).toHaveBeenCalledTimes(2)
  })
})

describe('FolderViewPage stale selection after a filter change', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.folderState.isLoading = false
    mocks.folderState.error = null
    mocks.folderState.folderNotFound = false
    mocks.folderState.activeView = null
    mocks.folderState.notes = [note, taskRow]
    mocks.deleteNote.mockResolvedValue({ success: true })
    mocks.moveNote.mockResolvedValue({ success: true })
  })

  it('refuses to delete a row that vanished from view after a filter change drops it', async () => {
    const { rerender } = renderWithProviders(
      <FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />
    )

    // Mixed selection: a note row and a task row. Delete would be disabled
    // by BulkActionBar's own guard at this point (not exercised here, since
    // the mock bar always renders its buttons).
    fireEvent.click(await screen.findByRole('button', { name: 'Select mixed rows' }))

    // Filter change drops the task row — `notes` shrinks reactively, as
    // use-folder-view.ts applies filters client-side. `task-1` is still in
    // `selectedRowIds` at this point.
    mocks.folderState.notes = [note]
    rerender(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Bulk delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'button.delete' }))

    await waitFor(() => expect(mocks.deleteNote).toHaveBeenCalledWith('note-1'))
    expect(mocks.deleteNote).not.toHaveBeenCalledWith('task-1')
  })

  it('refuses to move a row that vanished from view after a filter change drops it', async () => {
    const { rerender } = renderWithProviders(
      <FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Select mixed rows' }))

    mocks.folderState.notes = [note]
    rerender(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Bulk move' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm move' }))

    await waitFor(() => expect(mocks.moveNote).toHaveBeenCalledWith('note-1', 'Archive'))
    expect(mocks.moveNote).not.toHaveBeenCalledWith('task-1', 'Archive')
  })

  it('keeps a selection intact across an unrelated filter change (pruning is not over-eager)', async () => {
    mocks.folderState.notes = [note, secondNote, taskRow]
    const { rerender } = renderWithProviders(
      <FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Select two notes' }))

    // Unrelated filter change drops only the task row — both selected notes
    // stay visible, so their selection must survive untouched.
    mocks.folderState.notes = [note, secondNote]
    rerender(<FolderViewPage scope={{ kind: 'tag', tag: 'araba' }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Bulk delete' }))
    fireEvent.click(screen.getByRole('button', { name: 'button.delete' }))

    await waitFor(() => expect(mocks.deleteNote).toHaveBeenCalledWith('note-1'))
    expect(mocks.deleteNote).toHaveBeenCalledWith('note-2')
  })
})
