import type { CommandIdsOf } from '@memry/contracts/commands'
import { useT } from '@memry/i18n/renderer'
import { useTabCommands, type CommandImpl } from '@/commands'
import { useFileActionLabels } from '@/hooks/use-file-action-labels'
import { useNoteFileActions } from '@/hooks/use-note-file-actions'

export type FileCommandId = CommandIdsOf<'file'>

interface FileCommandInput {
  /** Null until the file's metadata has loaded: there is nothing to act on. */
  fileId: string | null
  openAddToProject: () => void
}

/**
 * The owner of every `file.*` command, registered per tab. The info bar's
 * buttons and the PDF toolbar's `...` menu run these same commands, so a button
 * and its palette command are one implementation. Open and reveal go through the
 * note file actions, which a filed binary shares with a note.
 */
export function useFileCommands({ fileId, openAddToProject }: FileCommandInput): {
  runCommand: (id: FileCommandId) => void
} {
  const { t: tTasks } = useT('tasks')
  const fileLabels = useFileActionLabels()
  const files = useNoteFileActions({ noteId: fileId, hasOwnLock: false })
  const enabled = fileId !== null

  const commands: Record<FileCommandId, CommandImpl> = {
    'file.addToProject': {
      label: tTasks('addToProject.menuLabel'),
      enabled,
      run: openAddToProject
    },
    'file.openExternal': { label: fileLabels.openInDefaultApp, enabled, run: files.openExternal },
    'file.revealInFinder': { label: fileLabels.revealInFolder, enabled, run: files.revealInFinder }
  }

  useTabCommands('file', commands)
  return { runCommand: (id) => void commands[id].run({ source: 'ui' }) }
}
