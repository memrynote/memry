import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import type { RenameTagResponse } from '@memry/contracts/tags-api'

/**
 * The toasts for a tag rename that succeeded: the rename itself, then what it
 * left undone, so a skipped body rewrite or a note it could not write is never
 * silent.
 */
export function toastTagRenamed(result: RenameTagResponse, oldName: string, newName: string) {
  const t = getI18n().getFixedT(null, 'settings')
  toast.success(t('tags.toasts.renamed', { oldName, newName }))
  if (result.bodySkipped) toast.warning(t('tags.toasts.renamedBodySkipped', { oldName, newName }))
  const failed = result.failedNoteIds?.length ?? 0
  if (failed > 0) toast.warning(t('tags.toasts.renamedSomeFailed', { count: failed }))
}
