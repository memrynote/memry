import path from 'node:path'

import type { FolderEntry } from './handles'

// Tool paths are vault-relative with no leading slash ("projects/active"), the
// form the renderer uses for folder links. Inputs may still carry one (#2622).
// `defaultNoteFolder` is not part of this mapping: it names where a new note
// goes, not where folders live, so an agent must see the same tree the sidebar
// does (#1204).
export function normalizeFolderPath(value: string | undefined): string {
  return (value ?? '').replace(/^\/+|\/+$/g, '')
}

export function internalFolderFromToolPath(toolPath: string | undefined): string | undefined {
  return normalizeFolderPath(toolPath ?? '') || undefined
}

export function isDirectChild(basePath: string, candidatePath: string): boolean {
  const normalizedBase = normalizeFolderPath(basePath)
  const normalizedCandidate = normalizeFolderPath(candidatePath)

  if (!normalizedBase) {
    return !normalizedCandidate.includes('/')
  }

  if (!normalizedCandidate.startsWith(`${normalizedBase}/`)) {
    return false
  }

  return !normalizedCandidate.slice(normalizedBase.length + 1).includes('/')
}

export function toFolderEntry(folderPath: string): FolderEntry {
  return {
    kind: 'folder',
    id: folderPath,
    name: path.posix.basename(folderPath),
    path: folderPath
  }
}

export function folderPathFromNotePath(notePath: string): string | null {
  // `dirname` reports '.' for a note sitting directly in the vault root, which
  // is reachable now that folder paths are vault-relative (#1204).
  const parent = path.posix.dirname(notePath)
  return normalizeFolderPath(parent === '.' ? '' : parent) || null
}
