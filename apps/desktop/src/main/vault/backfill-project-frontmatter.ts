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
import { getNoteCacheById, getNoteTags } from '../notes/store'
import { getIndexDatabase, isIndexDatabaseInitialized } from '../database'
import { extractProperties, parseNote } from './frontmatter'
import { safeRead } from './file-ops'
import { toAbsolutePath } from './notes-io'
import { createLogger } from '../lib/logger'
import type { DataDb } from '../database'

const logger = createLogger('ProjectFrontmatterBackfill')

/** `settings` key holding the pending snapshot, then the completion marker. */
export const PROJECT_FRONTMATTER_BACKFILL_KEY = 'projectFrontmatterBackfill'

const DONE = 'done'

/** Project names to ensure are present on each note, keyed by note id. */
type PendingBackfill = Record<string, string[]>

/**
 * The base property record a note's rewrite is built from.
 *
 * `missing` — no index-cache row, so nothing can be written. Indexing has
 * already run by the time the apply phase executes, so an absent row means the
 * file is absent too; retrying on a later open would not change that.
 *
 * `unparseable` — the file's frontmatter block could not be parsed. `parseNote`
 * keeps such a block verbatim precisely so a writeback does not destroy it, but
 * `updateNote` re-stringifies from the parsed object (which is empty here), so
 * writing would replace the user's broken-but-intact YAML with nothing.
 *
 * `stale-tags` — the file names a tag the index cache does not know, i.e. it was
 * tagged while the app was closed. `updateNote` takes tags from the cache and
 * never from the file (`newTags = input.tags ?? existing.tags`), and
 * `setEntityProperties` has no way to pass them, so writing would delete that
 * tag from the file. Verified end-to-end, see the task report.
 */
type BaseProperties =
  | { kind: 'ok'; properties: Record<string, unknown> }
  | { kind: 'missing' }
  | { kind: 'unparseable' }
  | { kind: 'stale-tags' }

/**
 * The note's properties as they are **on disk**, not as the index cache
 * remembers them.
 *
 * This matters because the apply phase runs unattended at startup on files the
 * user never opened. `indexFile` skips any path already in the cache without
 * comparing mtimes and the watcher only starts afterwards, so for a note edited
 * outside Memry while the app was closed the cached record is stale by
 * construction. `updateNote` assigns `newFrontmatter.properties` wholesale, so
 * basing the rewrite on that cached record would delete keys the user added and
 * revert values they changed — and then sync the revert to every device.
 * Reading from disk makes the write a pure addition.
 */
async function readBaseProperties(noteId: string): Promise<BaseProperties> {
  const cached = getNoteCacheById(getIndexDatabase(), noteId)
  if (!cached) return { kind: 'missing' }

  const raw = await safeRead(toAbsolutePath(cached.path))
  if (raw === null) {
    // File unreadable — fall back to the cached record. The write that follows
    // will fail on the same missing file and land in the residual snapshot, so
    // no stale data reaches disk.
    const properties = getEntityPropertiesRecord(noteId)
    return properties ? { kind: 'ok', properties } : { kind: 'missing' }
  }

  const parsed = parseNote(raw, cached.path)
  if (parsed.frontmatterError) return { kind: 'unparseable' }

  // A strict subset check, not equality: the cached set also holds tags found
  // inline in the body, so it is legitimately a superset. Only a tag the cache
  // has never seen means the file moved on without us.
  const cachedTags = new Set(getNoteTags(getIndexDatabase(), noteId).map((t) => t.toLowerCase()))
  const fileTags = Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags : []
  for (const tag of fileTags) {
    if (typeof tag === 'string' && !cachedTags.has(tag.toLowerCase())) {
      return { kind: 'stale-tags' }
    }
  }

  return { kind: 'ok', properties: extractProperties(parsed.frontmatter) }
}

/**
 * Phase one: record which markdown notes owe which project names to their
 * frontmatter. No-op once the key exists, so it neither re-snapshots after
 * completion nor discards a snapshot a previous run failed to finish.
 */
export function snapshotProjectFrontmatterBackfill(db: DataDb): void {
  if (getSetting(db, PROJECT_FRONTMATTER_BACKFILL_KEY) !== null) return

  const links = listMarkdownNoteProjectLinks(db)

  // Nothing to record — leave the key unset so the next open looks again.
  // Marking the vault done here would strand a device provisioned by download or
  // link: its data.db holds no `project_links` at all until the first sync pulls
  // them, and `startSyncRuntime()` runs at the very end of `openVault`, long
  // after this phase. The re-check costs one indexed query per open.
  if (links.length === 0) return

  const pending: PendingBackfill = {}
  for (const link of links) {
    pending[link.noteId] = withProjectName(pending[link.noteId] ?? [], link.projectName)
  }

  setSetting(db, PROJECT_FRONTMATTER_BACKFILL_KEY, JSON.stringify(pending))

  logger.info('Snapshotted project links for frontmatter backfill', {
    notes: Object.keys(pending).length,
    links: links.length
  })
}

/**
 * Phase two: union the snapshotted names onto each note's on-disk properties and
 * write the whole record back. Only ever adds names; a note that already carries
 * all of them is not rewritten.
 *
 * Notes whose write fails are kept in the snapshot rather than dropped, so a
 * failure never costs the vault its links — the marker is only set once nothing
 * is outstanding.
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

  // Without this every note would fail inside the per-note guard below and the
  // whole snapshot would be marked done — one failed index rebuild (the
  // documented Windows EBUSY on deleting index.db throws before `rebuildIndex`
  // reaches `initIndexDatabase`, and `openVault` swallows it) would cost the
  // vault its entire legacy-link population.
  if (!isIndexDatabaseInitialized()) {
    logger.error('Index database unavailable, deferring project frontmatter backfill')
    return
  }

  const residual: PendingBackfill = {}
  let visited = 0
  let written = 0
  let skipped = 0
  let failed = 0
  let deferred = 0

  for (const [noteId, names] of Object.entries(pending)) {
    visited++
    try {
      const base = await readBaseProperties(noteId)

      if (base.kind === 'missing') {
        skipped += names.length
        continue
      }

      if (base.kind === 'unparseable') {
        skipped += names.length
        logger.warn('Skipping a note whose frontmatter could not be parsed', { noteId })
        continue
      }

      if (base.kind === 'stale-tags') {
        // Keep it pending: once the note is reindexed the cache catches up and a
        // later open can write it safely.
        residual[noteId] = names
        deferred++
        logger.warn('Deferring a note whose tags the index cache has not caught up with', {
          noteId
        })
        continue
      }

      const current = readProjectNames(base.properties)
      let next = current
      for (const name of names) next = withProjectName(next, name)

      // `withProjectName` is case-insensitive, so equal length means the note
      // already names every project it is linked to. Leave the file alone.
      if (next.length === current.length) continue

      const result = await setEntityProperties(noteId, {
        ...base.properties,
        [PROJECT_PROPERTY_KEY]: next
      })

      if (!result.success) {
        failed++
        residual[noteId] = names
        logger.warn('Could not backfill a note', { noteId, error: result.error })
        continue
      }

      written++
    } catch (err) {
      // One unwritable note must not cost the rest of the vault its links, and
      // must not be dropped from the snapshot either.
      failed++
      residual[noteId] = names
      logger.error('Failed to backfill a note', { noteId }, err)
    }
  }

  const outstanding = Object.keys(residual).length
  setSetting(
    db,
    PROJECT_FRONTMATTER_BACKFILL_KEY,
    outstanding > 0 ? JSON.stringify(residual) : DONE
  )

  logger.info('Backfilled project links into note frontmatter', {
    visited,
    written,
    skipped,
    failed,
    deferred,
    outstanding
  })
}
