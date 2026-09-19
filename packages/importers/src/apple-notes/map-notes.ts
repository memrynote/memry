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
   * under different parents. Empty/"Notes" root segment → note root.
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
  // Leading dots go too: the segments are joined into a filesystem path, so a
  // dot-only folder name (`..`) would otherwise walk out of the importer root
  // — two of them in one chain escape the vault entirely. Stripped to '', such
  // a segment is dropped by the caller.
  return name
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
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
    // Name-based default-folder suppression applies at the account root only.
    // Apple Notes rejects two folders with the same name under one parent, so a
    // root-level "Notes" is the account's default folder — but "Work/Notes" is a
    // real folder the user made, and merging it into "Work" is the same
    // flattening bug as same-named leaves.
    if (index === 0 && DEFAULT_FOLDER_NAMES.has(folder.toLowerCase())) continue
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
