import { FileText, FileType2, Image, Music, Video } from '@/lib/icons'
import { getExtension } from '@memry/shared/file-types'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import type { FolderInfo } from '../../../preload/index.d'
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
 * Strip the configured notes root (`defaultNoteFolder`) off a vault-relative
 * note path.
 *
 * Note paths from the index are relative to the VAULT root, but every folder
 * consumer — `folderExists`, the folder view's LIKE query, `.folder.md` config,
 * create/rename/delete folder — resolves folder paths against the NOTES root
 * (`<vault>/<defaultNoteFolder>`). This used to strip a hardcoded `notes`
 * literal, so any other value produced folder paths in the wrong base: a folder
 * named after `defaultNoteFolder` resolved to `<vault>/<root>/<root>` and the
 * view reported "Folder not found" (#1204).
 *
 * Tolerant on purpose: a path outside the notes root is returned unchanged,
 * matching `noteFolderFromPath` in @memry/app-core.
 */
export function stripNotesRoot(notePath: string, notesRoot: string): string {
  const root = notesRoot.replace(/^\/+|\/+$/g, '')
  if (!root) return notePath
  if (notePath === root) return ''
  return notePath.startsWith(`${root}/`) ? notePath.slice(root.length + 1) : notePath
}

export function extractFolderFromPath(notePath: string, notesRoot = ''): string {
  const parts = stripNotesRoot(notePath, notesRoot).split('/')
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

// ============================================================================
// Tree Building
// ============================================================================

export function buildTreeFromNotes(
  notes: NoteListItem[],
  folders: FolderInfo[],
  positions: Record<string, number>,
  notesRoot = ''
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
    // Folder nodes must stay in the same base as `folders` (notes-root-relative),
    // because their path is what the grid button hands to `folderExists`.
    const folderPath = extractFolderFromPath(note.path, notesRoot)

    if (!folderPath) {
      rootNotes.push(note)
    } else {
      ensureFolderInMap(folderPath).notes.push(note)
    }
  })

  const sortByPosition = (a: NoteListItem, b: NoteListItem): number => {
    const posA = positions[a.path] ?? Number.MAX_SAFE_INTEGER
    const posB = positions[b.path] ?? Number.MAX_SAFE_INTEGER
    if (posA !== posB) return posA - posB
    return b.modified.getTime() - a.modified.getTime()
  }

  const sortFoldersByPosition = (a: FolderNode, b: FolderNode): number => {
    const posA = positions[a.path] ?? Number.MAX_SAFE_INTEGER
    const posB = positions[b.path] ?? Number.MAX_SAFE_INTEGER
    if (posA !== posB) return posA - posB
    return a.name.localeCompare(b.name)
  }

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
    rootNotes
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
