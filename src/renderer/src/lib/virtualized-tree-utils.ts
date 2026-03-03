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
  children: FolderNode[]
  notes: NoteListItem[]
}

/**
 * Tree structure with root folders and root notes
 */
export interface TreeStructure {
  folders: FolderNode[]
  rootNotes: NoteListItem[]
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

    // If expanded, process children
    if (isExpanded && hasChildren) {
      // Process child folders first
      folder.children.forEach((child, index) => {
        const isChildLast = index === folder.children.length - 1 && folder.notes.length === 0
        processFolder(child, level + 1, isChildLast)
      })

      // Then process notes in this folder
      folder.notes.forEach((note, index) => {
        const isNoteLast = index === folder.notes.length - 1
        items.push({
          id: note.id,
          type: 'note',
          note,
          level: level + 1,
          isLast: isNoteLast
        })
      })
    }
  }

  // Process root folders
  tree.folders.forEach((folder, index) => {
    const isLast = index === tree.folders.length - 1 && tree.rootNotes.length === 0
    processFolder(folder, 0, isLast)
  })

  // Process root notes
  tree.rootNotes.forEach((note, index) => {
    const isLast = index === tree.rootNotes.length - 1
    items.push({
      id: note.id,
      type: 'note',
      note,
      level: 0,
      isLast
    })
  })

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
