import { MEMRY_NOTE_DRAG_MIME } from '@/lib/drag-mime'
import type { ProjectItemType } from '@/services/tasks-service'

interface LinkSidebarItemDeps {
  getFile: (id: string) => Promise<{ id: string } | null>
  link: (input: {
    projectId: string
    itemType: ProjectItemType
    itemId: string
  }) => Promise<{ success: boolean; error?: string }>
}

/**
 * Links a sidebar item (dragged from the notes tree via MEMRY_NOTE_DRAG_MIME)
 * to a project. Files are notes with a non-markdown fileType, so
 * `getFile(id)` returns non-null exactly for files — the file/note
 * discriminator. Returns null when the drag carried no linkable item (so the
 * caller can skip the toast); throws when the link call reports failure.
 */
export async function linkSidebarItemToProject(
  dataTransfer: Pick<DataTransfer, 'getData' | 'types'>,
  projectId: string,
  deps: LinkSidebarItemDeps
): Promise<{ itemType: ProjectItemType; itemId: string } | null> {
  if (!dataTransfer.types.includes(MEMRY_NOTE_DRAG_MIME)) return null
  const itemId = dataTransfer.getData(MEMRY_NOTE_DRAG_MIME)
  if (!itemId) return null

  const file = await deps.getFile(itemId)
  const itemType: ProjectItemType = file ? 'file' : 'note'
  const result = await deps.link({ projectId, itemType, itemId })
  if (!result.success) throw new Error(result.error)
  return { itemType, itemId }
}
