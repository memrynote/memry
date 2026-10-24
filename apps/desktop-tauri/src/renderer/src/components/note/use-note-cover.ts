import { useCallback } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import {
  COVER_FOCUS_X_FRONTMATTER_KEY,
  COVER_HEIGHT_FRONTMATTER_KEY,
  COVER_ZOOM_FRONTMATTER_KEY,
  DEFAULT_COVER_FRAMING,
  clampCoverFocus,
  clampCoverHeight,
  clampCoverZoom,
  coverWashRef,
  isCoverFocusValue,
  isCoverHeightValue,
  isCoverZoomValue,
  type CoverFraming,
  type CoverValue
} from '@memry/shared/cover-image'
import { notesService } from '@/services/notes-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const logger = createLogger('NoteCover')

export interface CoverCredit {
  name: string
  url: string
}

export interface UseNoteCoverResult {
  setCover: (value: CoverValue, credit?: CoverCredit) => Promise<void>
  /** Writes only the framing fields passed in. */
  setCoverFraming: (changes: Partial<CoverFraming>) => Promise<void>
  removeCover: () => Promise<void>
}

/**
 * The framing keys to clear when a cover is set or removed: a new or removed
 * cover drops the old photo's framing. `coverFocus` is cleared as it always was.
 * The keys added after it are cleared only while they hold framing, so a
 * `coverHeight: tall` the user wrote before Memry claimed the key survives.
 */
function clearedFraming(frontmatter: Readonly<Record<string, unknown>>): Record<string, null> {
  const cleared: Record<string, null> = { coverFocus: null }
  if (isCoverFocusValue(frontmatter[COVER_FOCUS_X_FRONTMATTER_KEY])) {
    cleared[COVER_FOCUS_X_FRONTMATTER_KEY] = null
  }
  if (isCoverZoomValue(frontmatter[COVER_ZOOM_FRONTMATTER_KEY])) {
    cleared[COVER_ZOOM_FRONTMATTER_KEY] = null
  }
  if (isCoverHeightValue(frontmatter[COVER_HEIGHT_FRONTMATTER_KEY])) {
    cleared[COVER_HEIGHT_FRONTMATTER_KEY] = null
  }
  return cleared
}

/**
 * The frontmatter patch for a framing change. `coverFocus` is always written as
 * a number, as it was before the other keys existed. The later keys are deleted
 * (`null`) at their default, so a note framed back to centre, unzoomed and 200px
 * tall carries the same frontmatter as one never framed at all.
 */
function framingFrontmatter(changes: Partial<CoverFraming>): Record<string, number | null> {
  const patch: Record<string, number | null> = {}
  if (changes.focusY !== undefined) patch.coverFocus = clampCoverFocus(changes.focusY)
  if (changes.focusX !== undefined) {
    const focusX = clampCoverFocus(changes.focusX)
    patch[COVER_FOCUS_X_FRONTMATTER_KEY] = focusX === DEFAULT_COVER_FRAMING.focusX ? null : focusX
  }
  if (changes.zoom !== undefined) {
    const zoom = clampCoverZoom(changes.zoom)
    patch[COVER_ZOOM_FRONTMATTER_KEY] = zoom === DEFAULT_COVER_FRAMING.zoom ? null : zoom
  }
  if (changes.height !== undefined) {
    const height = clampCoverHeight(changes.height)
    patch[COVER_HEIGHT_FRONTMATTER_KEY] = height === DEFAULT_COVER_FRAMING.height ? null : height
  }
  return patch
}

export function useNoteCover(
  noteId: string | null,
  frontmatter: Readonly<Record<string, unknown>> | null,
  onSaved: () => void
): UseNoteCoverResult {
  const { t } = useT('notes')

  const setCover = useCallback(
    async (value: CoverValue, credit?: CoverCredit) => {
      if (!noteId) return
      const ref = value.kind === 'wash' ? coverWashRef(value.id) : value.ref
      try {
        // A new cover invalidates the old photo's framing, and carries either its
        // own attribution or none. Both land in the one write that sets the cover,
        // so the note is never briefly credited to the wrong photographer.
        await notesService.update({
          id: noteId,
          frontmatter: {
            cover: ref,
            ...clearedFraming(frontmatter ?? {}),
            coverCredit: credit?.name ?? null,
            coverCreditUrl: credit?.url ?? null
          }
        })
        onSaved()
      } catch (err) {
        logger.error('Failed to set note cover', err)
        toast.error(extractErrorMessage(err, t('cover.setFailed')))
      }
    },
    [noteId, frontmatter, onSaved, t]
  )

  const setCoverFraming = useCallback(
    async (changes: Partial<CoverFraming>) => {
      if (!noteId) return
      const patch = framingFrontmatter(changes)
      if (Object.keys(patch).length === 0) return
      try {
        await notesService.update({ id: noteId, frontmatter: patch })
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
        frontmatter: {
          cover: null,
          ...clearedFraming(frontmatter ?? {}),
          coverCredit: null,
          coverCreditUrl: null
        }
      })
      onSaved()
    } catch (err) {
      logger.error('Failed to remove note cover', err)
      toast.error(extractErrorMessage(err, t('cover.removeFailed')))
    }
  }, [noteId, frontmatter, onSaved, t])

  return { setCover, setCoverFraming, removeCover }
}
