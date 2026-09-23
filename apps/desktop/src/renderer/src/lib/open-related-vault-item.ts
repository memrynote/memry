import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
import { dateFromJournalId } from '@memry/contracts/journal-api'
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

  if (!note) {
    // A `j<date>` id that resolves to no note is a journal day the vault cached
    // under a different id — the day itself is still there, so open it by date
    // rather than by id. Tasks created inside such a day before #2271 was fixed
    // carry exactly this id, and this is what makes those links work again
    // without rewriting a single stored row.
    const journalDate = dateFromJournalId(itemId)
    if (journalDate) {
      openTab({
        type: 'journal',
        title: getI18n().getFixedT(null, 'common')('home.widget.journal'),
        icon: 'book-open',
        path: '/journal',
        isPinned: false,
        isModified: false,
        isPreview: false,
        isDeleted: false,
        viewState: { date: journalDate }
      })
      return
    }

    // Anything else that resolves to neither a file nor a note has nothing to
    // open. This used to open `/notes/<id>` regardless, which paints a blank
    // "Untitled" editor over a note that does not exist — indistinguishable
    // from the note having been emptied (#2271).
    toast.error(getI18n().getFixedT(null, 'tasks')('drawer.relatedItemMissing'))
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
