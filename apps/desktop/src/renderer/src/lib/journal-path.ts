/**
 * Renderer-side journal path check, for the sidebar's confirmations.
 *
 * Mirrors main's detector (`journal-queries.ts`): a journal entry is a file
 * under the journal folder whose path relative to it matches the date format.
 * Main stays the authority; this only decides whether to ask the user first.
 */

import {
  formatJournalFilename,
  normalizeJournalDateFormat,
  normalizeJournalFolder,
  parseJournalDate
} from '@memry/storage-vault/journal-format'

interface JournalLayout {
  journalFolder: string
  journalDateFormat: string
}

/** The date `path` would be the journal entry for, or null when it would be a note. */
export function journalDateForPath(path: string, layout: JournalLayout): string | null {
  // Settings shapes from older builds may lack a field; no folder, no journal.
  if (typeof layout.journalFolder !== 'string') return null
  const folder = normalizeJournalFolder(layout.journalFolder)
  if (!folder || !path.startsWith(`${folder}/`) || !path.endsWith('.md')) return null
  const stem = path.slice(folder.length + 1, -'.md'.length)
  return parseJournalDate(stem, normalizeJournalDateFormat(layout.journalDateFormat ?? ''))
}

/** The vault-relative path main writes the entry for `date` to (`getJournalRelativePath`). */
export function journalPathForDate(date: string, layout: JournalLayout): string {
  const folder = normalizeJournalFolder(layout.journalFolder ?? '')
  const stem = formatJournalFilename(
    date,
    normalizeJournalDateFormat(layout.journalDateFormat ?? '')
  )
  return folder ? `${folder}/${stem}.md` : `${stem}.md`
}

/** True when `folderPath` is the journal folder or one of its ancestors. */
export function containsJournalFolder(folderPath: string, journalFolder: string): boolean {
  if (typeof journalFolder !== 'string') return false
  const folder = normalizeJournalFolder(journalFolder)
  return !!folder && (folder === folderPath || folder.startsWith(`${folderPath}/`))
}
