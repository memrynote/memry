import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'
import { commitLocalChange } from '../sync/sync-intents'
import type { DataDb } from '../database'

export function syncTaggedNote(noteId: string): void {
  enqueueLocalSyncUpdate('note', noteId)
}

export function syncTagDefinitionRename(
  oldName: string,
  newName: string,
  oldTagSnapshot?: unknown
): void {
  if (oldTagSnapshot) {
    enqueueLocalSyncDelete('tag_definition', oldName, JSON.stringify(oldTagSnapshot))
    enqueueLocalSyncCreate('tag_definition', newName.toLowerCase().trim())
  }
}

export function syncTagDefinitionUpdate(tag: string): void {
  enqueueLocalSyncUpdate('tag_definition', tag)
}

export function syncTagDefinitionDelete(tag: string, tagSnapshot?: unknown): void {
  if (tagSnapshot) {
    enqueueLocalSyncDelete('tag_definition', tag.toLowerCase().trim(), JSON.stringify(tagSnapshot))
  }
}

export function syncMergedTagDefinitions(
  source: string,
  target: string,
  sourceSnapshot?: unknown
): void {
  if (sourceSnapshot) {
    enqueueLocalSyncDelete('tag_definition', source, JSON.stringify(sourceSnapshot))
    enqueueLocalSyncCreate('tag_definition', target)
  }
}

export function syncTagCategoryCreate(id: string): void {
  enqueueLocalSyncCreate('tag_category', id)
}

export function syncTagCategoryUpdate(id: string): void {
  enqueueLocalSyncUpdate('tag_category', id)
}

export function syncTagCategoryDelete(id: string): void {
  enqueueLocalSyncDelete('tag_category', id)
}

/**
 * Runs a task retag and commits a sync intent per retagged task with it
 * (#2301). A `task_tags` write does not move `tasks.modified_at`, so a push
 * lost after the retag would be invisible to the dirty sweep.
 */
export function commitTaskRetag<T extends { taskIds: string[] }>(db: DataDb, retag: () => T): T {
  return commitLocalChange(db, () => {
    const result = retag()
    return {
      value: result,
      intents: result.taskIds.map((taskId) => ({
        type: 'task' as const,
        itemId: taskId,
        op: 'update' as const,
        args: [['tags']]
      }))
    }
  })
}
