/**
 * Rename existing journal files when the journal date format changes.
 *
 * A format may carry folder segments (`YYYY/MMMM/YYYY-MM-DD`), so a rename can
 * move a file between subfolders of the journal folder: `2025-01-14.md` becomes
 * `2025/January/2025-01-14.md` and back. Target folders are created on demand,
 * and source folders a move leaves empty are removed, never the journal folder
 * itself and never a folder that still holds anything.
 *
 * A file only counts as a journal entry while its name matches the configured
 * format. Without this, switching `YYYY-MM-DD` to `YYYY-MM-DD dddd` leaves
 * `journal/2026-09-25.md` behind as a plain note: the day shows empty in the
 * Journal, and writing to it creates a second file, `2026-09-25 Friday.md`.
 *
 * Only the filename changes. A journal's identity is its date: sync items and
 * CRDT docs are keyed by note id, never by path, and the path is rebuilt from
 * the date and the local format on every device. So the canonical row keeps its
 * id, clock and journal date and only its `path` moves; the index rebuild that
 * follows a format change then adopts that id at the new path.
 *
 * Never overwrites. A target name that is already taken on disk, already held
 * by a canonical row, or claimed by another file in the same pass leaves the
 * source untouched. A format that cannot round-trip a date (missing year, month
 * or day) renames nothing.
 *
 * Refuses before renaming anything when an entry it would rename is locked, or
 * a rename would move one into a locked folder: a locked journal keeps its
 * name, and a partial pass would leave the journal split across two formats.
 *
 * The caller must stop the watcher first: the watcher reads paths with the
 * config of the moment, so an unlink seen mid-migration would classify the old
 * name with the new format and could send the journal to sync as deleted.
 *
 * @module vault/journal-format-migration
 */

import fs from 'fs/promises'
import path from 'path'
import {
  formatJournalFilename,
  normalizeJournalFolder,
  parseJournalDate
} from '@memry/storage-vault'
import { getNoteMetadataByPath, updateNoteMetadata } from '@memry/storage-data'
import { carryPositionToPath } from '@main/database/queries/note-positions'
import { getDatabase } from '../database'
import { createLogger } from '../lib/logger'
import {
  isLockedWriteAllowed,
  isVaultPathLocked,
  noteLockedError,
  vaultLockSource
} from '../vault-locks/registry'

const logger = createLogger('JournalFormatMigration')

export interface JournalRename {
  from: string
  to: string
  date: string
}

export interface JournalRenameSkip {
  file: string
  reason: 'target-exists' | 'unrepresentable'
}

export interface JournalRenamePlan {
  renames: JournalRename[]
  skipped: JournalRenameSkip[]
}

export interface JournalRenameResult {
  /** The renames that landed, file and row both; `revertJournalRenames` takes them back. */
  moved: JournalRename[]
  skipped: number
  failed: number
}

// Two-digit month and day, distinct from each other and across both dates, so a
// format missing any of year, month or day cannot round-trip them.
const PROBE_DATES = ['2026-11-28', '2031-12-31']

/** True when every date renders to a name that parses back to the same date. */
export function isCompleteJournalFormat(format: string): boolean {
  return PROBE_DATES.every(
    (iso) => parseJournalDate(formatJournalFilename(iso, format), format) === iso
  )
}

/**
 * Pure planner over the files of the journal folder, as `/`-separated paths
 * relative to it (`2025-01-14.md`, `2025/01/2025-01-14.md`). Collisions are
 * compared case-insensitively: on the default macOS and Windows
 * filesystems two names differing only in case are the same file.
 */
export function planJournalRenames(
  fileNames: readonly string[],
  oldFormat: string,
  newFormat: string
): JournalRenamePlan {
  const renames: JournalRename[] = []
  const skipped: JournalRenameSkip[] = []
  const present = new Set(fileNames.map((name) => name.toLowerCase()))
  const claimed = new Set<string>()

  for (const name of [...fileNames].sort()) {
    if (!name.endsWith('.md')) continue
    const date = parseJournalDate(name.slice(0, -3), oldFormat)
    if (!date) continue

    const stem = formatJournalFilename(date, newFormat)
    const target = `${stem}.md`
    if (target === name) continue

    if (parseJournalDate(stem, newFormat) !== date) {
      skipped.push({ file: name, reason: 'unrepresentable' })
      continue
    }

    const key = target.toLowerCase()
    const caseOnly = key === name.toLowerCase()
    if ((present.has(key) && !caseOnly) || claimed.has(key)) {
      skipped.push({ file: name, reason: 'target-exists' })
      continue
    }

    claimed.add(key)
    renames.push({ from: name, to: target, date })
  }

  return { renames, skipped }
}

/**
 * Every file under `dir`, as a `/`-separated path relative to it. Dot entries
 * (`.obsidian`, editor temp files) are skipped. `null` when `dir` is missing.
 */
async function listFilesRecursive(dir: string): Promise<string[] | null> {
  const files: string[] = []

  const walk = async (relativeDir: string): Promise<void> => {
    const entries = await fs.readdir(path.join(dir, relativeDir), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(relative)
      else if (entry.isFile()) files.push(relative)
    }
  }

  try {
    await walk('')
    return files
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Remove the now-empty folders between `relativeFile` and the journal folder. */
async function pruneEmptyParents(dir: string, relativeFile: string): Promise<void> {
  let parent = path.posix.dirname(relativeFile)
  while (parent !== '.' && parent !== '') {
    try {
      // rmdir refuses a non-empty folder, which is exactly the guard we want.
      await fs.rmdir(path.join(dir, parent))
    } catch {
      return
    }
    parent = path.posix.dirname(parent)
  }
}

export async function renameJournalsForFormatChange(
  vaultPath: string,
  journalFolder: string,
  oldFormat: string,
  newFormat: string
): Promise<JournalRenameResult> {
  const result: JournalRenameResult = { moved: [], skipped: 0, failed: 0 }
  const folder = normalizeJournalFolder(journalFolder)
  if (!folder) return result

  if (!isCompleteJournalFormat(newFormat)) {
    logger.warn('New journal date format cannot name every date; leaving files as they are', {
      newFormat
    })
    return result
  }

  const dir = path.join(vaultPath, folder)
  const fileNames = await listFilesRecursive(dir)
  if (!fileNames) return result

  const plan = planJournalRenames(fileNames, oldFormat, newFormat)
  result.skipped = plan.skipped.length
  if (plan.renames.length === 0) {
    if (plan.skipped.length > 0) logger.warn('Journal files not renamed', { skipped: plan.skipped })
    return result
  }

  if (!isLockedWriteAllowed()) {
    const locked = plan.renames.find(
      ({ from, to }) =>
        isVaultPathLocked(`${folder}/${from}`) || isVaultPathLocked(`${folder}/${to}`)
    )
    if (locked) {
      throw noteLockedError(
        vaultLockSource()?.noteIdAtPath(`${folder}/${locked.from}`) ?? undefined
      )
    }
  }

  const db = getDatabase()

  for (const rename of plan.renames) {
    const { from, to } = rename
    const fromRel = `${folder}/${from}`
    const toRel = `${folder}/${to}`

    // `note_metadata.path` is unique; a leftover row at the target would make
    // the path update throw after the file had already moved.
    const holder = getNoteMetadataByPath(db, toRel)
    if (holder) {
      result.skipped += 1
      plan.skipped.push({ file: from, reason: 'target-exists' })
      continue
    }

    try {
      await fs.mkdir(path.dirname(path.join(dir, to)), { recursive: true })
      await fs.rename(path.join(dir, from), path.join(dir, to))
    } catch (error) {
      result.failed += 1
      logger.warn('Journal rename failed', { from: fromRel, to: toRel, error })
      continue
    }

    try {
      const row = getNoteMetadataByPath(db, fromRel)
      if (row) updateNoteMetadata(db, row.id, { path: toRel })
      carryPositionToPath(db, fromRel, toRel)
      result.moved.push(rename)
      await pruneEmptyParents(dir, from)
    } catch (error) {
      // File and row must agree, or the rebuild mints a new id for the moved
      // file and strands the old row. Put the file back.
      result.failed += 1
      logger.error('Journal metadata update failed; restoring file name', {
        from: fromRel,
        to: toRel,
        error
      })
      await fs.rename(path.join(dir, to), path.join(dir, from)).catch((restoreError) => {
        logger.error('Could not restore journal file name', { path: toRel, error: restoreError })
      })
    }
  }

  logger.info('Journal files renamed for new date format', {
    oldFormat,
    newFormat,
    renamed: result.moved.length,
    skipped: result.skipped,
    failed: result.failed
  })
  if (plan.skipped.length > 0) logger.warn('Journal files not renamed', { skipped: plan.skipped })

  return result
}

/**
 * Take back the renames of a format change whose new format was not saved, so
 * every journal file matches the format it is read with again. Newest first,
 * file then row, the same pairing the forward pass keeps. A file that cannot
 * go back is logged and left where it is.
 */
export async function revertJournalRenames(
  vaultPath: string,
  journalFolder: string,
  moved: readonly JournalRename[]
): Promise<void> {
  const folder = normalizeJournalFolder(journalFolder)
  if (!folder || moved.length === 0) return
  const dir = path.join(vaultPath, folder)
  const db = getDatabase()

  for (const { from, to } of [...moved].reverse()) {
    const fromRel = `${folder}/${from}`
    const toRel = `${folder}/${to}`
    try {
      await fs.mkdir(path.dirname(path.join(dir, from)), { recursive: true })
      await fs.rename(path.join(dir, to), path.join(dir, from))
      const row = getNoteMetadataByPath(db, toRel)
      if (row) updateNoteMetadata(db, row.id, { path: fromRel })
      carryPositionToPath(db, toRel, fromRel)
      await pruneEmptyParents(dir, to)
    } catch (error) {
      logger.error('Could not move a journal file back to its old name', {
        from: toRel,
        to: fromRel,
        error
      })
    }
  }
}
