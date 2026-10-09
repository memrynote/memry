import { useCallback, useEffect } from 'react'
import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import { foldTag } from '@memry/shared/tag-fold'
import { renameTagWithProgress, toastTagRenamed } from '@/features/tag-fields/rename-toasts'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { onTagDeleted, onTagRenamed, tagsService } from '@/services/tags-service'

const log = createLogger('Page:FolderView')

/**
 * A tag tab's icon, rename and delete actions, and its lifecycle: the tab
 * closes when its tag is renamed or deleted anywhere. `tag` is null outside
 * tag scope, where every action is a no-op.
 */
export function useTagScopeActions(tag: string | null, totalNotes: number, closeTab: () => void) {
  const handleTagIconChange = useCallback(
    async (icon: string | null) => {
      if (tag === null) return
      const tSettings = getI18n().getFixedT(null, 'settings')
      try {
        const result = await tagsService.updateTagIcon({ tag, icon })
        if (!result.success) {
          throw new Error(result.error ?? tSettings('tags.toasts.iconFailed'))
        }
      } catch (err) {
        log.error('Failed to update tag icon', err)
        toast.error(extractErrorMessage(err, tSettings('tags.toasts.iconFailed')))
      }
    },
    [tag]
  )

  const handleTagRenameSubmit = useCallback(
    async (newName: string) => {
      if (tag === null) return
      const tSettings = getI18n().getFixedT(null, 'settings')
      try {
        const result = await renameTagWithProgress(tag, newName)
        if (!result.success) {
          throw new Error(result.error ?? tSettings('tags.toasts.renameFailed'))
        }
        toastTagRenamed(result, tag, newName)
        closeTab()
      } catch (err) {
        log.error('Failed to rename tag', err)
        const message = extractErrorMessage(err, tSettings('tags.toasts.renameFailed'))
        toast.error(message)
        throw err instanceof Error ? err : new Error(message)
      }
    },
    [tag, closeTab]
  )

  const handleTagDeleteConfirm = useCallback(async () => {
    if (tag === null) return
    const tSettings = getI18n().getFixedT(null, 'settings')
    try {
      const result = await tagsService.deleteTag(tag)
      if (!result.success) {
        throw new Error(result.error ?? tSettings('tags.toasts.deleteFailed'))
      }
      toast.success(tSettings('tags.toasts.deleted', { name: tag, count: totalNotes }))
      closeTab()
    } catch (err) {
      log.error('Failed to delete tag', err)
      toast.error(extractErrorMessage(err, tSettings('tags.toasts.deleteFailed')))
    }
  }, [tag, totalNotes, closeTab])

  useEffect(() => {
    if (tag === null) return
    const key = foldTag(tag)
    const offRenamed = onTagRenamed((event) => {
      if (foldTag(event.oldName) === key) closeTab()
    })
    const offDeleted = onTagDeleted((event) => {
      if (foldTag(event.tag) === key) closeTab()
    })
    return () => {
      offRenamed()
      offDeleted()
    }
  }, [tag, closeTab])

  return { handleTagIconChange, handleTagRenameSubmit, handleTagDeleteConfirm }
}
