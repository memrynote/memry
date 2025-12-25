/**
 * VirtualizedNotesTree Component
 *
 * A virtualized version of the notes tree for performance with 100+ notes.
 * Uses @tanstack/react-virtual for efficient rendering of only visible items.
 *
 * @module components/virtualized-notes-tree
 */

import { useRef, useCallback, useMemo, useState, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FileText, Folder, FolderOpen, ChevronRight, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTabs } from '@/contexts/tabs'
import type { NoteListItem } from '@/hooks/use-notes'
import {
  flattenTree,
  TREE_ROW_HEIGHT,
  type TreeStructure,
  type FolderVirtualItem,
  type NoteVirtualItem
} from '@/lib/virtualized-tree-utils'

// ============================================================================
// Types
// ============================================================================

interface VirtualizedNotesTreeProps {
  /** Tree structure with folders and notes */
  tree: TreeStructure
  /** Currently selected note/folder IDs */
  selectedIds: string[]
  /** Callback when selection changes */
  onSelectionChange: (ids: string[]) => void
  /** Callback when a note should be renamed */
  onRenameNote?: (note: NoteListItem) => void
  /** Callback when a note should be deleted */
  onDeleteNote?: (note: NoteListItem) => void
  /** Callback when a folder should be deleted */
  onDeleteFolder?: (folderPath: string) => void
  /** Map of note IDs to notes for quick lookup */
  noteMap: Map<string, NoteListItem>
  /** Whether drag operations are disabled */
  isDragDisabled?: boolean
  /** Custom class name */
  className?: string
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get display name from note path (filename without extension)
 */
function getDisplayName(notePath: string): string {
  const filename = notePath.split('/').pop() || notePath
  return filename.replace(/\.md$/i, '')
}

/**
 * Storage key for expanded folders
 */
const EXPANDED_FOLDERS_KEY = 'memry:notes-tree:expanded-folders'

/**
 * Load expanded folder IDs from localStorage
 */
function loadExpandedFolders(): Set<string> {
  try {
    const stored = localStorage.getItem(EXPANDED_FOLDERS_KEY)
    if (stored) {
      return new Set(JSON.parse(stored))
    }
  } catch {
    // Ignore parse errors
  }
  return new Set()
}

/**
 * Save expanded folder IDs to localStorage
 */
function saveExpandedFolders(expandedIds: Set<string>): void {
  try {
    localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify([...expandedIds]))
  } catch {
    // Ignore storage errors
  }
}

// ============================================================================
// Row Components
// ============================================================================

interface FolderRowProps {
  item: FolderVirtualItem
  isSelected: boolean
  onToggleExpand: (folderId: string) => void
  onSelect: (folderId: string, event: React.MouseEvent) => void
}

function FolderRow({ item, isSelected, onToggleExpand, onSelect }: FolderRowProps) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onSelect(item.id, e)
    },
    [item.id, onSelect]
  )

  const handleExpandClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onToggleExpand(item.id)
    },
    [item.id, onToggleExpand]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onToggleExpand(item.id)
      }
    },
    [item.id, onToggleExpand]
  )

  return (
    <div
      role="treeitem"
      aria-expanded={item.isExpanded}
      aria-selected={isSelected}
      tabIndex={0}
      className={cn(
        'flex items-center gap-1 px-2 py-1 cursor-pointer rounded-sm transition-colors',
        'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        isSelected && 'bg-muted'
      )}
      style={{ paddingLeft: `${item.level * 16 + 8}px` }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      {/* Expand/Collapse button */}
      <button
        type="button"
        className="p-0.5 hover:bg-muted rounded-sm"
        onClick={handleExpandClick}
        aria-label={item.isExpanded ? 'Collapse folder' : 'Expand folder'}
      >
        {item.hasChildren ? (
          item.isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5" />
        )}
      </button>

      {/* Folder icon */}
      {item.isExpanded ? (
        <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
      ) : (
        <Folder className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
      )}

      {/* Folder name */}
      <span className="text-sm truncate">{item.folder.name}</span>
    </div>
  )
}

interface NoteRowProps {
  item: NoteVirtualItem
  isSelected: boolean
  onSelect: (noteId: string, event: React.MouseEvent) => void
  onDoubleClick?: (note: NoteListItem) => void
}

function NoteRow({ item, isSelected, onSelect, onDoubleClick }: NoteRowProps) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onSelect(item.id, e)
    },
    [item.id, onSelect]
  )

  const handleDoubleClick = useCallback(() => {
    onDoubleClick?.(item.note)
  }, [item.note, onDoubleClick])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        onDoubleClick?.(item.note)
      }
    },
    [item.note, onDoubleClick]
  )

  return (
    <div
      role="treeitem"
      aria-selected={isSelected}
      tabIndex={0}
      className={cn(
        'flex items-center gap-1 px-2 py-1 cursor-pointer rounded-sm transition-colors',
        'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        isSelected && 'bg-muted'
      )}
      style={{ paddingLeft: `${item.level * 16 + 8 + 20}px` }} // Extra indent for no expander
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      {/* Note icon or emoji */}
      {item.note.emoji ? (
        <span className="text-sm leading-none shrink-0" role="img" aria-label="note icon">
          {item.note.emoji}
        </span>
      ) : (
        <FileText className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
      )}

      {/* Note name */}
      <span className="text-sm truncate">{getDisplayName(item.note.path)}</span>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function VirtualizedNotesTree({
  tree,
  selectedIds,
  onSelectionChange,
  noteMap,
  className
}: VirtualizedNotesTreeProps) {
  const { openTab } = useTabs()
  const parentRef = useRef<HTMLDivElement>(null)

  // Expanded folders state (persisted to localStorage)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => loadExpandedFolders())

  // Persist expanded state changes
  useEffect(() => {
    saveExpandedFolders(expandedIds)
  }, [expandedIds])

  // Flatten tree based on expanded state
  const flatItems = useMemo(() => {
    return flattenTree(tree, expandedIds)
  }, [tree, expandedIds])

  // Virtual list setup
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => TREE_ROW_HEIGHT,
    overscan: 10 // Render 10 extra items above/below viewport
  })

  // Toggle folder expand/collapse
  const handleToggleExpand = useCallback((folderId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) {
        next.delete(folderId)
      } else {
        next.add(folderId)
      }
      return next
    })
  }, [])

  // Handle item selection
  const handleSelect = useCallback(
    (itemId: string, event: React.MouseEvent) => {
      // Multi-select with Cmd/Ctrl
      if (event.metaKey || event.ctrlKey) {
        const newSelection = selectedIds.includes(itemId)
          ? selectedIds.filter((id) => id !== itemId)
          : [...selectedIds, itemId]
        onSelectionChange(newSelection)
      }
      // Range select with Shift
      else if (event.shiftKey && selectedIds.length > 0) {
        const lastSelected = selectedIds[selectedIds.length - 1]
        const lastIndex = flatItems.findIndex((item) => item.id === lastSelected)
        const currentIndex = flatItems.findIndex((item) => item.id === itemId)

        if (lastIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(lastIndex, currentIndex)
          const end = Math.max(lastIndex, currentIndex)
          const rangeIds = flatItems.slice(start, end + 1).map((item) => item.id)
          onSelectionChange([...new Set([...selectedIds, ...rangeIds])])
        } else {
          onSelectionChange([itemId])
        }
      }
      // Single select
      else {
        onSelectionChange([itemId])

        // If it's a note, open it in a tab
        if (!itemId.startsWith('folder-')) {
          const note = noteMap.get(itemId)
          if (note) {
            openTab({
              type: 'note',
              title: getDisplayName(note.path),
              icon: 'file-text',
              path: `/notes/${note.id}`,
              entityId: note.id,
              isPinned: false,
              isModified: false,
              isPreview: true,
              isDeleted: false
            })
          }
        }
      }
    },
    [selectedIds, onSelectionChange, flatItems, noteMap, openTab]
  )

  // Handle note double-click (open in non-preview mode)
  const handleNoteDoubleClick = useCallback(
    (note: NoteListItem) => {
      openTab({
        type: 'note',
        title: getDisplayName(note.path),
        icon: 'file-text',
        path: `/notes/${note.id}`,
        entityId: note.id,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    },
    [openTab]
  )

  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div
      ref={parentRef}
      role="tree"
      aria-label="Notes tree"
      className={cn('h-full overflow-auto', className)}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative'
        }}
      >
        {virtualItems.map((virtualRow) => {
          const item = flatItems[virtualRow.index]
          const isSelected = selectedIds.includes(item.id)

          return (
            <div
              key={item.id}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              {item.type === 'folder' ? (
                <FolderRow
                  item={item}
                  isSelected={isSelected}
                  onToggleExpand={handleToggleExpand}
                  onSelect={handleSelect}
                />
              ) : (
                <NoteRow
                  item={item}
                  isSelected={isSelected}
                  onSelect={handleSelect}
                  onDoubleClick={handleNoteDoubleClick}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default VirtualizedNotesTree
