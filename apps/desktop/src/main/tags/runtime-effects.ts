import { getNoteSyncService } from '../sync/note-sync'
import { getTagDefinitionSyncService } from '../sync/tag-definition-sync'
import { getTaskSyncService } from '../sync/task-sync'

export function syncTaggedNote(noteId: string): void {
  getNoteSyncService()?.enqueueUpdate(noteId)
}

export function syncTagDefinitionRename(
  oldName: string,
  newName: string,
  oldTagSnapshot?: unknown
): void {
  const syncService = getTagDefinitionSyncService()
  if (syncService && oldTagSnapshot) {
    syncService.enqueueDelete(oldName, JSON.stringify(oldTagSnapshot))
    syncService.enqueueCreate(newName.toLowerCase().trim())
  }
}

export function syncTagDefinitionUpdate(tag: string): void {
  getTagDefinitionSyncService()?.enqueueUpdate(tag)
}

export function syncTagDefinitionDelete(tag: string, tagSnapshot?: unknown): void {
  if (tagSnapshot) {
    getTagDefinitionSyncService()?.enqueueDelete(
      tag.toLowerCase().trim(),
      JSON.stringify(tagSnapshot)
    )
  }
}

export function syncMergedTagDefinitions(
  source: string,
  target: string,
  sourceSnapshot?: unknown
): void {
  const syncService = getTagDefinitionSyncService()
  if (syncService && sourceSnapshot) {
    syncService.enqueueDelete(source, JSON.stringify(sourceSnapshot))
    syncService.enqueueCreate(target)
  }
}

export function syncTaggedTasks(taskIds: string[]): void {
  const taskSyncService = getTaskSyncService()
  if (!taskSyncService) return

  for (const taskId of taskIds) {
    taskSyncService.enqueueUpdate(taskId)
  }
}
