import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@tests/utils/render'
import { FolderViewPage } from './folder-view'
import type React from 'react'

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  closeTab: vi.fn(),
  getActiveTab: vi.fn(),
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
  })
}))

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
  DropdownMenuSeparator: () => <hr />
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
  FilterBuilder: ({ onFiltersChange }: { onFiltersChange: (filters: unknown) => void }) => (
    <button type="button" onClick={() => onFiltersChange({ op: 'and', conditions: [] })}>
      Change filters
    </button>
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

const note = {
  id: 'note-1',
  title: 'Folder Note',
  emoji: 'x',
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
    mocks.createNote.mockResolvedValue({
      success: true,
      note: { id: 'new-note', title: 'Untitled' }
    })
    mocks.moveNote.mockResolvedValue({ success: true })
    mocks.deleteNote.mockResolvedValue({ success: true })
  })

  it('drives the standard folder table workflows', async () => {
    renderWithProviders(<FolderViewPage folderPath="Work/Plans" />)

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
    renderWithProviders(<FolderViewPage folderPath="Work/Plans" />)

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
    const { rerender } = renderWithProviders(<FolderViewPage folderPath="Work" />)

    fireEvent.click(screen.getByRole('button', { name: 'Open grouped note' }))
    expect(mocks.openTab).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'note-1' }))

    mocks.folderState.activeView = null
    mocks.folderState.isLoading = true
    rerender(<FolderViewPage folderPath="Work" />)
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0)

    mocks.folderState.isLoading = false
    mocks.folderState.error = 'No folder'
    rerender(<FolderViewPage folderPath="Work" />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry folder' }))
    expect(mocks.refresh).toHaveBeenCalled()

    mocks.folderState.error = null
    mocks.folderState.folderNotFound = true
    rerender(<FolderViewPage folderPath="Work" />)
    fireEvent.click(screen.getByRole('button', { name: 'Go back folder' }))
    expect(mocks.closeTab).toHaveBeenCalledWith('folder-tab')
  })
})
