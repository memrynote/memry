/**
 * Folder View Page
 *
 * Displays notes in a folder as a database-like table view.
 * Similar to Obsidian Bases - supports multiple views, filtering, and sorting.
 */

import { useMemo, useState } from 'react'
import { ArrowLeft, Folder, LayoutGrid, List, Plus, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTabs } from '@/contexts/tabs'
import { FolderTableView } from '@/components/folder-view/folder-table-view'
import { FolderViewToolbar } from '@/components/folder-view/folder-view-toolbar'
import { useFolderView } from '@/hooks/use-folder-view'
import { DEFAULT_COLUMNS } from '@shared/contracts/folder-view-api'

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
    isLoading,
    error,
    setActiveViewIndex,
    updateColumns,
    updateSorting,
    updateDisplayName,
    availableProperties,
    builtInColumns
  } = useFolderView({ folderPath: folderPath ?? '' })

  // Column search state for highlighting
  const [columnSearchQuery, setColumnSearchQuery] = useState('')

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
  const handleNoteOpen = (noteId: string) => {
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
  const handleFolderClick = (subfolderPath: string) => {
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
  const handleTagClick = (tag: string) => {
    // TODO: Open search/filter for this tag
    console.log('Tag clicked:', tag)
  }

  // Handle navigating to parent folder
  const handleNavigateUp = () => {
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
          {isLoading ? <Skeleton className="h-4 w-16" /> : `${notes.length} notes`}
        </span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* View switcher tabs (if multiple views) */}
        {views.length > 1 && (
          <Tabs
            value={String(activeViewIndex)}
            onValueChange={(value) => setActiveViewIndex(Number(value))}
            className="h-8"
          >
            <TabsList className="h-8">
              {views.map((view, index) => (
                <TabsTrigger key={view.name} value={String(index)} className="h-7 px-3 text-xs">
                  {view.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}

        {/* View type toggle (future: table/grid/list) */}
        <div className="flex items-center gap-1 border rounded-md p-0.5">
          <Button variant="ghost" size="icon" className="h-7 w-7 bg-muted">
            <List className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" disabled>
            <LayoutGrid className="h-4 w-4" />
          </Button>
        </div>

        {/* Add view button */}
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled>
          <Plus className="h-4 w-4" />
        </Button>

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
        onColumnsChange={updateColumns}
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
            onNoteOpen={handleNoteOpen}
            onFolderClick={handleFolderClick}
            onTagClick={handleTagClick}
            onColumnsChange={updateColumns}
            onSortingChange={updateSorting}
            onDisplayNameChange={updateDisplayName}
            highlightedColumns={highlightedColumns}
            className="h-full"
          />
        )}
      </div>
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
