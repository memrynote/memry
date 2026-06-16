/**
 * Map a list of HTML file descriptors to an import plan.
 *
 * Pure function — no fs access.
 */

import * as path from 'path'
import type { HtmlFileDescriptor, HtmlImportPlan, HtmlNotePlan } from './types.ts'

const HTML_EXTENSIONS = new Set(['.html', '.htm'])

/** Derive the vault folder for a note given its relPath under the selection root. */
function vaultFolder(relPath: string): string {
  const dir = path.dirname(relPath)
  if (dir === '.') return 'HTML'
  return `HTML/${dir}`
}

/**
 * Given a list of HTML file descriptors, return an import plan containing only
 * files with a recognised HTML extension.
 */
export function mapFiles(files: HtmlFileDescriptor[]): HtmlImportPlan {
  const notes: HtmlNotePlan[] = []

  for (const { relPath, absPath, title } of files) {
    const ext = path.extname(relPath).toLowerCase()
    if (!HTML_EXTENSIONS.has(ext)) continue

    notes.push({
      absPath,
      title,
      vaultFolder: vaultFolder(relPath)
    })
  }

  return { notes }
}
