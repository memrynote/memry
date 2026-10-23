import { eq, inArray } from 'drizzle-orm'
import { tasks } from '@memry/db-schema/data-schema'
import { syncIntents } from '@memry/db-schema/schema/sync-intents'
import type { DrizzleDb as DataDb } from '@memry/db-schema/drizzle-db'

export interface DeleteTaskOptions {
  /**
   * Keep the subtasks and move each direct child up to the deleted task's own
   * parent, the desktop drawer's "keep subtasks" outcome. Default: the whole
   * subtask branch is deleted with its parent.
   */
  keepSubtasks?: boolean
}

function subtaskIds(db: DataDb, parentId: string): string[] {
  return db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.parentId, parentId))
    .all()
    .map((row) => row.id)
}

/**
 * Deletes tasks the way `packages/domain-tasks` `deleteTask` does: a parent never
 * leaves a subtask with a `parent_id` that points at a deleted row.
 *
 * Sync cannot see a cascade (#2854), so every removed row owes the server its own
 * `delete` intent carrying the row snapshot (clock included). Intents commit with
 * the deletes; the desktop app replays them into tombstones and queue rows on its
 * next sync runtime start or pull, the same path its own deletes take.
 *
 * Returns the number of requested ids that existed.
 */
export function deleteTaskBranches(
  db: DataDb,
  ids: string[],
  options: DeleteTaskOptions = {}
): number {
  if (ids.length === 0) return 0
  return db.transaction((tx) => {
    const requested = tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.id, ids))
      .all()
      .map((row) => row.id)
    const createdAt = new Date()

    const removeRow = (id: string): void => {
      const snapshot = tx.select().from(tasks).where(eq(tasks.id, id)).get()
      if (!snapshot) return
      tx.delete(tasks).where(eq(tasks.id, id)).run()
      tx.insert(syncIntents)
        .values({
          type: 'task',
          itemId: id,
          op: 'delete',
          args: JSON.stringify([JSON.stringify(snapshot)]),
          createdAt
        })
        .run()
    }

    for (const id of requested) {
      const row = tx.select().from(tasks).where(eq(tasks.id, id)).get()
      // An earlier branch in this call already removed it.
      if (!row) continue

      if (options.keepSubtasks) {
        for (const childId of subtaskIds(tx, id)) {
          tx.update(tasks)
            .set({ parentId: row.parentId, modifiedAt: createdAt.toISOString() })
            .where(eq(tasks.id, childId))
            .run()
          tx.insert(syncIntents)
            .values({
              type: 'task',
              itemId: childId,
              op: 'update',
              args: JSON.stringify([['parentId']]),
              createdAt
            })
            .run()
        }
        removeRow(id)
        continue
      }

      const branch: string[] = []
      const seen = new Set([id])
      for (let i = -1; i < branch.length; i++) {
        for (const childId of subtaskIds(tx, i < 0 ? id : branch[i])) {
          if (seen.has(childId)) continue
          seen.add(childId)
          branch.push(childId)
        }
      }
      // Deepest first, parent last.
      for (const taskId of [...branch.reverse(), id]) removeRow(taskId)
    }
    return requested.length
  })
}
