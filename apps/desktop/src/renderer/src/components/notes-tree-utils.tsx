import { FileText, FileType2, Image, Music, Video } from '@/lib/icons'
import { getExtension } from '@memry/shared/file-types'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import type { FolderInfo } from '../../../preload/index.d'
import type { SidebarSortMode } from '@memry/contracts/sidebar-sort'
import { compareNotes, compareFolders } from './notes-tree-sort'
import type { NoteListItem } from '@/hooks/use-notes-query'
import type { FolderNode, TreeStructure } from '@/lib/virtualized-tree-utils'

export type { FolderNode, TreeStructure }

// ============================================================================
// Path Utilities
// ============================================================================

export function getDisplayName(notePath: string): string {
  const filename = notePath.split('/').pop() || notePath
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.slice(0, lastDot) : filename
}

/**
 * Folder of a note, vault-relative.
 *
 * Note paths are vault-relative and so are the folder paths the folder APIs
 * resolve, so nothing is stripped here. Stripping a leading segment used to
 * fabricate folder nodes the main process could not resolve (#1204).
 */
export function extractFolderFromPath(notePath: string): string {
  const parts = notePath.split('/')
  parts.pop()
  return parts.join('/')
}

export function getParentFolder(folderPath: string): string {
  const parts = folderPath.split('/')
  parts.pop()
  return parts.join('/')
}

export function isDescendantOrSelf(sourcePath: string, targetPath: string): boolean {
  return targetPath === sourcePath || targetPath.startsWith(sourcePath + '/')
}

// ============================================================================
// Tree Query Utilities
// ============================================================================

export function getNotesInFolder(tree: TreeStructure, folderPath: string): NoteListItem[] {
  if (folderPath === '') {
    return tree.rootNotes
  }

  const findFolder = (folders: FolderNode[], path: string): FolderNode | null => {
    for (const folder of folders) {
      if (folder.path === path) return folder
      const found = findFolder(folder.children, path)
      if (found) return found
    }
    return null
  }

  const folder = findFolder(tree.folders, folderPath)
  return folder ? folder.notes : []
}

export function getFoldersInParent(tree: TreeStructure, parentPath: string): string[] {
  if (parentPath === '') {
    return tree.folders.map((f) => f.path)
  }

  const findFolder = (folders: FolderNode[], path: string): FolderNode | null => {
    for (const folder of folders) {
      if (folder.path === path) return folder
      const found = findFolder(folder.children, path)
      if (found) return found
    }
    return null
  }

  const parentFolder = findFolder(tree.folders, parentPath)
  return parentFolder ? parentFolder.children.map((f) => f.path) : []
}

/**
 * Move a folder's expanded-state entries onto its new node id.
 *
 * Expansion is keyed by path, so a rename otherwise reads as "this folder was
 * never open" and snaps it — plus every folder open inside it — shut. Both the
 * plain and the virtualized tree persist this set, so the old ids would also
 * linger in storage forever.
 *
 * Returns the original set when nothing matched, so callers can skip a
 * pointless state update and its persistence write.
 */
export function remapExpandedFolderIds(
  expandedIds: Set<string>,
  oldNodeId: string,
  newNodeId: string
): Set<string> {
  if (oldNodeId === newNodeId) return expandedIds

  let changed = false
  const next = new Set<string>()

  for (const id of expandedIds) {
    if (id === oldNodeId || id.startsWith(`${oldNodeId}/`)) {
      next.add(newNodeId + id.slice(oldNodeId.length))
      changed = true
    } else {
      next.add(id)
    }
  }

  return changed ? next : expandedIds
}

// ============================================================================
// Tree Building
// ============================================================================

export function buildTreeFromNotes(
  notes: NoteListItem[],
  folders: FolderInfo[],
  positions: Record<string, number>,
  // Defaults to 'manual', which is exactly what this function did before sort
  // modes existed: stored position first, newest-first (notes) / A→Z (folders)
  // for anything unpositioned. Callers that pass nothing keep the old order.
  sortMode: SidebarSortMode = 'manual',
  // `sidebar.notesFirst`. Only decides which group each level draws first;
  // the sort mode still orders inside each group.
  notesFirst = false
): TreeStructure {
  const folderMap = new Map<string, FolderNode>()
  const rootNotes: NoteListItem[] = []

  const folderIconMap = new Map<string, string | null>()
  for (const f of folders) {
    folderIconMap.set(f.path, f.icon ?? null)
  }

  const ensureFolderInMap = (folderPath: string): FolderNode => {
    const existing = folderMap.get(folderPath)
    if (existing) return existing

    const parts = folderPath.split('/').filter(Boolean)
    let currentPath = ''

    let lastNode: FolderNode | undefined
    parts.forEach((part) => {
      const parentPath = currentPath
      currentPath = currentPath ? `${currentPath}/${part}` : part

      if (!folderMap.has(currentPath)) {
        const node: FolderNode = {
          name: part,
          path: currentPath,
          icon: folderIconMap.get(currentPath) ?? null,
          children: [],
          notes: []
        }
        folderMap.set(currentPath, node)

        if (parentPath && folderMap.has(parentPath)) {
          const parent = folderMap.get(parentPath)!
          if (!parent.children.some((c) => c.path === currentPath)) {
            parent.children.push(node)
          }
        }
        lastNode = node
      } else {
        lastNode = folderMap.get(currentPath)!
      }
    })

    return lastNode!
  }

  folders.forEach((f) => {
    ensureFolderInMap(f.path)
  })

  notes.forEach((note) => {
    const pathParts = note.path.split('/')
    pathParts.pop()

    if (pathParts.length === 0) {
      rootNotes.push(note)
    } else {
      ensureFolderInMap(pathParts.join('/')).notes.push(note)
    }
  })

  const sortByPosition = compareNotes(sortMode, positions)
  const sortFoldersByPosition = compareFolders<FolderNode>(sortMode, positions)

  rootNotes.sort(sortByPosition)

  const sortFolderContents = (folder: FolderNode): void => {
    folder.notes.sort(sortByPosition)
    folder.children.sort(sortFoldersByPosition)
    folder.children.forEach(sortFolderContents)
  }

  const rootFolders = Array.from(folderMap.values()).filter((folder) => {
    return !folder.path.includes('/')
  })

  rootFolders.sort(sortFoldersByPosition)
  rootFolders.forEach(sortFolderContents)

  return {
    folders: rootFolders,
    rootNotes,
    notesFirst
  }
}

/** A non-markdown vault file (PDF, image, audio, video) rather than a note. */
export function isVaultFile(note: NoteListItem): boolean {
  return !!note.fileType && note.fileType !== 'markdown'
}

/**
 * The tree without non-markdown vault files, for `sidebar.showFiles` off.
 *
 * Folders always stay, even one that only holds files: hiding a folder would
 * hide a place the user can still create a note in or drop onto. The tree shows
 * no per-folder counts; what reads the filtered lists is `hasChildren`, so a
 * folder holding only hidden files draws no chevron and counts toward the
 * virtualization threshold as the one row it is.
 */
export function hideVaultFiles(tree: TreeStructure): TreeStructure {
  const filterFolder = (folder: FolderNode): FolderNode => ({
    ...folder,
    children: folder.children.map(filterFolder),
    notes: folder.notes.filter((note) => !isVaultFile(note))
  })

  return {
    ...tree,
    folders: tree.folders.map(filterFolder),
    rootNotes: tree.rootNotes.filter((note) => !isVaultFile(note))
  }
}

export function collectAllFolderIds(tree: TreeStructure): string[] {
  const ids: string[] = []
  const walk = (folders: FolderNode[]): void => {
    for (const folder of folders) {
      ids.push(`folder-${folder.path}`)
      walk(folder.children)
    }
  }
  walk(tree.folders)
  return ids
}

/**
 * Node ids of the folder at `folderPath` and every folder below it, the folder
 * itself first. Empty when the path is not in the tree.
 */
export function collectFolderSubtreeIds(tree: TreeStructure, folderPath: string): string[] {
  const find = (folders: FolderNode[]): FolderNode | null => {
    for (const folder of folders) {
      if (folder.path === folderPath) return folder
      if (folderPath.startsWith(`${folder.path}/`)) return find(folder.children)
    }
    return null
  }

  const root = find(tree.folders)
  if (!root) return []

  const ids: string[] = []
  const walk = (folder: FolderNode): void => {
    ids.push(`folder-${folder.path}`)
    folder.children.forEach(walk)
  }
  walk(root)
  return ids
}

/**
 * `expandedIds` with every id in `nodeIds` opened or closed. Returns the
 * original set when nothing changes, so callers can skip the state update and
 * the persistence write behind it.
 */
export function setFoldersExpanded(
  expandedIds: Set<string>,
  nodeIds: string[],
  expanded: boolean
): Set<string> {
  const changed = nodeIds.filter((id) => expandedIds.has(id) !== expanded)
  if (changed.length === 0) return expandedIds

  const next = new Set(expandedIds)
  for (const id of changed) {
    if (expanded) next.add(id)
    else next.delete(id)
  }
  return next
}

// ============================================================================
// Icon Utilities
// ============================================================================

/**
 * Uppercase extension label for non-markdown vault files (e.g. PDF, MP3, WAV).
 * Returns null for markdown notes and unknown files so the sidebar shows no badge.
 */
export function getFileExtensionLabel(note: NoteListItem): string | null {
  if (!note.fileType || note.fileType === 'markdown') return null
  const ext = getExtension(note.path)
  return ext ? ext.toUpperCase() : null
}

export function getFileIcon(note: NoteListItem): React.ReactElement {
  if (note.emoji) {
    return <NoteIconDisplay value={note.emoji} className="text-sm leading-none shrink-0" />
  }

  const fileType = note.fileType ?? 'markdown'
  const iconClass = 'h-4 w-4 text-muted-foreground shrink-0'

  switch (fileType) {
    case 'pdf':
      return <FileType2 className={`${iconClass} text-red-500`} />
    case 'image':
      return <Image className={`${iconClass} text-blue-500`} />
    case 'audio':
      return <Music className={`${iconClass} text-green-500`} />
    case 'video':
      return <Video className={`${iconClass} text-purple-500`} />
    case 'markdown':
    default:
      return <FileText className={iconClass} />
  }
}
