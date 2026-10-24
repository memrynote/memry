import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import type { RenameTagResponse } from '@memry/contracts/tags-api'
import { tagsService } from '@/services/tags-service'

export function toastTagRenamed(result: RenameTagResponse, oldName: string, newName: string) {
  const t = getI18n().getFixedT(null, 'settings')
  toast.success(t('tags.toasts.renamed', { oldName, newName }))
  if (result.bodySkipped) toast.warning(t('tags.toasts.renamedBodySkipped', { oldName, newName }))
  const failed = result.failedNoteIds?.length ?? 0
  if (failed > 0) toast.warning(t('tags.toasts.renamedSomeFailed', { count: failed }))
}

export async function renameTagWithProgress(
  oldName: string,
  newName: string
): Promise<RenameTagResponse> {
  const t = getI18n().getFixedT(null, 'settings')
  const runId = crypto.randomUUID()
  const off = window.api.onTagsProgress((event) => {
    if (event.runId !== runId || event.total === 0) return
    toast.loading(t('tags.toasts.renaming', { oldName, done: event.done, total: event.total }), {
      id: runId
    })
  })
  try {
    return await tagsService.renameTag({ oldName, newName, runId })
  } finally {
    off()
    toast.dismiss(runId)
  }
}
