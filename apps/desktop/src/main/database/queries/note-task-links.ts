/**
 * Queries for the `note_task_links` snapshot table (data.db, local-only).
 * Rows mirror the task lines last written to a note's file and feed the
 * re-match candidates when a Y.Doc is seeded from disk.
 *
 * Deleting a task removes its row via FK cascade (foreign_keys = ON).
 *
 * @module db/queries/note-task-links
 */

import { asc, eq, inArray } from 'drizzle-orm'
import { noteTaskLinks, type NoteTaskLinkRow } from '@memry/db-schema/schema/note-task-links'
import { tasks } from '@memry/db-schema/schema/tasks'
import type { NoteTaskLink } from '@memry/shared/task-block'
import type { DataDb } from '../types'

/** Snapshot rows for a note, in doc order. */
export function getNoteTaskLinks(db: DataDb, noteId: string): NoteTaskLinkRow[] {
  return db
    .select()
    .from(noteTaskLinks)
    .where(eq(noteTaskLinks.noteId, noteId))
    .orderBy(asc(noteTaskLinks.position))
    .all()
}

/** Replace a note's snapshot rows with the links just written to its file. */
export function replaceNoteTaskLinks(db: DataDb, noteId: string, links: NoteTaskLink[]): void {
  db.transaction((tx) => {
    tx.delete(noteTaskLinks).where(eq(noteTaskLinks.noteId, noteId)).run()
    if (links.length === 0) return
    // Ghost blocks (task deleted in the tasks UI while the note doc still holds
    // the block) serialize as plain checkboxes — never snapshot them, and the
    // FK to tasks would reject them anyway.
    const liveIds = new Set(
      tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          inArray(
            tasks.id,
            links.map((link) => link.taskId)
          )
        )
        .all()
        .map((row) => row.id)
    )
    const rows = links.filter((link) => liveIds.has(link.taskId))
    if (rows.length === 0) return
    tx.insert(noteTaskLinks)
      .values(
        rows.map((link) => ({
          taskId: link.taskId,
          noteId,
          title: link.title,
          checked: link.checked,
          position: link.position,
          anchor: link.anchor
        }))
      )
      .onConflictDoNothing()
      .run()
  })
}

/** Drop a single snapshot row (externally deleted line — task row stays). */
export function deleteNoteTaskLink(db: DataDb, taskId: string): void {
  db.delete(noteTaskLinks).where(eq(noteTaskLinks.taskId, taskId)).run()
}
