import { useCallback, useEffect } from 'react'
import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import { foldTag } from '@memry/shared/tag-fold'
import {
  RENAME_UNFINISHED,
  renameTagWithProgress,
  toastTagChangeFailed,
  toastTagRenamed,
  toastTagsKept,
  toastUnfinishedRename
} from '@/features/tag-fields/rename-toasts'
import { IpcFailureError, extractErrorMessage, getIpcErrorCode } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { isTagGone, onTagDeleted, onTagRenamed, tagsService } from '@/services/tags-service'
import { subscribeToEvents } from '@/services/tauri-event'

const log = createLogger('Page:FolderView')

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
          throw new IpcFailureError(
            result.error ?? tSettings('tags.toasts.renameFailed'),
            result.code
          )
        }
        toastTagRenamed(result, tag, newName)
        closeTab()
      } catch (err) {
        log.error('Failed to rename tag', err)
        const message = extractErrorMessage(err, tSettings('tags.toasts.renameFailed'))
        const stuck = getIpcErrorCode(err) === RENAME_UNFINISHED
        if (!stuck || !(await toastUnfinishedRename())) toast.error(message)
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
        throw new IpcFailureError(
          result.error ?? tSettings('tags.toasts.deleteFailed'),
          result.code
        )
      }
      if (!toastTagsKept(result, tag, 'delete')) {
        toast.success(tSettings('tags.toasts.deleted', { name: tag, count: totalNotes }))
      }
      closeTab()
    } catch (err) {
      log.error('Failed to delete tag', err)
      const message = extractErrorMessage(err, tSettings('tags.toasts.deleteFailed'))
      await toastTagChangeFailed(message, getIpcErrorCode(err))
    }
  }, [tag, totalNotes, closeTab])

  // A rename or delete before the listeners went live sent its event to nobody: once they
  // are live, the tab asks whether its tag is gone.
  useEffect(() => {
    if (tag === null) return undefined
    const key = foldTag(tag)
    let live = true
    const stop = subscribeToEvents(
      [
        (listening) =>
          onTagRenamed((event) => {
            if (foldTag(event.oldName) === key) closeTab()
          }, listening),
        (listening) =>
          onTagDeleted((event) => {
            if (foldTag(event.tag) === key) closeTab()
          }, listening)
      ],
      () => {
        isTagGone(tag)
          .then((gone) => {
            if (gone && live) closeTab()
          })
          .catch((error: unknown) => log.warn('the tag was not checked again', error))
      }
    )
    return () => {
      live = false
      stop()
    }
  }, [tag, closeTab])

  return { handleTagIconChange, handleTagRenameSubmit, handleTagDeleteConfirm }
}
