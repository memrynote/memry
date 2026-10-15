/**
 * Brings a vault written under the ASCII-only tag identity onto the Unicode one
 * (`foldTag`, protocol chapter 13 §13.7.7). Runs on every vault open and is a
 * no-op once converged. The sync handler also merges the definitions of a tag
 * it just created (`mergeDefinitions`), so a peer's spelling of a local tag
 * does not show as a second tag until the next open.
 *
 * Builds before the Unicode fold kept `Ünal` and `ünal` apart wherever SQLite
 * `COLLATE NOCASE` decided, so a vault can hold:
 * - two tag definitions that are now one tag (`Ünal` minted from the tag hub
 *   with its typed spelling, `ünal` from the indexer; or `i̇ş`, the old full
 *   lowercase of `İş`, beside `iş`). One survives (`pickSurvivor`), takes
 *   whatever the others hold that it lacks, and the others are deleted and the
 *   delete synced. Every device picks the same survivor from the same rows, so
 *   devices converge on one sync id without ping-pong.
 * - two usage rows of one tag on one task, inbox item or note. The first one
 *   is kept (the note's earliest position), so a carrier lists each tag once.
 *   A note's kept row takes the earliest pin of the rows dropped with it.
 */
import { sql } from 'drizzle-orm'
import type { DataDb, IndexDb } from '../database'
import { createLogger } from '../lib/logger'
import { mergeDefinitions } from './merge-definitions'
import { syncTagDefinitionDelete, syncTagDefinitionUpdate } from './runtime-effects'

const log = createLogger('TagIdentity')

function dropDuplicateUsages(dataDb: DataDb, indexDb: IndexDb): number {
  const tasks = dataDb.run(sql`
    DELETE FROM task_tags WHERE rowid IN (
      SELECT t.rowid FROM task_tags t JOIN task_tags o
        ON o.task_id = t.task_id AND o.rowid < t.rowid AND tag_fold(o.tag) = tag_fold(t.tag))`)
  const inbox = dataDb.run(sql`
    DELETE FROM inbox_item_tags WHERE rowid IN (
      SELECT t.rowid FROM inbox_item_tags t JOIN inbox_item_tags o
        ON o.item_id = t.item_id AND o.rowid < t.rowid AND tag_fold(o.tag) = tag_fold(t.tag))`)
  indexDb.run(sql`
    UPDATE note_tags SET pinned_at = (
      SELECT MIN(o.pinned_at) FROM note_tags o
       WHERE o.note_id = note_tags.note_id AND tag_fold(o.tag) = tag_fold(note_tags.tag))
     WHERE pinned_at IS NULL AND EXISTS (
      SELECT 1 FROM note_tags o
       WHERE o.note_id = note_tags.note_id AND o.rowid <> note_tags.rowid
         AND tag_fold(o.tag) = tag_fold(note_tags.tag) AND o.pinned_at IS NOT NULL)`)
  const notes = indexDb.run(sql`
    DELETE FROM note_tags WHERE rowid IN (
      SELECT t.rowid FROM note_tags t JOIN note_tags o
        ON o.note_id = t.note_id AND tag_fold(o.tag) = tag_fold(t.tag)
       AND (o.position < t.position OR (o.position = t.position AND o.rowid < t.rowid)))`)
  return tasks.changes + inbox.changes + notes.changes
}

export function convergeTagIdentity(
  dataDb: DataDb,
  indexDb: IndexDb
): { definitionsMerged: number; usagesDropped: number } {
  const definitionsMerged = mergeDefinitions(dataDb, {
    deleted: syncTagDefinitionDelete,
    updated: syncTagDefinitionUpdate
  })
  const usagesDropped = dropDuplicateUsages(dataDb, indexDb)
  if (usagesDropped > 0) log.info('Dropped duplicate tag rows', { usagesDropped })
  return { definitionsMerged, usagesDropped }
}
