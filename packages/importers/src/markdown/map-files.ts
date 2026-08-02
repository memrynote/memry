/**
 * Map a list of file descriptors to an import plan.
 *
 * Pure function — no fs access.
 */

import * as path from 'path'
import type { FileDescriptor, MarkdownImportPlan, NotePlan } from './types.ts'

const MD_EXTENSIONS = new Set(['.md', '.markdown'])

/** Derive the vault folder for a note given its relPath under the selection root. */
function vaultFolder(relPath: string): string {
  const dir = path.dirname(relPath)
  if (dir === '.') return 'Markdown'
  return `Markdown/${dir}`
}

/** Derive note title from filename, stripping the extension. */
function noteTitle(relPath: string): string {
  return path.basename(relPath, path.extname(relPath))
}

/**
 * Given a list of file descriptors (relPath + absPath), return an import plan
 * containing only files with a recognised markdown extension.
 */
export function mapFiles(files: FileDescriptor[]): MarkdownImportPlan {
  const notes: NotePlan[] = []

  for (const { relPath, absPath, rootDir } of files) {
    const ext = path.extname(relPath).toLowerCase()
    if (!MD_EXTENSIONS.has(ext)) continue

    notes.push({
      absPath,
      title: noteTitle(relPath),
      vaultFolder: vaultFolder(relPath),
      rootDir
    })
  }

  return { notes }
}
