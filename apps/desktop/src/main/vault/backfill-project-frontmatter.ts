/**
 * One-time, per-vault backfill of pre-existing `project_links` rows into note
 * frontmatter.
 *
 * Frontmatter is now the source of truth for a markdown note's project
 * membership, and the note-project-links projector derives the rows from it. A
 * row written before that — in practice the project hub's file importer, which
 * wrote `('file', <markdown note id>)` when a `.md` was imported into a project
 * — names no project in the note's frontmatter, so the first reconcile of that
 * note would delete the row and the membership would silently vanish.
 *
 * Runs in two phases because no single point in `openVault` can do both halves:
 *
 * - `snapshotProjectFrontmatterBackfill` reads the rows out of data.db and
 *   persists them. It runs before the projection runtime starts, so nothing can
 *   have reconciled a row away yet. The index database is not open at that
 *   point, so it cannot write.
 * - `applyProjectFrontmatterBackfill` writes the persisted names into the notes.
 *   It runs after indexing, which is the earliest point the index cache
 *   `setEntityProperties` resolves entities through is usable on both the
 *   healthy path (`initIndexDatabase`) and the unhealthy one (`rebuildIndex`).
 *
 * Persisting the snapshot rather than passing it in memory is what makes the gap
 * safe: `rebuildIndex` republishes `note.upserted` for every note and the
 * projector deletes their rows, so if the app were killed mid-rebuild an
 * in-memory snapshot would take the only remaining record of those memberships
 * with it.
 *
 * @module vault/backfill-project-frontmatter
 */

import { PROJECT_PROPERTY_KEY } from '@memry/contracts/property-types'
import { listMarkdownNoteProjectLinks } from '@main/database/queries/projects'
import { getSetting, setSetting } from '@main/database/queries/settings'
import { getEntityPropertiesRecord, setEntityProperties } from '../notes/entity-properties'
import { readProjectNames, withProjectName } from '../notes/project-property'
import { createLogger } from '../lib/logger'
import type { DataDb } from '../database'

const logger = createLogger('ProjectFrontmatterBackfill')

/** `settings` key holding the pending snapshot, then the completion marker. */
export const PROJECT_FRONTMATTER_BACKFILL_KEY = 'projectFrontmatterBackfill'

const DONE = 'done'

/** Project names to ensure are present on each note, keyed by note id. */
type PendingBackfill = Record<string, string[]>

/**
 * Phase one: record which markdown notes owe which project names to their
 * frontmatter. No-op once the key exists, so it neither re-snapshots after
 * completion nor discards a snapshot a previous run failed to finish.
 */
export function snapshotProjectFrontmatterBackfill(db: DataDb): void {
  if (getSetting(db, PROJECT_FRONTMATTER_BACKFILL_KEY) !== null) return

  const links = listMarkdownNoteProjectLinks(db)
  const pending: PendingBackfill = {}
  for (const link of links) {
    pending[link.noteId] = withProjectName(pending[link.noteId] ?? [], link.projectName)
  }

  setSetting(db, PROJECT_FRONTMATTER_BACKFILL_KEY, JSON.stringify(pending))

  if (links.length > 0) {
    logger.info('Snapshotted project links for frontmatter backfill', {
      notes: Object.keys(pending).length,
      links: links.length
    })
  }
}

/**
 * Phase two: union the snapshotted names onto each note's existing properties
 * and write the whole record back. Only ever adds names; a note that already
 * carries all of them is not rewritten.
 */
export async function applyProjectFrontmatterBackfill(db: DataDb): Promise<void> {
  const raw = getSetting(db, PROJECT_FRONTMATTER_BACKFILL_KEY)
  if (raw === null || raw === DONE) return

  let pending: PendingBackfill
  try {
    pending = JSON.parse(raw) as PendingBackfill
  } catch {
    // Nothing can be recovered from an unreadable snapshot, and retrying it
    // every open would only repeat the failure.
    logger.error('Unreadable project frontmatter backfill snapshot, skipping')
    setSetting(db, PROJECT_FRONTMATTER_BACKFILL_KEY, DONE)
    return
  }

  let visited = 0
  let written = 0
  let skipped = 0

  for (const [noteId, names] of Object.entries(pending)) {
    visited++
    try {
      const properties = getEntityPropertiesRecord(noteId)
      if (!properties) {
        // Note deleted since the snapshot — its link is already gone too.
        skipped += names.length
        continue
      }

      const current = readProjectNames(properties)
      let next = current
      for (const name of names) next = withProjectName(next, name)

      // `withProjectName` is case-insensitive, so equal length means the note
      // already names every project it is linked to. Leave the file alone.
      if (next.length === current.length) continue

      const result = await setEntityProperties(noteId, {
        ...properties,
        [PROJECT_PROPERTY_KEY]: next
      })

      if (!result.success) {
        skipped += names.length
        logger.warn('Could not backfill a note', { noteId, error: result.error })
        continue
      }

      written++
    } catch (err) {
      // One unwritable note must not cost the rest of the vault its links.
      skipped += names.length
      logger.error('Failed to backfill a note', err)
    }
  }

  setSetting(db, PROJECT_FRONTMATTER_BACKFILL_KEY, DONE)

  if (visited > 0) {
    logger.info('Backfilled project links into note frontmatter', { visited, written, skipped })
  }
}
