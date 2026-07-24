/**
 * Folder View Page
 *
 * Displays notes in a folder as a database-like table view.
 * Supports multiple views, filtering, and sorting.
 */

import { Fragment, useMemo, useState, useLayoutEffect, useCallback, useRef } from 'react'
import { ChevronRight, Plus, Search, X } from '@/lib/icons'

import { useDebouncedValue } from '@/hooks/use-task-filters'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
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
import { useTabs } from '@/contexts/tabs'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { FolderTableView } from '@/components/folder-view/folder-table-view'
import { GroupedTable } from '@/components/folder-view/grouped-table'
import { ColumnSelector } from '@/components/folder-view/column-selector'
import { FilterBuilder } from '@/components/folder-view/filter-builder'
import { GroupBySelector } from '@/components/folder-view/group-by-selector'
import { SortSelector } from '@/components/folder-view/sort-selector'
import { FolderEmojiChip } from '@/components/folder-view/folder-emoji-chip'
import { FolderListView } from '@/components/folder-view/folder-list-view'
import { FolderGalleryView } from '@/components/folder-view/folder-gallery-view'
import { BulkActionBar } from '@/components/folder-view/bulk-action-bar'
import type { TagMetaMap } from '@/components/folder-view/note-card-pieces'
import { ViewSwitcher } from '@/components/folder-view/view-switcher'
import { cn } from '@/lib/utils'
import { MoveToFolderDialog } from '@/components/folder-view/move-to-folder-dialog'
import { useFolderView } from '@/hooks/use-folder-view'
import { useNoteMutations, useNoteTagsQuery, useNoteFoldersQuery } from '@/hooks/use-notes-query'
import { notesService } from '@/services/notes-service'
import {
  DEFAULT_COLUMNS,
  type FilterExpression,
  type ColumnConfig,
  type GroupByConfig
} from '@memry/contracts/folder-view-api'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

const log = createLogger('Page:FolderView')

interface FolderViewPageProps {
  /** Folder path relative to notes/ */
  folderPath?: string
}

/**
 * Folder View Page Component
 */
export function FolderViewPage({ folderPath }: FolderViewPageProps): React.JSX.Element {
  const { t: tPhaseF } = useT('notes')
  const { t } = useT('notes')
  const { t: tCommon } = useT('common')
  const { openTab, closeTab, getActiveTab } = useTabs()
  const { openSidebarItem } = useSidebarNavigation()
  const { tags: allTags } = useNoteTagsQuery()
  const { folders, setFolderIcon } = useNoteFoldersQuery()

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
    renameView,
    setViewAsDefault,
    updateColumns,
    updateSorting,
    updateFilters,
    updateDisplayName,
    updateSummaryConfig,
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

  // Active view render mode (table / list / grid) — persisted via the view config.
  const viewType = activeView?.type ?? 'table'

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
   * Clear selection during render when the folder changes — keeps the reset
   * out of an effect so the no-adjust-state-on-prop-change rule stays happy.
   */
  const [selectionFolderPath, setSelectionFolderPath] = useState(folderPath)
  if (selectionFolderPath !== folderPath) {
    setSelectionFolderPath(folderPath)
    setSelectedRowIds(new Set())
  }

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

  // Search icon toggles an inline input; stays open while a query is active.
  const [searchOpen, setSearchOpen] = useState(false)
  const showSearch = searchOpen || searchQuery.length > 0

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

  // Breadcrumb trail starting at the real folder: ancestor folders › current folder
  const breadcrumbs = useMemo(() => {
    const segments = folderPath ? folderPath.split('/').filter(Boolean) : []
    if (segments.length === 0) return [{ label: 'Notes', path: null }]
    return segments.map((segment, i) => ({
      label: segment,
      path: segments.slice(0, i + 1).join('/') as string | null
    }))
  }, [folderPath])

  // Current folder's custom icon (raw emoji or "icon:Name"), null = default glyph
  const folderIcon = useMemo(
    () => folders.find((f) => f.path === folderPath)?.icon ?? null,
    [folders, folderPath]
  )

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

  const tagMetaMap = useMemo<TagMetaMap>(() => {
    const map: TagMetaMap = new Map()
    for (const tag of allTags) {
      map.set(tag.tag.toLowerCase(), { color: tag.color, icon: tag.icon ?? null })
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
      isPreview: false,
      isDeleted: false
    })
  }

  // Handle clicking a tag
  const handleTagClick = useCallback(
    (tag: string): void => {
      const color = tagMetaMap.get(tag.toLowerCase())?.color ?? ''
      openSidebarItem({
        type: 'tag',
        title: tag,
        path: '/tags/' + tag,
        entityId: tag,
        color
      })
    },
    [openSidebarItem, tagMetaMap]
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

  // Navigate to a breadcrumb ancestor folder
  const handleBreadcrumbNav = useCallback(
    (path: string, label: string): void => {
      openTab({
        type: 'folder',
        title: label,
        icon: 'folder',
        path: `/folder/${encodeURIComponent(path)}`,
        entityId: path,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    },
    [openTab]
  )

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
    void updateFilters(undefined)
  }, [updateFilters])

  // ============================================================================
  // Phase 21: Toolbar Action Handlers
  // ============================================================================

  // ============================================================================
  // Bulk Action Bar Handlers (floating toolbar shown while rows are selected)
  // ============================================================================

  const tagNames = useMemo(() => allTags.map((tag) => tag.tag), [allTags])

  const handleClearSelection = useCallback(() => setSelectedRowIds(new Set()), [])

  const handleCopyLinks = useCallback(async () => {
    const ids = Array.from(selectedRowIds)
    if (ids.length === 0) return
    try {
      await navigator.clipboard.writeText(ids.map((id) => `memry://note/${id}`).join('\n'))
      toast.success(t('bulkActions.copiedLinks', { count: ids.length }))
    } catch (err) {
      log.error('Failed to copy links', err)
      toast.error(extractErrorMessage(err, t('phaseI.errors.failedToCopyLink')))
    }
  }, [selectedRowIds, t])

  const handleBulkAddTag = useCallback(
    async (tag: string) => {
      const ids = Array.from(selectedRowIds)
      if (ids.length === 0 || !tag) return
      await Promise.all(
        ids.map((id) => {
          const note = notes.find((n) => n.id === id)
          if (!note || note.tags.includes(tag)) return Promise.resolve()
          return updateNoteTags(id, [...note.tags, tag])
        })
      )
    },
    [selectedRowIds, notes, updateNoteTags]
  )

  // ponytail: per-note native save dialog (cancel aborts the run). A single-folder
  // bulk export needs a directory-picker IPC + ExportNoteInput.outputPath — add then.
  const handleBulkExport = useCallback(async () => {
    for (const id of Array.from(selectedRowIds)) {
      const result = await notesService.exportHtml({ noteId: id })
      if (result.error === 'Export cancelled') break
    }
  }, [selectedRowIds])

  return (
    <div className="flex flex-col h-full w-full min-w-0 max-w-full overflow-hidden">
      {/* Header - min-w-0 breaks minimum content size chain to prevent table from pushing it */}
      <header className="flex h-14 items-center gap-3 px-4 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 flex-shrink-0 min-w-0 overflow-hidden text-xs antialiased">
        {/* Folder icon box — shows the folder's custom icon, click to change */}
        <FolderEmojiChip
          icon={folderIcon}
          onIconChange={(icon) => void setFolderIcon(folderPath ?? '', icon)}
        />

        {/* Breadcrumb trail + note count */}
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {breadcrumbs.map((crumb, i) => {
            const isLast = i === breadcrumbs.length - 1
            const crumbPath = crumb.path
            return (
              <Fragment key={crumbPath ?? 'root'}>
                {i > 0 && (
                  <ChevronRight className="size-3 flex-shrink-0 text-muted-foreground/50" />
                )}
                {crumbPath !== null && !isLast ? (
                  <button
                    type="button"
                    onClick={() => handleBreadcrumbNav(crumbPath, crumb.label)}
                    className="truncate font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {crumb.label}
                  </button>
                ) : (
                  <span
                    className={cn(
                      'truncate font-medium',
                      isLast ? 'text-foreground/80' : 'text-muted-foreground'
                    )}
                  >
                    {crumb.label}
                  </span>
                )}
              </Fragment>
            )
          })}
          <span className="flex-shrink-0 font-medium text-muted-foreground/50">·</span>
          <span className="flex-shrink-0 whitespace-nowrap font-medium text-text-tertiary">
            {isLoading ? (
              <Skeleton className="h-3.5 w-16" />
            ) : totalNotes < unfilteredCount ? (
              `${totalNotes} of ${unfilteredCount} notes`
            ) : (
              `${totalNotes} notes`
            )}
          </span>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Actions cluster — order: search · sort · filter · properties · group | saved views | new note */}
        <div className="flex flex-shrink-0 items-center gap-1.5">
          {/* Search — icon expands to an inline input, stays open while a query is active */}
          {showSearch ? (
            <div className="relative w-48">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onBlur={() => {
                  if (!searchQuery) setSearchOpen(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearchQuery('')
                    setSearchOpen(false)
                  }
                }}
                placeholder={tPhaseF('phaseF.componentsFolderViewFolderViewToolbar.searchNotes')}
                className="h-8 ps-8 pe-8 text-sm"
              />
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('')
                  setSearchOpen(false)
                }}
                className="absolute end-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                aria-label={tPhaseF('phaseF.componentsFolderViewFolderViewToolbar.clearSearch')}
              >
                <X className="size-4" />
              </button>
            </div>
          ) : (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 px-2"
                    onClick={() => setSearchOpen(true)}
                    aria-label={tPhaseF('phaseF.componentsFolderViewFolderViewToolbar.searchNotes')}
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {tPhaseF('phaseF.componentsFolderViewFolderViewToolbar.searchNotes')}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          {/* Sort */}
          <SortSelector
            order={activeView?.order}
            availableProperties={availableProperties}
            builtInColumns={builtInColumns}
            onSortingChange={(...args) => void updateSorting(...args)}
          />

          {/* Filter */}
          <FilterBuilder
            filters={activeView?.filters as FilterExpression | undefined}
            availableProperties={availableProperties}
            builtInColumns={builtInColumns}
            onFiltersChange={(...args) => void updateFilters(...args)}
          />

          {/* Properties */}
          <ColumnSelector
            columns={activeView?.columns ?? DEFAULT_COLUMNS}
            builtInColumns={builtInColumns}
            availableProperties={availableProperties}
            formulas={formulas}
            onColumnsChange={(...args) => void updateColumns(...args)}
            onSearchChange={setColumnSearchQuery}
            onFormulaAdd={addFormula}
            onFormulaEdit={updateFormula}
            onFormulaDelete={deleteFormula}
            sampleNote={sampleNote}
            summaries={summaries}
            onSummaryChange={(...args) => void updateSummaryConfig(...args)}
            showSummaries={activeView?.showSummaries ?? false}
            onToggleSummaries={() => void updateView({ showSummaries: !activeView?.showSummaries })}
            columnBorders={activeView?.columnBorders ?? false}
            onToggleColumnBorders={() =>
              void updateView({ columnBorders: !activeView?.columnBorders })
            }
          />

          {/* Group */}
          <GroupBySelector
            groupBy={activeView?.groupBy as GroupByConfig | undefined}
            availableProperties={availableProperties}
            builtInColumns={builtInColumns}
            onGroupByChange={(...args) => void updateGroupBy(...args)}
          />

          {/* Divider */}
          <div className="h-4 w-px flex-shrink-0 bg-border" />

          {/* Saved views */}
          <ViewSwitcher
            views={views}
            activeViewIndex={activeViewIndex}
            activeView={activeView}
            onViewChange={setActiveViewIndex}
            onAddView={addView}
            onUpdateView={updateView}
            onRenameView={renameView}
            onSetViewAsDefault={setViewAsDefault}
            onDeleteView={deleteView}
          />

          {/* New Note button */}
          <button
            type="button"
            onClick={() => void handleCreateNote()}
            title={tPhaseF('phaseF.pagesFolderView.createNewNote')}
            className="flex h-8 items-center gap-1.5 rounded-md bg-[var(--tint)] px-3 text-[12.5px] font-semibold text-[var(--tint-foreground)] shadow-sm transition-colors hover:bg-[var(--tint-hover)]"
          >
            <Plus className="size-3.5" />
            {tPhaseF('phaseF.pagesFolderView.createNewNote')}
          </button>
        </div>
      </header>

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
              onRetry={(...args) => void refresh(...args)}
              className="h-full"
            />
          ) : isLoading ? (
            <FolderViewSkeleton columns={activeView?.columns ?? DEFAULT_COLUMNS} />
          ) : viewType === 'list' ? (
            <FolderListView
              notes={notes}
              searchQuery={debouncedSearchQuery}
              density="compact"
              tagMetaMap={tagMetaMap}
              onNoteOpen={handleNoteOpen}
              onTagClick={handleTagClick}
              onCreateNote={() => void handleCreateNote()}
              onClearAll={handleClearAll}
              className="h-full"
            />
          ) : viewType === 'grid' ? (
            <FolderGalleryView
              notes={notes}
              searchQuery={debouncedSearchQuery}
              tagMetaMap={tagMetaMap}
              onNoteOpen={handleNoteOpen}
              onTagClick={handleTagClick}
              onCreateNote={() => void handleCreateNote()}
              onClearAll={handleClearAll}
              className="h-full"
            />
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
              tagMetaMap={tagMetaMap}
              onPropertyUpdate={(...args) => void updateNoteProperty(...args)}
              onColumnsChange={(...args) => void updateColumns(...args)}
              onSortingChange={(...args) => void updateSorting(...args)}
              onDisplayNameChange={(...args) => void updateDisplayName(...args)}
              onDelete={handleDeleteRequest}
              onMoveToFolder={handleMoveRequest}
              onCreateNote={(...args) => void handleCreateNote(...args)}
              onClearAll={handleClearAll}
              highlightedColumns={highlightedColumns}
              density="compact"
              showColumnBorders={activeView?.columnBorders ?? false}
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
              tagMetaMap={tagMetaMap}
              onPropertyUpdate={(...args) => void updateNoteProperty(...args)}
              onColumnsChange={(...args) => void updateColumns(...args)}
              onSortingChange={(...args) => void updateSorting(...args)}
              onDisplayNameChange={(...args) => void updateDisplayName(...args)}
              onDelete={handleDeleteRequest}
              onMoveToFolder={handleMoveRequest}
              onCreateNote={(...args) => void handleCreateNote(...args)}
              onClearAll={handleClearAll}
              highlightedColumns={highlightedColumns}
              density="compact"
              showColumnBorders={activeView?.columnBorders ?? false}
              showSummaries={activeView?.showSummaries ?? false}
              summaries={summaries}
              exitingRowIds={exitingRowIds}
              className="h-full"
            />
          )}
        </div>

        {/* Floating bulk action bar — table/grouped views, while rows are selected */}
        {selectedRowIds.size > 0 &&
          viewType !== 'list' &&
          viewType !== 'grid' &&
          !folderNotFound &&
          !error &&
          !isLoading && (
            <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center px-4">
              <BulkActionBar
                className="pointer-events-auto"
                count={selectedRowIds.size}
                availableTags={tagNames}
                tagMeta={tagMetaMap}
                onMove={() => handleMoveRequest(Array.from(selectedRowIds))}
                onCopyLinks={() => void handleCopyLinks()}
                onAddTag={(tag) => void handleBulkAddTag(tag)}
                onExport={() => void handleBulkExport()}
                onDelete={() => handleDeleteRequest(Array.from(selectedRowIds))}
                onClear={handleClearSelection}
              />
            </div>
          )}
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('page.deleteDialogTitle', { count: notesToDelete.length })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {notesToDelete.length === 1
                ? 'Are you sure you want to delete this note? This action cannot be undone.'
                : `Are you sure you want to delete ${notesToDelete.length} notes? This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {tPhaseF('phaseF.pagesFolderView.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDeleteConfirm()}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? tCommon('state.deleting') : tCommon('button.delete')}
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
        onMove={(...args) => void handleMoveConfirm(...args)}
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

  // Calculate row count based on container height. useLayoutEffect avoids
  // the unnecessary-effect lint and matches the DOM-measurement nature of
  // the work (synchronous after layout).
  useLayoutEffect(() => {
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
