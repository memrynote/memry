import { useCallback } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { clampCoverFocus, coverWashRef, type CoverValue } from '@memry/shared/cover-image'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const logger = createLogger('NoteCover')

export interface UseNoteCoverResult {
  setCover: (value: CoverValue) => Promise<void>
  setCoverFocus: (focus: number) => Promise<void>
  removeCover: () => Promise<void>
}

export function useNoteCover(noteId: string | null, onSaved: () => void): UseNoteCoverResult {
  const { t } = useT('notes')

  const setCover = useCallback(
    async (value: CoverValue) => {
      if (!noteId) return
      const ref = value.kind === 'wash' ? coverWashRef(value.id) : value.ref
      try {
        // A new cover invalidates the old photo's framing and attribution.
        await notesService.update({
          id: noteId,
          frontmatter: { cover: ref, coverFocus: null, coverCredit: null, coverCreditUrl: null }
        })
        onSaved()
      } catch (err) {
        logger.error('Failed to set note cover', err)
        toast.error(extractErrorMessage(err, t('cover.setFailed')))
      }
    },
    [noteId, onSaved, t]
  )

  const setCoverFocus = useCallback(
    async (focus: number) => {
      if (!noteId) return
      try {
        await notesService.update({
          id: noteId,
          frontmatter: { coverFocus: clampCoverFocus(focus) }
        })
        onSaved()
      } catch (err) {
        logger.error('Failed to save the cover position', err)
        toast.error(extractErrorMessage(err, t('cover.focusFailed')))
      }
    },
    [noteId, onSaved, t]
  )

  const removeCover = useCallback(async () => {
    if (!noteId) return
    try {
      await notesService.update({
        id: noteId,
        frontmatter: { cover: null, coverFocus: null, coverCredit: null, coverCreditUrl: null }
      })
      onSaved()
    } catch (err) {
      logger.error('Failed to remove note cover', err)
      toast.error(extractErrorMessage(err, t('cover.removeFailed')))
    }
  }, [noteId, onSaved, t])

  return { setCover, setCoverFocus, removeCover }
}
