import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import {
  type RenameTagResult,
  onTagsProgress,
  stopTagRename,
  tagsService,
  unfinishedTagRename
} from '@/services/tags-service'

const log = createLogger('Tags:Rename')

/** How many of a stuck rename's notes its warning names. */
const NAMED = 3

/**
 * Warns that a merge or delete left notes it could not write with the tag, which asking it
 * again finishes; nothing when it wrote them all.
 */
export function toastTagsKept(
  result: { failedNoteIds?: string[] },
  tag: string,
  action: 'merge' | 'delete'
) {
  const count = result.failedNoteIds?.length ?? 0
  if (count === 0) return
  const t = getI18n().getFixedT(null, 'settings')
  const key = action === 'merge' ? 'tags.toasts.mergedSomeKept' : 'tags.toasts.deletedSomeKept'
  toast.warning(t(key, { count, tag }), { duration: 10_000 })
}

/** The `code` a rename refused because another is left unfinished fails with. */
export const RENAME_UNFINISHED = 'tag_rename_unfinished'

export function toastTagRenamed(result: RenameTagResult, oldName: string, newName: string) {
  const t = getI18n().getFixedT(null, 'settings')
  toast.success(t('tags.toasts.renamed', { oldName, newName }))
  if (result.bodySkipped) toast.warning(t('tags.toasts.renamedBodySkipped', { oldName, newName }))
  const failed = result.failedNoteIds?.length ?? 0
  // The rename stays recorded for the notes it could not write. With none recorded (the notes
  // it left were struck off), asking it again would rename the renamed notes once more.
  if (failed > 0) {
    void toastUnfinishedRename().then((shown) => {
      if (!shown) toast.warning(t('tags.toasts.renamedSomeFailed', { count: failed }))
    })
  }
}

/**
 * Warns of the rename left with notes it could not write, naming them, with a way to stop it;
 * `false` when none is left (or it cannot be read). Every other rename is refused while one is
 * left, so a refused rename shows this rather than its message.
 */
export async function toastUnfinishedRename(): Promise<boolean> {
  const left = await unfinishedTagRename().catch((error: unknown) => {
    log.error('Failed to read the unfinished tag rename', error)
    return null
  })
  if (!left) return false
  const t = getI18n().getFixedT(null, 'settings')
  const { oldName, newName, notes } = left
  const names = notes
    .slice(0, NAMED)
    .map((note) => note.title)
    .join(', ')
  const rest = left.left - Math.min(notes.length, NAMED)
  toast.warning(t('tags.toasts.renameUnfinished', { oldName, newName, count: left.left }), {
    description: rest > 0 ? t('tags.toasts.renameUnfinishedMore', { names, count: rest }) : names,
    duration: 10_000,
    action: {
      label: t('tags.toasts.stopRename'),
      onClick: () => void stopRename(oldName, newName)
    }
  })
  return true
}

async function stopRename(oldName: string, newName: string) {
  const t = getI18n().getFixedT(null, 'settings')
  try {
    await stopTagRename()
    toast.success(t('tags.toasts.renameStopped', { oldName, newName }))
  } catch (error) {
    log.error('Failed to stop the tag rename', error)
    toast.error(extractErrorMessage(error, t('tags.toasts.stopRenameFailed')))
  }
}

export async function renameTagWithProgress(
  oldName: string,
  newName: string
): Promise<RenameTagResult> {
  const t = getI18n().getFixedT(null, 'settings')
  const runId = crypto.randomUUID()
  const off = onTagsProgress((event) => {
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
