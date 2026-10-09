import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'
import { commitLocalChange } from '../sync/sync-intents'
import { getDatabase, type DataDb } from '../database'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { tagKey } from '@memry/shared/tag-fold'
import { tagIs } from '../database/queries/tag-match'

/**
 * A tag definition's sync id is the name its row is stored under, which keeps
 * the spelling the tag was first written with (`Ünal`). Callers name the tag in
 * any spelling, so the id is read back from the row by tag identity.
 */
function definitionId(tag: string): string {
  return (
    getDatabase()
      .select({ name: tagDefinitions.name })
      .from(tagDefinitions)
      .where(tagIs(tagDefinitions.name, tag.trim()))
      .get()?.name ?? tagKey(tag)
  )
}

interface DefinitionSnapshot {
  name: string
}

export function syncTagDefinitionRename(
  newName: string,
  oldTagSnapshot?: DefinitionSnapshot
): void {
  if (oldTagSnapshot) {
    enqueueLocalSyncDelete('tag_definition', oldTagSnapshot.name, JSON.stringify(oldTagSnapshot))
    enqueueLocalSyncCreate('tag_definition', definitionId(newName))
  }
}

export function syncTagDefinitionUpdate(tag: string): void {
  enqueueLocalSyncUpdate('tag_definition', definitionId(tag))
}

export function syncTagDefinitionDelete(tagSnapshot?: DefinitionSnapshot): void {
  if (tagSnapshot) {
    enqueueLocalSyncDelete('tag_definition', tagSnapshot.name, JSON.stringify(tagSnapshot))
  }
}

export function syncMergedTagDefinitions(
  target: string,
  sourceSnapshot?: DefinitionSnapshot
): void {
  if (sourceSnapshot) {
    enqueueLocalSyncDelete('tag_definition', sourceSnapshot.name, JSON.stringify(sourceSnapshot))
    enqueueLocalSyncCreate('tag_definition', definitionId(target))
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
