/**
 * Folder View Page
 *
 * Displays notes in a folder as a database-like table view.
 * Supports multiple views, filtering, and sorting.
 */

import { useMemo, useState, useEffect, useCallback, useRef } from 'react'
import { ArrowLeft, Folder, LayoutGrid, List, Plus, Settings2 } from '@/lib/icons'

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
import { FolderViewEmptyState } from '@/components/folder-view/folder-view-empty-state'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useDisplayDensity } from '@/hooks/use-display-density'
import { useTabs } from '@/contexts/tabs'
import { useSidebarDrillDown } from '@/contexts/sidebar-drill-down'
import { FolderTableView } from '@/components/folder-view/folder-table-view'
import { GroupedTable } from '@/components/folder-view/grouped-table'
import { FolderViewToolbar } from '@/components/folder-view/folder-view-toolbar'
import { ViewSwitcher } from '@/components/folder-view/view-switcher'
import { MoveToFolderDialog } from '@/components/folder-view/move-to-folder-dialog'
import { useFolderView } from '@/hooks/use-folder-view'
import { useNoteMutations, useNoteTagsQuery } from '@/hooks/use-notes-query'
import { notesService } from '@/services/notes-service'
import {
  DEFAULT_COLUMNS,
  type FilterExpression,
  type ColumnConfig,
  type GroupByConfig
} from '@memry/contracts/folder-view-api'
import { createLogger } from '@/lib/logger'

const log = createLogger('Page:FolderView')

interface FolderViewPageProps {
  /** Folder path relative to notes/ */
  folderPath?: string
}

/**
 * Folder View Page Component
 */
export function FolderViewPage({ folderPath }: FolderViewPageProps): React.JSX.Element {
  const { openTab, closeTab, getActiveTab } = useTabs()
  const { openTag } = useSidebarDrillDown()
  const { tags: allTags } = useNoteTagsQuery()

  // Use mutations hook for creating new notes (with folder template support)
  const { createNote } = useNoteMutations()

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
    folderNotFound,
    setActiveViewIndex,
    updateView,
    addView,
    deleteView,
    setViewAsDefault,
    updateColumns,
    updateSorting,
    updateFilters,
    updateDisplayName,
    updateSummaryConfig,
    toggleShowSummaries,
    updateGroupBy,
    availableProperties,
    builtInColumns,
    formulas,
    formulasMap,
    summaries,
    addFormula,
    updateFormula,
    deleteFormula,
    refresh,
    removeNotesOptimistically,
    updateNoteProperty,
    updateNoteTags
  } = useFolderView({ folderPath: folderPath ?? '' })

  // Get first note for formula preview in editor
  const sampleNote = notes.length > 0 ? notes[0] : null

  // Delete confirmation dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [notesToDelete, setNotesToDelete] = useState<string[]>([])
  const [isDeleting, setIsDeleting] = useState(false)

  // Move to folder dialog state (Phase 27)
  const [moveDialogOpen, setMoveDialogOpen] = useState(false)
  const [notesToMove, setNotesToMove] = useState<string[]>([])
  const [movingNoteTitle, setMovingNoteTitle] = useState<string | undefined>()

  // ============================================================================
  // Phase 21: View Settings State
  // ============================================================================

  /** Display density (comfortable/compact) - persisted via hook */
  const { density, setDensity } = useDisplayDensity()

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

  // T121: Exiting row IDs for opacity fade animation
  const [exitingRowIds, setExitingRowIds] = useState<Set<string>>(new Set())
  const EXIT_ANIMATION_DURATION = 200 // ms

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

  // T116: Create property types map from available properties
  const propertyTypesMap = useMemo(() => {
    const map: Record<
      string,
      'text' | 'number' | 'checkbox' | 'date' | 'select' | 'multiselect' | 'url' | 'rating'
    > = {}
    for (const prop of availableProperties) {
      map[prop.name] = prop.type as
        | 'text'
        | 'number'
        | 'checkbox'
        | 'date'
        | 'select'
        | 'multiselect'
        | 'url'
        | 'rating'
    }
    return map
  }, [availableProperties])

  const tagColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const tag of allTags) {
      map.set(tag.tag.toLowerCase(), tag.color)
    }
    return map
  }, [allTags])

  // Handle opening a note (single click opens permanent tab)
  const handleNoteOpen = (noteId: string): void => {
    const note = notes.find((n) => n.id === noteId)
    if (note) {
      openTab({
        type: 'note',
        title: note.title,
        icon: 'file-text',
        emoji: note.emoji,
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
  const handleTagClick = useCallback(
    (tag: string): void => {
      const color = tagColorMap.get(tag.toLowerCase()) ?? 'stone'
      openTag(tag, color)
    },
    [openTag, tagColorMap]
  )

  const handleTagRemove = useCallback(
    (noteId: string, tag: string): void => {
      const note = notes.find((n) => n.id === noteId)
      if (!note) return
      const nextTags = note.tags.filter((t) => t !== tag)
      void updateNoteTags(noteId, nextTags)
    },
    [notes, updateNoteTags]
  )

  // Handle opening note in new tab (for context menu)
  const handleOpenInNewTab = useCallback(
    (noteId: string): void => {
      const note = notes.find((n) => n.id === noteId)
      if (note) {
        openTab({
          type: 'note',
          title: note.title,
          icon: 'file-text',
          emoji: note.emoji,
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

  // Handle move to folder request (shows move dialog) - Phase 27
  const handleMoveRequest = useCallback(
    (noteIds: string[]): void => {
      setNotesToMove(noteIds)
      // Get title of first note for dialog header
      if (noteIds.length === 1) {
        const note = notes.find((n) => n.id === noteIds[0])
        setMovingNoteTitle(note?.title)
      } else {
        setMovingNoteTitle(undefined)
      }
      setMoveDialogOpen(true)
    },
    [notes]
  )

  // Confirm and execute move to folder - Phase 27 (Optimized - no skeleton blink)
  const handleMoveConfirm = useCallback(
    async (targetFolder: string): Promise<void> => {
      if (notesToMove.length === 0) return

      // Optimistic removal - update UI immediately (no skeleton)
      removeNotesOptimistically(notesToMove)

      // Clear selection since moved notes are gone
      setSelectedRowIds(new Set())

      try {
        // Move notes in parallel for performance
        const results = await Promise.allSettled(
          notesToMove.map((noteId) => notesService.move(noteId, targetFolder))
        )

        // Check for failures
        const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

        if (failures.length > 0) {
          log.error(`${failures.length} notes failed to move:`, failures)
          await refresh() // Restore correct state on failure
        }
      } catch (err) {
        log.error('Failed to move notes:', err)
        await refresh() // Restore correct state on error
      } finally {
        setMoveDialogOpen(false)
        setNotesToMove([])
        setMovingNoteTitle(undefined)
      }
    },
    [notesToMove, removeNotesOptimistically, refresh]
  )

  // Confirm and execute delete (T121: with opacity fade animation)
  const handleDeleteConfirm = useCallback(async () => {
    if (notesToDelete.length === 0) return

    setIsDeleting(true)

    // T121: Start exit animation by adding IDs to exiting set
    setExitingRowIds((prev) => new Set([...prev, ...notesToDelete]))

    // Clear selection since notes are being deleted
    setSelectedRowIds(new Set())

    // Wait for animation to complete before removing from state
    await new Promise((resolve) => setTimeout(resolve, EXIT_ANIMATION_DURATION))

    // Clear exiting state
    setExitingRowIds((prev) => {
      const next = new Set(prev)
      notesToDelete.forEach((id) => next.delete(id))
      return next
    })

    // Optimistic removal - update UI after animation
    removeNotesOptimistically(notesToDelete)

    try {
      // Delete notes in parallel for performance
      const results = await Promise.allSettled(
        notesToDelete.map((noteId) => notesService.delete(noteId))
      )

      // Check for failures
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')

      if (failures.length > 0) {
        log.error(`${failures.length} notes failed to delete:`, failures)
        await refresh() // Restore correct state on failure
      }
    } catch (err) {
      log.error('Failed to delete notes:', err)
      await refresh() // Restore correct state on error
    } finally {
      setIsDeleting(false)
      setDeleteDialogOpen(false)
      setNotesToDelete([])
    }
  }, [notesToDelete, removeNotesOptimistically, refresh, EXIT_ANIMATION_DURATION])

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

  // ============================================================================
  // Phase 20: Empty State Handlers
  // ============================================================================

  /**
   * Handle creating a new note in the current folder.
   * Uses folder template from .folder.md if one exists.
   */
  const handleCreateNote = useCallback(async () => {
    try {
      const result = await createNote.mutateAsync({
        title: 'Untitled',
        folder: folderPath ?? undefined
        // Template is auto-applied by backend from .folder.md
      })

      if (result.success && result.note) {
        openTab({
          type: 'note',
          title: result.note.title || 'Untitled',
          icon: 'file-text',
          emoji: result.note.emoji,
          path: `/notes/${result.note.id}`,
          entityId: result.note.id,
          isPinned: false,
          isModified: false,
          isPreview: false,
          isDeleted: false
        })
      }
    } catch (err) {
      log.error('Failed to create note:', err)
    }
  }, [createNote, folderPath, openTab])

  /**
   * Handle clearing all search and filters.
   * Used by the 'no-results' empty state.
   */
  const handleClearAll = useCallback(() => {
    setSearchQuery('')
    updateFilters(undefined)
  }, [updateFilters])

  // ============================================================================
  // Phase 21: Toolbar Action Handlers
  // ============================================================================

  return (
    <div className="flex flex-col h-full w-full min-w-0 max-w-full overflow-hidden">
      {/* Header - min-w-0 breaks minimum content size chain to prevent table from pushing it */}
      <header className="flex items-center gap-3 px-4 py-3 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 flex-shrink-0 min-w-0 overflow-hidden">
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

        {/* Note count (T100 - already implemented) */}
        <span className="text-sm text-muted-foreground">
          {isLoading ? (
            <Skeleton className="h-4 w-16" />
          ) : totalNotes < unfilteredCount ? (
            `${totalNotes} of ${unfilteredCount} notes`
          ) : (
            `${totalNotes} notes`
          )}
        </span>

        {/* T098: New Note button */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleCreateNote}
          title="Create new note"
        >
          <Plus className="h-4 w-4" />
        </Button>

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

        {/* T099: View Settings dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" title="View settings">
              <Settings2 className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>Display Density</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={density === 'comfortable'}
              onCheckedChange={() => setDensity('comfortable')}
            >
              Comfortable
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={density === 'compact'}
              onCheckedChange={() => setDensity('compact')}
            >
              Compact
            </DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={activeView?.showSummaries ?? false}
              onCheckedChange={() => toggleShowSummaries()}
            >
              Show summaries
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {/* Toolbar - min-w-0 and overflow-hidden to stay within viewport */}
      <FolderViewToolbar
        columns={activeView?.columns ?? DEFAULT_COLUMNS}
        builtInColumns={builtInColumns}
        availableProperties={availableProperties}
        formulas={formulas}
        filters={activeView?.filters as FilterExpression | undefined}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onColumnsChange={updateColumns}
        onFiltersChange={updateFilters}
        onColumnSearchChange={setColumnSearchQuery}
        onFormulaAdd={addFormula}
        onFormulaEdit={updateFormula}
        onFormulaDelete={deleteFormula}
        sampleNote={sampleNote}
        summaries={summaries}
        onSummaryChange={updateSummaryConfig}
        groupBy={activeView?.groupBy as GroupByConfig | undefined}
        onGroupByChange={updateGroupBy}
        className="flex-shrink-0 min-w-0 overflow-hidden"
      />

      {/* Content - relative container for absolute positioned table */}
      <div className="flex-1 relative min-w-0">
        {/* Absolute positioned inner container isolates table width from layout */}
        <div className="absolute inset-0 overflow-hidden">
          {folderNotFound ? (
            <FolderViewEmptyState
              variant="folder-not-found"
              onGoBack={() => {
                // Close the current tab
                const activeTab = getActiveTab()
                if (activeTab) {
                  closeTab(activeTab.id)
                }
              }}
              className="h-full"
            />
          ) : error ? (
            <FolderViewEmptyState
              variant="error"
              errorMessage={error}
              onRetry={refresh}
              className="h-full"
            />
          ) : isLoading ? (
            <FolderViewSkeleton columns={activeView?.columns ?? DEFAULT_COLUMNS} />
          ) : activeView?.groupBy ? (
            // Grouped table view when groupBy is set (Phase 24)
            <GroupedTable
              notes={notes}
              columns={activeView?.columns ?? DEFAULT_COLUMNS}
              formulas={formulasMap}
              propertyTypes={propertyTypesMap}
              groupBy={activeView.groupBy as GroupByConfig}
              initialSorting={activeView?.order}
              globalFilter={debouncedSearchQuery}
              highlightQuery={debouncedSearchQuery}
              selectedRowIds={selectedRowIds}
              onSelectionChange={handleSelectionChange}
              onNoteOpen={handleNoteOpen}
              onOpenInNewTab={handleOpenInNewTab}
              onFolderClick={handleFolderClick}
              onTagClick={handleTagClick}
              onTagRemove={handleTagRemove}
              onPropertyUpdate={updateNoteProperty}
              onColumnsChange={updateColumns}
              onSortingChange={updateSorting}
              onDisplayNameChange={updateDisplayName}
              onDelete={handleDeleteRequest}
              onMoveToFolder={handleMoveRequest}
              onCreateNote={handleCreateNote}
              onClearAll={handleClearAll}
              highlightedColumns={highlightedColumns}
              density={density}
              showColumnBorders={true}
              showSummaries={activeView?.showSummaries ?? false}
              summaries={summaries}
              exitingRowIds={exitingRowIds}
              className="h-full"
            />
          ) : (
            // Standard table view
            <FolderTableView
              notes={notes}
              columns={activeView?.columns ?? DEFAULT_COLUMNS}
              formulas={formulasMap}
              propertyTypes={propertyTypesMap}
              initialSorting={activeView?.order}
              globalFilter={debouncedSearchQuery}
              highlightQuery={debouncedSearchQuery}
              selectedRowIds={selectedRowIds}
              onSelectionChange={handleSelectionChange}
              onNoteOpen={handleNoteOpen}
              onOpenInNewTab={handleOpenInNewTab}
              onFolderClick={handleFolderClick}
              onTagClick={handleTagClick}
              onTagRemove={handleTagRemove}
              onPropertyUpdate={updateNoteProperty}
              onColumnsChange={updateColumns}
              onSortingChange={updateSorting}
              onDisplayNameChange={updateDisplayName}
              onDelete={handleDeleteRequest}
              onMoveToFolder={handleMoveRequest}
              onCreateNote={handleCreateNote}
              onClearAll={handleClearAll}
              highlightedColumns={highlightedColumns}
              density={density}
              showColumnBorders={true}
              showSummaries={activeView?.showSummaries ?? false}
              summaries={summaries}
              exitingRowIds={exitingRowIds}
              className="h-full"
            />
          )}
        </div>
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

      {/* Move to Folder Dialog - Phase 27 */}
      <MoveToFolderDialog
        open={moveDialogOpen}
        onOpenChange={setMoveDialogOpen}
        noteIds={notesToMove}
        currentFolder={folderPath}
        onMove={handleMoveConfirm}
        noteTitle={movingNoteTitle}
      />
    </div>
  )
}

// ============================================================================
// Loading Skeleton Component (T094)
// ============================================================================

interface FolderViewSkeletonProps {
  /** Column configs to match actual column widths */
  columns: ColumnConfig[]
  /** Additional CSS classes */
  className?: string
}

/**
 * Loading skeleton for folder view with dynamic column widths and viewport-aware row count.
 */
function FolderViewSkeleton({ columns, className }: FolderViewSkeletonProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [rowCount, setRowCount] = useState(10)

  // Calculate row count based on container height
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const calculateRows = (): void => {
      const height = container.clientHeight
      const headerHeight = 40 // Approximate header row height
      const rowHeight = 44 // Approximate data row height
      const padding = 32 // Container padding (16px top + 16px bottom)
      const availableHeight = height - headerHeight - padding
      const calculated = Math.floor(availableHeight / rowHeight)
      // Clamp between 5 and 20 rows
      setRowCount(Math.max(5, Math.min(calculated, 20)))
    }

    calculateRows()

    // Recalculate on resize
    const resizeObserver = new ResizeObserver(calculateRows)
    resizeObserver.observe(container)

    return () => resizeObserver.disconnect()
  }, [])

  return (
    <div ref={containerRef} className={`h-full p-4 space-y-2 ${className ?? ''}`}>
      {/* Header skeleton */}
      <div className="flex gap-4 pb-2 border-b">
        {columns.map((col) => (
          <Skeleton key={col.id} className="h-6" style={{ width: col.width ?? 150 }} />
        ))}
      </div>
      {/* Row skeletons */}
      {Array.from({ length: rowCount }).map((_, i) => (
        <div key={i} className="flex gap-4">
          {columns.map((col) => (
            <Skeleton key={col.id} className="h-8" style={{ width: col.width ?? 150 }} />
          ))}
        </div>
      ))}
    </div>
  )
}

export default FolderViewPage
