import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

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

export function syncTaggedTasks(taskIds: string[]): void {
  for (const taskId of taskIds) {
    enqueueLocalSyncUpdate('task', taskId)
  }
}
