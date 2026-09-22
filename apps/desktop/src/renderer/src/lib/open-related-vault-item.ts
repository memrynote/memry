import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
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

  // An id that resolves to neither a file nor a note has nothing to open. This
  // used to open `/notes/<id>` regardless, which paints a blank "Untitled"
  // editor over a note that does not exist — indistinguishable from the note
  // having been emptied (#2271). Report it and leave the workspace alone.
  if (!note) {
    const t = getI18n().getFixedT(null, 'tasks')
    toast.error(t('drawer.relatedItemMissing'))
    return
  }

  openTab({
    type: 'note',
    title: note.title,
    icon: 'file-text',
    emoji: note.emoji,
    path: `/notes/${itemId}`,
    entityId: itemId,
    isPinned: false,
    isModified: false,
    isPreview: false,
    isDeleted: false
  })
}
