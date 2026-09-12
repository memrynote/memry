import { useCallback } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const logger = createLogger('NoteCover')

export interface UseNoteCoverResult {
  setCover: (ref: string) => Promise<void>
  removeCover: () => Promise<void>
}

export function useNoteCover(noteId: string | null, onSaved: () => void): UseNoteCoverResult {
  const { t } = useT('notes')

  const setCover = useCallback(
    async (ref: string) => {
      if (!noteId) return
      try {
        await notesService.update({ id: noteId, frontmatter: { cover: ref } })
        onSaved()
      } catch (err) {
        logger.error('Failed to set note cover', err)
        toast.error(extractErrorMessage(err, t('cover.setFailed')))
      }
    },
    [noteId, onSaved, t]
  )

  const removeCover = useCallback(async () => {
    if (!noteId) return
    try {
      await notesService.update({ id: noteId, frontmatter: { cover: null } })
      onSaved()
    } catch (err) {
      logger.error('Failed to remove note cover', err)
      toast.error(extractErrorMessage(err, t('cover.removeFailed')))
    }
  }, [noteId, onSaved, t])

  return { setCover, removeCover }
}
