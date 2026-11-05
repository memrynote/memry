import { getI18n } from 'react-i18next'
import { toast } from 'sonner'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import {
  type RenameTagResult,
  type TagsKept,
  onTagsProgress,
  stopTagRename,
  tagsService,
  unfinishedTagRename
} from '@/services/tags-service'

const log = createLogger('Tags:Rename')

/** How many notes a warning of notes a tag change left names. */
const NAMED = 3

/**
 * Warns that a merge or delete left notes it could not write with the tag, naming the first of
 * them: asking again finishes them, or their files need fixing first. `false`, and nothing
 * shown, when it wrote them all, so its caller shows its success instead.
 */
export function toastTagsKept(result: TagsKept, tag: string, action: 'merge' | 'delete'): boolean {
  const notes = result.failedNotes ?? []
  if (notes.length === 0) return false
  const t = getI18n().getFixedT(null, 'settings')
  const retry = result.retryFinishes ?? true
  const key =
    action === 'merge'
      ? retry
        ? 'tags.toasts.mergedSomeKept'
        : 'tags.toasts.mergedSomeStuck'
      : retry
        ? 'tags.toasts.deletedSomeKept'
        : 'tags.toasts.deletedSomeStuck'
  toast.warning(t(key, { count: notes.length, tag }), {
    description: named(notes, notes.length),
    duration: 10_000
  })
  return true
}

/**
 * A refused or failed tag change's message; one refused because a rename is left unfinished
 * shows that rename's warning, with its way out, instead.
 */
export async function toastTagChangeFailed(message: string, code: string | undefined) {
  if (code !== RENAME_UNFINISHED || !(await toastUnfinishedRename())) toast.error(message)
}

/** The first {@link NAMED} of `count` notes, by title, and how many more there are. */
function named(notes: readonly { title: string }[], count: number): string {
  const t = getI18n().getFixedT(null, 'settings')
  const names = notes
    .slice(0, NAMED)
    .map((note) => note.title)
    .join(', ')
  const rest = count - Math.min(notes.length, NAMED)
  return rest > 0 ? t('tags.toasts.renameUnfinishedMore', { names, count: rest }) : names
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
  toast.warning(t('tags.toasts.renameUnfinished', { oldName, newName, count: left.left }), {
    description: named(notes, left.left),
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
