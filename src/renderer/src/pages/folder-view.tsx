/**
 * Folder View Page
 *
 * Displays notes in a folder as a database-like table view.
 * Supports multiple views, filtering, and sorting.
 */

import { useMemo, useState, useEffect, useCallback } from 'react'
import { ArrowLeft, Folder, LayoutGrid, List, Settings2 } from 'lucide-react'

// ============================================================================
// Debounce Hook
// ============================================================================

/**
 * Hook to debounce a value by a specified delay.
 * Used for search input to avoid excessive filtering while typing.
 */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      clearTimeout(timer)
    }
  }, [value, delay])

  return debouncedValue
}
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { useTabs } from '@/contexts/tabs'
import { FolderTableView } from '@/components/folder-view/folder-table-view'
import { FolderViewToolbar } from '@/components/folder-view/folder-view-toolbar'
import { ViewSwitcher } from '@/components/folder-view/view-switcher'
import { useFolderView } from '@/hooks/use-folder-view'
import { notesService } from '@/services/notes-service'
import { DEFAULT_COLUMNS, type FilterExpression } from '@shared/contracts/folder-view-api'

interface FolderViewPageProps {
  /** Folder path relative to notes/ */
  folderPath?: string
}

/**
 * Folder View Page Component
 */
export function FolderViewPage({ folderPath }: FolderViewPageProps): React.JSX.Element {
  const { openTab } = useTabs()

  // Use the folder view hook
  const {
    views,
    activeViewIndex,
    activeView,
    notes,
    totalNotes,
    unfilteredCount,
    isLoading,
    error,
    setActiveViewIndex,
    updateView,
    addView,
    deleteView,
    setViewAsDefault,
    updateColumns,
    updateSorting,
    updateFilters,
    updateDisplayName,
    availableProperties,
    builtInColumns,
    refresh
  } = useFolderView({ folderPath: folderPath ?? '' })

  // Delete confirmation dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [notesToDelete, setNotesToDelete] = useState<string[]>([])
  const [isDeleting, setIsDeleting] = useState(false)

  // ============================================================================
  // Selection State (Phase 19 - Lifted for virtualization persistence)
  // ============================================================================

  /**
   * Selected row IDs - lifted to page level so selection:
   * 1. Persists when switching between named views
   * 2. Can be accessed for bulk action toolbar (future)
   * 3. Works seamlessly with row virtualization
   */
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set())

  /**
   * Clear selection when folder changes
   */
  useEffect(() => {
    setSelectedRowIds(new Set())
  }, [folderPath])

  /**
   * Handle selection change from table
   */
  const handleSelectionChange = useCallback((newSelection: Set<string>) => {
    setSelectedRowIds(newSelection)
  }, [])

  // Column search state for highlighting
  const [columnSearchQuery, setColumnSearchQuery] = useState('')

  // Global search state with debounce (T073, T076)
  const [searchQuery, setSearchQuery] = useState('')
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 200)

  // Compute which columns should be highlighted based on search query
  const highlightedColumns = useMemo(() => {
    if (!columnSearchQuery) return []
    const query = columnSearchQuery.toLowerCase()

    // Get visible column IDs
    const visibleIds = (activeView?.columns ?? DEFAULT_COLUMNS).map((c) => c.id)

    // Find matching built-in columns
    const builtInMatches = builtInColumns
      .filter((col) => col.displayName.toLowerCase().includes(query))
      .map((col) => col.id)

    // Find matching property columns
    const propMatches = availableProperties
      .filter((prop) => prop.name.toLowerCase().includes(query))
      .map((prop) => prop.name)

    // Only return columns that are currently visible
    return [...builtInMatches, ...propMatches].filter((id) => visibleIds.includes(id))
  }, [columnSearchQuery, builtInColumns, availableProperties, activeView])

  // Get folder display name
  const folderName = useMemo(() => {
    if (!folderPath) return 'Notes'
    const parts = folderPath.split('/')
    return parts[parts.length - 1] || 'Notes'
  }, [folderPath])

  // Get parent folder for back navigation
  const parentFolder = useMemo(() => {
    if (!folderPath) return null
    const parts = folderPath.split('/')
    if (parts.length <= 1) return null
    return parts.slice(0, -1).join('/')
  }, [folderPath])

  // Handle opening a note (single click opens permanent tab)
  const handleNoteOpen = (noteId: string): void => {
    const note = notes.find((n) => n.id === noteId)
    if (note) {
      openTab({
        type: 'note',
        title: note.title,
        icon: 'file-text',
        path: `/notes/${note.id}`,
        entityId: note.id,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    }
  }

  // Handle clicking a subfolder
  const handleFolderClick = (subfolderPath: string): void => {
    // Combine current folder path with subfolder
    const fullPath = folderPath ? `${folderPath}${subfolderPath}` : subfolderPath.slice(1)
    const folderName = subfolderPath.split('/').pop() || 'Folder'

    openTab({
      type: 'folder',
      title: folderName,
      icon: 'folder',
      path: `/folder/${encodeURIComponent(fullPath)}`,
      entityId: fullPath,
      isPinned: false,
      isModified: false,
      isPreview: true,
      isDeleted: false
    })
  }

  // Handle clicking a tag
  const handleTagClick = (tag: string): void => {
    // TODO: Open search/filter for this tag
    console.log('Tag clicked:', tag)
  }

  // Handle opening note in new tab (for context menu)
  const handleOpenInNewTab = useCallback(
    (noteId: string): void => {
      const note = notes.find((n) => n.id === noteId)
      if (note) {
        openTab({
          type: 'note',
          title: note.title,
          icon: 'file-text',
          path: `/notes/${note.id}`,
          entityId: note.id,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        })
      }
    },
    [notes, openTab]
  )

  // Handle delete request (shows confirmation dialog)
  const handleDeleteRequest = useCallback((noteIds: string[]): void => {
    setNotesToDelete(noteIds)
    setDeleteDialogOpen(true)
  }, [])

  // Confirm and execute delete
  const handleDeleteConfirm = useCallback(async () => {
    if (notesToDelete.length === 0) return

    setIsDeleting(true)
    try {
      // Delete all selected notes
      for (const noteId of notesToDelete) {
        const result = await notesService.delete(noteId)
        if (!result.success) {
          console.error(`Failed to delete note ${noteId}:`, result.error)
        }
      }

      // Refresh the view to reflect changes
      await refresh()
    } catch (err) {
      console.error('Failed to delete notes:', err)
    } finally {
      setIsDeleting(false)
      setDeleteDialogOpen(false)
      setNotesToDelete([])
    }
  }, [notesToDelete, refresh])

  // Handle navigating to parent folder
  const handleNavigateUp = (): void => {
    if (parentFolder !== null) {
      openTab({
        type: 'folder',
        title: parentFolder.split('/').pop() || 'Notes',
        icon: 'folder',
        path: `/folder/${encodeURIComponent(parentFolder)}`,
        entityId: parentFolder,
        isPinned: false,
        isModified: false,
        isPreview: true,
        isDeleted: false
      })
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        {/* Back button */}
        {parentFolder !== null && (
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleNavigateUp}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}

        {/* Folder icon and name */}
        <div className="flex items-center gap-2 min-w-0">
          <Folder className="h-5 w-5 text-muted-foreground flex-shrink-0" />
          <h1 className="text-lg font-semibold truncate">{folderName}</h1>
        </div>

        {/* Note count */}
        <span className="text-sm text-muted-foreground">
          {isLoading ? (
            <Skeleton className="h-4 w-16" />
          ) : totalNotes < unfilteredCount ? (
            `${totalNotes} of ${unfilteredCount} notes`
          ) : (
            `${totalNotes} notes`
          )}
        </span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* View Switcher */}
        <ViewSwitcher
          views={views}
          activeViewIndex={activeViewIndex}
          activeView={activeView}
          onViewChange={setActiveViewIndex}
          onAddView={addView}
          onUpdateView={updateView}
          onSetViewAsDefault={setViewAsDefault}
          onDeleteView={deleteView}
        />

        {/* View type toggle (future: table/grid/list) */}
        <div className="flex items-center gap-1 border rounded-md p-0.5">
          <Button variant="ghost" size="icon" className="h-7 w-7 bg-muted">
            <List className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled>
            <LayoutGrid className="h-4 w-4" />
          </Button>
        </div>

        {/* Settings */}
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled>
          <Settings2 className="h-4 w-4" />
        </Button>
      </header>

      {/* Toolbar */}
      <FolderViewToolbar
        columns={activeView?.columns ?? DEFAULT_COLUMNS}
        builtInColumns={builtInColumns}
        availableProperties={availableProperties}
        filters={activeView?.filters as FilterExpression | undefined}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onColumnsChange={updateColumns}
        onFiltersChange={updateFilters}
        onColumnSearchChange={setColumnSearchQuery}
      />

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {error ? (
          <div className="flex items-center justify-center h-64 text-destructive">
            <p>{error}</p>
          </div>
        ) : isLoading ? (
          <FolderViewSkeleton />
        ) : (
          <FolderTableView
            notes={notes}
            columns={activeView?.columns ?? DEFAULT_COLUMNS}
            initialSorting={activeView?.order}
            globalFilter={debouncedSearchQuery}
            highlightQuery={debouncedSearchQuery}
            selectedRowIds={selectedRowIds}
            onSelectionChange={handleSelectionChange}
            onNoteOpen={handleNoteOpen}
            onOpenInNewTab={handleOpenInNewTab}
            onFolderClick={handleFolderClick}
            onTagClick={handleTagClick}
            onColumnsChange={updateColumns}
            onSortingChange={updateSorting}
            onDisplayNameChange={updateDisplayName}
            onDelete={handleDeleteRequest}
            highlightedColumns={highlightedColumns}
            className="h-full"
          />
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {notesToDelete.length === 1 ? 'Delete Note' : `Delete ${notesToDelete.length} Notes`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {notesToDelete.length === 1
                ? 'Are you sure you want to delete this note? This action cannot be undone.'
                : `Are you sure you want to delete ${notesToDelete.length} notes? This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * Loading skeleton for folder view
 */
function FolderViewSkeleton(): React.JSX.Element {
  return (
    <div className="p-4 space-y-3">
      {/* Header skeleton */}
      <div className="flex gap-4 pb-2 border-b">
        {[200, 100, 120, 100].map((width, i) => (
          <Skeleton key={i} className="h-6" style={{ width }} />
        ))}
      </div>
      {/* Row skeletons */}
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="flex gap-4">
          {[200, 100, 120, 100].map((width, j) => (
            <Skeleton key={j} className="h-8" style={{ width }} />
          ))}
        </div>
      ))}
    </div>
  )
}

export default FolderViewPage
