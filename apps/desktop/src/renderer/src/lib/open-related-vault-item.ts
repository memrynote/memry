import { getTabIconForFileType } from '@memry/shared/file-types'
import { notesService } from '@/services/notes-service'
import type { Tab } from '@/contexts/tabs/types'

type OpenTab = (tab: Omit<Tab, 'id' | 'openedAt' | 'lastAccessedAt'>) => void

export async function openRelatedVaultItem(itemId: string, openTab: OpenTab): Promise<void> {
  const file = await notesService.getFile(itemId).catch(() => null)

  if (file) {
    openTab({
      type: 'file',
      title: file.title,
      icon: getTabIconForFileType(file.fileType),
      path: `/file/${itemId}`,
      entityId: itemId,
      isPinned: false,
      isModified: false,
      isPreview: false,
      isDeleted: false
    })
    return
  }

  const note = await notesService.get(itemId)
  openTab({
    type: 'note',
    title: note?.title ?? 'Untitled',
    icon: 'file-text',
    emoji: note?.emoji,
    path: `/notes/${itemId}`,
    entityId: itemId,
    isPinned: false,
    isModified: false,
    isPreview: true,
    isDeleted: false
  })
}
