/**
 * VirtualizedNotesTree Component
 *
 * A virtualized version of the notes tree for performance with 100+ notes.
 * Uses @tanstack/react-virtual for efficient rendering of only visible items.
 * Supports drag-drop reordering, multi-selection, and bulk operations.
 *
 * @module components/virtualized-notes-tree
 */

import { useRef, useCallback, useMemo, useState, useEffect, useLayoutEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  FileText,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  LayoutGrid,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  LayoutTemplate,
  X,
  ExternalLink,
  FileType2,
  Image,
  Music,
  Video
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTabActions } from '@/contexts/tabs'
import type { NoteListItem } from '@/hooks/use-notes-query'
import {
  flattenTree,
  TREE_ROW_HEIGHT,
  type TreeStructure,
  type FolderVirtualItem,
  type NoteVirtualItem
} from '@/lib/virtualized-tree-utils'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { getTabIconForFileType, type FileType } from '@shared/file-types'

// ============================================================================
// Types
// ============================================================================

export type DropPosition = 'before' | 'after' | 'inside'

export type MoveOperation = {
  draggedId: string
  targetId: string
  position: DropPosition
}

type DragState = {
  draggedId: string | null
  dropTargetId: string | null
  dropPosition: DropPosition | null
}

interface VirtualizedNotesTreeProps {
  /** Tree structure with folders and notes */
  tree: TreeStructure
  /** Currently selected note/folder IDs */
  selectedIds: string[]
  /** Callback when selection changes */
  onSelectionChange: (ids: string[]) => void
  /** Callback when items are moved via drag-drop */
  onMove?: (operation: MoveOperation) => void
  /** Callback for bulk delete */
  onBulkDelete?: () => void
  /** Callback when a note should be renamed */
  onRenameNote?: (note: NoteListItem) => void
  /** Callback when a note should be deleted */
  onDeleteNote?: (note: NoteListItem) => void
  /** Callback when opening a note externally */
  onOpenExternal?: (note: NoteListItem) => void
  /** Callback when revealing a note in Finder */
  onRevealInFinder?: (note: NoteListItem) => void
  /** Callback when a folder should be deleted */
  onDeleteFolder?: (folderPath: string) => void
  /** Callback when creating a note in a folder */
  onCreateNote?: (folderPath: string) => void
  /** Callback when creating a subfolder */
  onCreateFolder?: (folderPath: string) => void
  /** Callback when renaming a folder */
  onRenameFolder?: (folderPath: string) => void
  /** Callback when setting folder template */
  onSetFolderTemplate?: (folderPath: string) => void
  /** Callback when clearing folder template */
  onClearFolderTemplate?: (folderPath: string) => void
  /** Map of folder paths to template names */
  folderTemplateNames?: Map<string, string>
  /** Map of note IDs to notes for quick lookup */
  noteMap: Map<string, NoteListItem>
  /** Whether drag operations are disabled */
  isDragDisabled?: boolean
  /** Custom class name */
  className?: string
  /** Optional scroll container for virtualized rendering */
  scrollContainerRef?: React.RefObject<HTMLElement>
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get display name from note path (filename without extension)
 */
function getDisplayName(notePath: string): string {
  const filename = notePath.split('/').pop() || notePath
  // Remove any extension (not just .md)
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.slice(0, lastDot) : filename
}

/**
 * Get the appropriate icon component for a file based on its type.
 * Returns the icon element to render in the tree.
 */
function getFileIcon(note: NoteListItem): React.ReactElement {
  // Emoji takes priority for markdown files
  if (note.emoji) {
    return (
      <span className="text-sm leading-none shrink-0" role="img" aria-label="note icon">
        {note.emoji}
      </span>
    )
  }

  // Get icon based on file type
  const fileType = note.fileType ?? 'markdown'
  const iconClass = 'h-4 w-4 text-muted-foreground shrink-0'

  switch (fileType) {
    case 'pdf':
      return <FileType2 className={`${iconClass} text-red-500`} aria-hidden="true" />
    case 'image':
      return <Image className={`${iconClass} text-blue-500`} aria-hidden="true" />
    case 'audio':
      return <Music className={`${iconClass} text-green-500`} aria-hidden="true" />
    case 'video':
      return <Video className={`${iconClass} text-purple-500`} aria-hidden="true" />
    case 'markdown':
    default:
      return <FileText className={iconClass} aria-hidden="true" />
  }
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

/**
 * Check if an item is a folder based on its ID
 */
function isFolder(itemId: string): boolean {
  return itemId.startsWith('folder-')
}

// ============================================================================
// Row Components
// ============================================================================

interface FolderRowProps {
  item: FolderVirtualItem
  isSelected: boolean
  isLastSelected: boolean
  isDragging: boolean
  isDropTarget: boolean
  dropPosition: DropPosition | null
  selectedCount: number
  draggable: boolean
  onToggleExpand: (folderId: string) => void
  onSelect: (folderId: string, event: React.MouseEvent) => void
  onOpenFolderView?: (folderPath: string) => void
  onCreateNote?: (folderPath: string) => void
  onCreateFolder?: (folderPath: string) => void
  onRenameFolder?: (folderPath: string) => void
  onDeleteFolder?: (folderPath: string) => void
  onSetFolderTemplate?: (folderPath: string) => void
  onClearFolderTemplate?: (folderPath: string) => void
  onBulkDelete?: () => void
  onDragStart: (e: React.DragEvent, itemId: string) => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent, itemId: string, hasChildren: boolean) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  folderTemplateName?: string
}

function FolderRow({
  item,
  isSelected,
  isLastSelected,
  isDragging,
  isDropTarget,
  dropPosition,
  selectedCount,
  draggable,
  onToggleExpand,
  onSelect,
  onOpenFolderView,
  onCreateNote,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onSetFolderTemplate,
  onClearFolderTemplate,
  onBulkDelete,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  folderTemplateName
}: FolderRowProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const showBulkActions = isSelected && selectedCount > 1
  const showSelectionBadge = showBulkActions && isLastSelected

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      // Toggle expand/collapse when clicking folder row
      onToggleExpand(item.id)
      onSelect(item.id, e)
    },
    [item.id, onSelect, onToggleExpand]
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

  const handleOpenFolderViewClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onOpenFolderView?.(item.folder.path)
    },
    [item.folder.path, onOpenFolderView]
  )

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      onDragStart(e, item.id)
    },
    [item.id, onDragStart]
  )

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      onDragOver(e, item.id, item.hasChildren)
    },
    [item.id, item.hasChildren, onDragOver]
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rowRef}
          role="treeitem"
          aria-expanded={item.isExpanded}
          aria-selected={isSelected}
          tabIndex={0}
          draggable={draggable}
          className={cn(
            'group/folder relative flex items-center gap-1 px-2 py-1 cursor-pointer rounded-sm transition-colors min-w-0',
            'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            isSelected && 'bg-sidebar-accent text-sidebar-accent-foreground',
            isDragging && 'opacity-50',
            draggable && 'cursor-default'
          )}
          style={{ paddingLeft: `${item.level * 16 + 8}px` }}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onDragStart={handleDragStart}
          onDragEnd={onDragEnd}
          onDragOver={handleDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {/* Drop indicator - before */}
          {isDropTarget && dropPosition === 'before' && (
            <div
              className="absolute left-2 right-2 -top-0.5 h-0.5 rounded-full bg-primary"
              aria-hidden="true"
            />
          )}

          {/* Drop indicator - after */}
          {isDropTarget && dropPosition === 'after' && (
            <div
              className="absolute left-2 right-2 -bottom-0.5 h-0.5 rounded-full bg-primary"
              aria-hidden="true"
            />
          )}

          {/* Drop indicator - inside (for folders) */}
          {isDropTarget && dropPosition === 'inside' && (
            <div
              className="absolute inset-0 rounded-md border-2 border-primary border-dashed bg-primary/10"
              aria-hidden="true"
            />
          )}

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
          <span className="text-sm truncate flex-1">{item.folder.name}</span>

          {/* Selection count badge */}
          {showSelectionBadge && (
            <span className="text-xs bg-primary text-primary-foreground px-1.5 py-0.5 rounded-full">
              {selectedCount}
            </span>
          )}

          {/* Hover action icon to open folder view */}
          <div className="flex items-center opacity-0 group-hover/folder:opacity-100 transition-opacity">
            <button
              type="button"
              onClick={handleOpenFolderViewClick}
              className="p-1 cursor-pointer rounded hover:bg-accent/80 transition-colors"
              aria-label="Open folder view"
            >
              <LayoutGrid className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
            </button>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {showBulkActions ? (
          // Bulk actions when multiple items selected
          <>
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onBulkDelete}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete {selectedCount} items
            </ContextMenuItem>
          </>
        ) : (
          // Single item actions
          <>
            <ContextMenuItem onClick={() => onCreateNote?.(item.folder.path)}>
              <FilePlus className="mr-2 h-4 w-4" />
              New Note
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCreateFolder?.(item.folder.path)}>
              <FolderPlus className="mr-2 h-4 w-4" />
              New Folder
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onSetFolderTemplate?.(item.folder.path)}>
              <LayoutTemplate className="mr-2 h-4 w-4" />
              Set Default Template
              {folderTemplateName && (
                <span className="ml-1 text-muted-foreground">({folderTemplateName})</span>
              )}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onClearFolderTemplate?.(item.folder.path)}>
              <X className="mr-2 h-4 w-4" />
              Clear Default Template
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onRenameFolder?.(item.folder.path)}>
              <Pencil className="mr-2 h-4 w-4" />
              Rename
            </ContextMenuItem>
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDeleteFolder?.(item.folder.path)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface NoteRowProps {
  item: NoteVirtualItem
  isSelected: boolean
  isLastSelected: boolean
  isDragging: boolean
  isDropTarget: boolean
  dropPosition: DropPosition | null
  selectedCount: number
  draggable: boolean
  onSelect: (noteId: string, event: React.MouseEvent) => void
  onDoubleClick?: (note: NoteListItem) => void
  onRenameNote?: (note: NoteListItem) => void
  onDeleteNote?: (note: NoteListItem) => void
  onOpenExternal?: (note: NoteListItem) => void
  onRevealInFinder?: (note: NoteListItem) => void
  onBulkDelete?: () => void
  onDragStart: (e: React.DragEvent, itemId: string) => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent, itemId: string, hasChildren: boolean) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}

function NoteRow({
  item,
  isSelected,
  isLastSelected,
  isDragging,
  isDropTarget,
  dropPosition,
  selectedCount,
  draggable,
  onSelect,
  onDoubleClick,
  onRenameNote,
  onDeleteNote,
  onOpenExternal,
  onRevealInFinder,
  onBulkDelete,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop
}: NoteRowProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const showBulkActions = isSelected && selectedCount > 1
  const showSelectionBadge = showBulkActions && isLastSelected

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

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      onDragStart(e, item.id)
    },
    [item.id, onDragStart]
  )

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      onDragOver(e, item.id, false)
    },
    [item.id, onDragOver]
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={rowRef}
          role="treeitem"
          aria-selected={isSelected}
          tabIndex={0}
          draggable={draggable}
          className={cn(
            'group/note relative flex items-center gap-1 px-2 py-1 cursor-pointer rounded-sm transition-colors',
            'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            isSelected && 'bg-sidebar-accent text-sidebar-accent-foreground',
            isDragging && 'opacity-50',
            draggable && 'cursor-default'
          )}
          style={{ paddingLeft: `${item.level * 16 + 8 + 20}px` }} // Extra indent for no expander
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
          onDragStart={handleDragStart}
          onDragEnd={onDragEnd}
          onDragOver={handleDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {/* Drop indicator - before */}
          {isDropTarget && dropPosition === 'before' && (
            <div
              className="absolute left-2 right-2 -top-0.5 h-0.5 rounded-full bg-primary"
              aria-hidden="true"
            />
          )}

          {/* Drop indicator - after */}
          {isDropTarget && dropPosition === 'after' && (
            <div
              className="absolute left-2 right-2 -bottom-0.5 h-0.5 rounded-full bg-primary"
              aria-hidden="true"
            />
          )}

          {/* Note icon or emoji */}
          {getFileIcon(item.note)}

          {/* Note name */}
          <span className="text-sm truncate flex-1">{getDisplayName(item.note.path)}</span>

          {/* Selection count badge */}
          {showSelectionBadge && (
            <span className="text-xs bg-primary text-primary-foreground px-1.5 py-0.5 rounded-full">
              {selectedCount}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {showBulkActions ? (
          // Bulk actions when multiple items selected
          <>
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onBulkDelete}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete {selectedCount} items
            </ContextMenuItem>
          </>
        ) : (
          // Single item actions
          <>
            <ContextMenuItem onClick={() => onRenameNote?.(item.note)}>
              <Pencil className="mr-2 h-4 w-4" />
              Rename
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onOpenExternal?.(item.note)}>
              <ExternalLink className="mr-2 h-4 w-4" />
              Open in External Editor
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRevealInFinder?.(item.note)}>
              <FolderOpen className="mr-2 h-4 w-4" />
              Reveal in Finder
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDeleteNote?.(item.note)}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function VirtualizedNotesTree({
  tree,
  selectedIds,
  onSelectionChange,
  onMove,
  onBulkDelete,
  onRenameNote,
  onDeleteNote,
  onOpenExternal,
  onRevealInFinder,
  onDeleteFolder,
  onCreateNote,
  onCreateFolder,
  onRenameFolder,
  onSetFolderTemplate,
  onClearFolderTemplate,
  folderTemplateNames,
  noteMap,
  isDragDisabled = false,
  className,
  scrollContainerRef
}: VirtualizedNotesTreeProps) {
  const { openTab } = useTabActions()
  const parentRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const usesExternalScroll = !!scrollContainerRef

  // Expanded folders state (persisted to localStorage)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => loadExpandedFolders())

  // Drag state
  const [dragState, setDragState] = useState<DragState>({
    draggedId: null,
    dropTargetId: null,
    dropPosition: null
  })

  // Anchor for shift-click range selection
  const [anchorId, setAnchorId] = useState<string | null>(null)

  // Persist expanded state changes
  useEffect(() => {
    saveExpandedFolders(expandedIds)
  }, [expandedIds])

  // Flatten tree based on expanded state
  const flatItems = useMemo(() => {
    return flattenTree(tree, expandedIds)
  }, [tree, expandedIds])

  useLayoutEffect(() => {
    if (!scrollContainerRef?.current || !parentRef.current) {
      setScrollMargin(0)
      return
    }

    const scrollElement = scrollContainerRef.current
    let rafId: number | null = null

    const updateScrollMargin = () => {
      if (!parentRef.current) return
      const scrollRect = scrollElement.getBoundingClientRect()
      const listRect = parentRef.current.getBoundingClientRect()
      const offset = listRect.top - scrollRect.top + scrollElement.scrollTop
      // Defer state update to avoid flushSync warning during render
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
      rafId = requestAnimationFrame(() => {
        setScrollMargin(offset)
        rafId = null
      })
    }

    updateScrollMargin()

    const resizeObserver = new ResizeObserver(updateScrollMargin)
    resizeObserver.observe(scrollElement)
    resizeObserver.observe(parentRef.current)

    return () => {
      resizeObserver.disconnect()
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
    }
  }, [scrollContainerRef])

  // Virtual list setup
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollContainerRef?.current ?? parentRef.current,
    estimateSize: () => TREE_ROW_HEIGHT,
    overscan: 10, // Render 10 extra items above/below viewport
    scrollMargin: usesExternalScroll ? scrollMargin : 0
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

  // Handle item selection with shift/cmd support
  const handleSelect = useCallback(
    (itemId: string, event: React.MouseEvent) => {
      // Multi-select with Cmd/Ctrl - toggle individual item
      if (event.metaKey || event.ctrlKey) {
        const newSelection = selectedIds.includes(itemId)
          ? selectedIds.filter((id) => id !== itemId)
          : [...selectedIds, itemId]
        onSelectionChange(newSelection)
        setAnchorId(itemId)
      }
      // Range select with Shift
      else if (event.shiftKey && anchorId) {
        const anchorIndex = flatItems.findIndex((item) => item.id === anchorId)
        const currentIndex = flatItems.findIndex((item) => item.id === itemId)

        if (anchorIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(anchorIndex, currentIndex)
          const end = Math.max(anchorIndex, currentIndex)
          const rangeIds = flatItems.slice(start, end + 1).map((item) => item.id)
          onSelectionChange(rangeIds)
        } else {
          onSelectionChange([itemId])
          setAnchorId(itemId)
        }
        // Don't update anchor on shift+click
      }
      // Single select
      else {
        onSelectionChange([itemId])
        setAnchorId(itemId)

        // If it's a note, open it in a tab
        if (!isFolder(itemId)) {
          const note = noteMap.get(itemId)
          if (note) {
            const fileType = (note.fileType ?? 'markdown') as FileType
            const isMarkdown = fileType === 'markdown'

            openTab({
              type: isMarkdown ? 'note' : 'file',
              title: getDisplayName(note.path),
              icon: getTabIconForFileType(fileType),
              emoji: isMarkdown ? note.emoji : undefined,
              path: isMarkdown ? `/notes/${note.id}` : `/file/${note.id}`,
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
    [selectedIds, onSelectionChange, flatItems, noteMap, openTab, anchorId]
  )

  // Handle note double-click (open in non-preview mode)
  const handleNoteDoubleClick = useCallback(
    (note: NoteListItem) => {
      const fileType = (note.fileType ?? 'markdown') as FileType
      const isMarkdown = fileType === 'markdown'

      openTab({
        type: isMarkdown ? 'note' : 'file',
        title: getDisplayName(note.path),
        icon: getTabIconForFileType(fileType),
        emoji: isMarkdown ? note.emoji : undefined,
        path: isMarkdown ? `/notes/${note.id}` : `/file/${note.id}`,
        entityId: note.id,
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false
      })
    },
    [openTab]
  )

  // Handle opening folder view from hover icon
  const handleOpenFolderView = useCallback(
    (folderPath: string) => {
      const folderName = folderPath.split('/').pop() || 'Folder'
      openTab({
        type: 'folder',
        title: folderName,
        icon: 'folder',
        path: `/folder/${encodeURIComponent(folderPath)}`,
        entityId: folderPath,
        isPinned: false,
        isModified: false,
        isPreview: true,
        isDeleted: false
      })
    },
    [openTab]
  )

  // Drag event handlers
  const handleDragStart = useCallback(
    (e: React.DragEvent, itemId: string) => {
      if (isDragDisabled) return

      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', itemId)
      setDragState((prev) => ({ ...prev, draggedId: itemId }))
    },
    [isDragDisabled]
  )

  const handleDragEnd = useCallback(() => {
    setDragState({ draggedId: null, dropTargetId: null, dropPosition: null })
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent, itemId: string, hasChildren: boolean) => {
      if (isDragDisabled || dragState.draggedId === itemId) return

      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'

      const rect = e.currentTarget.getBoundingClientRect()
      const y = e.clientY - rect.top
      const height = rect.height
      const threshold = height / 3

      let position: DropPosition
      if (y < threshold) {
        position = 'before'
      } else if (y > height - threshold) {
        position = 'after'
      } else {
        position = hasChildren ? 'inside' : 'after'
      }

      setDragState((prev) => ({
        ...prev,
        dropTargetId: itemId,
        dropPosition: position
      }))
    },
    [isDragDisabled, dragState.draggedId]
  )

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const relatedTarget = e.relatedTarget as HTMLElement
    const currentTarget = e.currentTarget as HTMLElement
    if (!currentTarget.contains(relatedTarget)) {
      setDragState((prev) => ({
        ...prev,
        dropTargetId: null,
        dropPosition: null
      }))
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()

      const { draggedId, dropTargetId, dropPosition } = dragState

      if (draggedId && dropTargetId && dropPosition && onMove) {
        onMove({
          draggedId,
          targetId: dropTargetId,
          position: dropPosition
        })
      }

      setDragState({ draggedId: null, dropTargetId: null, dropPosition: null })
    },
    [dragState, onMove]
  )

  // Keyboard handler for Delete key
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length > 0) {
        e.preventDefault()
        onBulkDelete?.()
      }
    },
    [selectedIds, onBulkDelete]
  )

  const virtualItems = virtualizer.getVirtualItems()
  const draggable = !isDragDisabled
  const selectedCount = selectedIds.length

  return (
    <div
      ref={parentRef}
      role="tree"
      aria-label="Notes tree"
      tabIndex={0}
      className={cn(
        'focus:outline-none',
        usesExternalScroll ? 'overflow-visible' : 'h-full overflow-auto',
        className
      )}
      onKeyDown={handleKeyDown}
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
          const isLastSelected = item.id === selectedIds[selectedIds.length - 1]
          const isDragging = dragState.draggedId === item.id
          const isDropTarget = dragState.dropTargetId === item.id

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
                  isLastSelected={isLastSelected}
                  isDragging={isDragging}
                  isDropTarget={isDropTarget}
                  dropPosition={isDropTarget ? dragState.dropPosition : null}
                  selectedCount={selectedCount}
                  draggable={draggable}
                  onToggleExpand={handleToggleExpand}
                  onSelect={handleSelect}
                  onOpenFolderView={handleOpenFolderView}
                  onCreateNote={onCreateNote}
                  onCreateFolder={onCreateFolder}
                  onRenameFolder={onRenameFolder}
                  onDeleteFolder={onDeleteFolder}
                  onSetFolderTemplate={onSetFolderTemplate}
                  onClearFolderTemplate={onClearFolderTemplate}
                  onBulkDelete={onBulkDelete}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  folderTemplateName={folderTemplateNames?.get(item.folder.path)}
                />
              ) : (
                <NoteRow
                  item={item}
                  isSelected={isSelected}
                  isLastSelected={isLastSelected}
                  isDragging={isDragging}
                  isDropTarget={isDropTarget}
                  dropPosition={isDropTarget ? dragState.dropPosition : null}
                  selectedCount={selectedCount}
                  draggable={draggable}
                  onSelect={handleSelect}
                  onDoubleClick={handleNoteDoubleClick}
                  onRenameNote={onRenameNote}
                  onDeleteNote={onDeleteNote}
                  onOpenExternal={onOpenExternal}
                  onRevealInFinder={onRevealInFinder}
                  onBulkDelete={onBulkDelete}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
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
