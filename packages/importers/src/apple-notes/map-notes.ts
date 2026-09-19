/**
 * Map raw Apple Notes row metadata into the shape the desktop importer feeds
 * to createNote. Pure: no SQLite, no fs — the desktop layer reads the columns
 * and hands them here.
 */

import { coreTimeToIso } from './coretime.ts'

/** Raw metadata read from the NoteStore.sqlite row for one note. */
export interface AppleNoteRow {
  title: string
  /** Account display name (e.g. "iCloud", "On My Mac"). */
  accountName?: string | null
  /**
   * Folder chain from the account root down to the note's folder (leaf last).
   * Apple Notes folders nest, so a single name would merge same-named leaves
   * under different parents. Empty/"Notes" leaf → note root.
   */
  folderPath?: string[]
  /** CoreTime seconds (since 2001-01-01) for created/modified. */
  createdCoreTime?: number | null
  modifiedCoreTime?: number | null
  passwordProtected?: boolean
}

/** Normalised note metadata ready for createNote. */
export interface MappedNote {
  title: string
  /** Vault-relative folder under the importer root (no leading/trailing slash). */
  folder: string
  created?: string
  modified?: string
}

const DEFAULT_FOLDER_NAMES = new Set(['', 'notes'])

function sanitizeSegment(name: string): string {
  // Keep names readable but strip path separators and collapse whitespace.
  return name
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Build the importer-relative folder path for a note.
 *
 * @param root the importer root folder (e.g. "Apple Notes")
 * @param multiAccount whether more than one account exists (then nest by account)
 */
export function mapNote(root: string, row: AppleNoteRow, multiAccount: boolean): MappedNote {
  const segments: string[] = [root]

  if (multiAccount && row.accountName) {
    const account = sanitizeSegment(row.accountName)
    if (account) segments.push(account)
  }

  const folderPath = row.folderPath ?? []
  for (const [index, raw] of folderPath.entries()) {
    const folder = sanitizeSegment(raw)
    if (!folder) continue
    // Default-folder suppression is leaf-only: "Work/Notes" is a real folder
    // named Notes inside Work, not the account's default folder.
    const isLeaf = index === folderPath.length - 1
    if (isLeaf && DEFAULT_FOLDER_NAMES.has(folder.toLowerCase())) continue
    segments.push(folder)
  }

  const result: MappedNote = {
    title: row.title,
    folder: segments.filter(Boolean).join('/')
  }

  if (row.createdCoreTime != null) result.created = coreTimeToIso(row.createdCoreTime)
  if (row.modifiedCoreTime != null) result.modified = coreTimeToIso(row.modifiedCoreTime)

  return result
}
