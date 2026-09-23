/**
 * Virtualized Tree Utilities
 *
 * Utilities for flattening a hierarchical tree structure into a flat list
 * suitable for virtualization, while maintaining proper indentation levels
 * and expand/collapse state.
 *
 * @module lib/virtualized-tree-utils
 */

import type { NoteListItem } from '@/hooks/use-notes-query'

// ============================================================================
// Types
// ============================================================================

/**
 * Folder node in the tree structure
 */
export interface FolderNode {
  name: string
  path: string
  icon?: string | null
  children: FolderNode[]
  notes: NoteListItem[]
}

/**
 * Tree structure with root folders and root notes
 */
export interface TreeStructure {
  folders: FolderNode[]
  rootNotes: NoteListItem[]
  /**
   * Every level lists its notes before its subfolders (`sidebar.notesFirst`).
   * Absent is folders first, the order the tree has always had.
   */
  notesFirst?: boolean
}

/** One child of a folder (or of the vault root) in display order. */
export type FolderEntry =
  { type: 'folder'; folder: FolderNode } | { type: 'note'; note: NoteListItem }

/**
 * A level's folders and notes merged into the order the tree draws them.
 *
 * The one place the folders-vs-notes order is decided: both sidebar trees
 * render from this, keyboard navigation walks what they render, and the last
 * entry is the level's last row whichever group it came from. Each group keeps
 * the order the sort mode gave it.
 */
export function orderFolderEntries(
  folders: FolderNode[],
  notes: NoteListItem[],
  notesFirst = false
): FolderEntry[] {
  const folderEntries = folders.map((folder): FolderEntry => ({ type: 'folder', folder }))
  const noteEntries = notes.map((note): FolderEntry => ({ type: 'note', note }))
  return notesFirst ? [...noteEntries, ...folderEntries] : [...folderEntries, ...noteEntries]
}

/**
 * Base type for flattened tree items
 */
interface BaseVirtualItem {
  id: string
  level: number
  isLast: boolean
}

/**
 * Flattened folder item
 */
export interface FolderVirtualItem extends BaseVirtualItem {
  type: 'folder'
  folder: FolderNode
  hasChildren: boolean
  isExpanded: boolean
}

/**
 * Flattened note item
 */
export interface NoteVirtualItem extends BaseVirtualItem {
  type: 'note'
  note: NoteListItem
}

/**
 * Union type for all virtual items
 */
export type TreeVirtualItem = FolderVirtualItem | NoteVirtualItem

// ============================================================================
// Constants
// ============================================================================

/** Height of a single tree row in pixels */
export const TREE_ROW_HEIGHT = 28

/**
 * Height of a sidebar section header (`SidebarSection`, `h-6`). The header
 * sticks to the top of the sidebar's scroll area, so anything scrolling a tree
 * row into view has to leave this much room above it.
 */
export const SIDEBAR_SECTION_HEADER_HEIGHT = 24

/** Virtualization threshold - only virtualize when item count exceeds this */
export const VIRTUALIZATION_THRESHOLD = 100

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Count total items in a tree structure (folders + notes)
 */
export function countTreeItems(tree: TreeStructure): number {
  let count = tree.rootNotes.length

  function countFolder(folder: FolderNode): number {
    let folderCount = 1 // The folder itself
    folderCount += folder.notes.length
    for (const child of folder.children) {
      folderCount += countFolder(child)
    }
    return folderCount
  }

  for (const folder of tree.folders) {
    count += countFolder(folder)
  }

  return count
}

/**
 * Flatten a tree structure into a list of virtual items for rendering.
 * Only includes items that are visible (i.e., their parent folders are expanded).
 *
 * @param tree - The tree structure to flatten
 * @param expandedIds - Set of expanded folder IDs (format: "folder-path/to/folder")
 * @returns Flattened list of visible items
 */
export function flattenTree(tree: TreeStructure, expandedIds: Set<string>): TreeVirtualItem[] {
  const items: TreeVirtualItem[] = []

  /**
   * Recursively process a folder and its contents
   */
  function processFolder(folder: FolderNode, level: number, isLast: boolean): void {
    const folderId = `folder-${folder.path}`
    const hasChildren = folder.children.length > 0 || folder.notes.length > 0
    const isExpanded = expandedIds.has(folderId)

    // Add the folder item
    items.push({
      id: folderId,
      type: 'folder',
      folder,
      level,
      isLast,
      hasChildren,
      isExpanded
    })

    if (isExpanded && hasChildren) {
      processEntries(orderFolderEntries(folder.children, folder.notes, tree.notesFirst), level + 1)
    }
  }

  function processEntries(entries: FolderEntry[], level: number): void {
    entries.forEach((entry, index) => {
      const isLast = index === entries.length - 1
      if (entry.type === 'folder') {
        processFolder(entry.folder, level, isLast)
      } else {
        items.push({ id: entry.note.id, type: 'note', note: entry.note, level, isLast })
      }
    })
  }

  processEntries(orderFolderEntries(tree.folders, tree.rootNotes, tree.notesFirst), 0)

  return items
}

/**
 * Get all folder IDs from a tree (for "expand all" functionality)
 */
export function getAllFolderIds(tree: TreeStructure): string[] {
  const ids: string[] = []

  function collectFolderIds(folder: FolderNode): void {
    ids.push(`folder-${folder.path}`)
    folder.children.forEach(collectFolderIds)
  }

  tree.folders.forEach(collectFolderIds)
  return ids
}

/**
 * Get the parent folder ID for a given item
 */
export function getParentFolderId(item: TreeVirtualItem): string | null {
  if (item.type === 'folder') {
    const parentPath = item.folder.path.split('/').slice(0, -1).join('/')
    return parentPath ? `folder-${parentPath}` : null
  } else {
    // For notes, extract folder from path
    const pathParts = item.note.path.split('/')
    pathParts.pop() // Remove filename

    // Handle "notes/folder/file.md" format
    if (pathParts.length > 1 && pathParts[0] === 'notes') {
      const folderPath = pathParts.slice(1).join('/')
      return folderPath ? `folder-${folderPath}` : null
    }

    return null
  }
}

/**
 * Estimate the height of the virtualized list
 */
export function estimateTreeHeight(itemCount: number): number {
  return itemCount * TREE_ROW_HEIGHT
}

/**
 * Check if virtualization should be enabled based on item count
 */
export function shouldVirtualize(tree: TreeStructure): boolean {
  return countTreeItems(tree) >= VIRTUALIZATION_THRESHOLD
}

/**
 * First row index that must move down to open the drop gap, or null when the
 * drag opens no space.
 *
 * Both sidebar trees animate a "make room" gap while a row is dragged between
 * two others. An `inside` drop moves an item into a folder and opens nothing;
 * a drop `before` a row pushes that row down, `after` pushes the one below it.
 */
export function dropGapStartIndex(
  dropTargetId: string | null,
  dropPosition: 'before' | 'after' | 'inside' | null,
  indexOf: (id: string) => number
): number | null {
  if (!dropTargetId) return null
  if (dropPosition !== 'before' && dropPosition !== 'after') return null

  const index = indexOf(dropTargetId)
  if (index === -1) return null

  return dropPosition === 'before' ? index : index + 1
}

/**
 * The virtual window plus the row that must stay mounted, in ascending order.
 *
 * The sidebar icon picker is a popover rendered inside its row, so a row the
 * virtualizer drops takes the open panel with it and the picker looks like it
 * closed itself mid-pick (#1986). Feeding this through the virtualizer's
 * `rangeExtractor` keeps that one row rendered wherever the list is scrolled.
 */
export function withPinnedIndex(indexes: number[], pinnedIndex: number): number[] {
  if (pinnedIndex < 0 || indexes.includes(pinnedIndex)) return indexes
  return [...indexes, pinnedIndex].sort((a, b) => a - b)
}
