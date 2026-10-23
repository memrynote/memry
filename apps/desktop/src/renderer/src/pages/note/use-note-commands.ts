import type { Dispatch, RefObject, SetStateAction } from 'react'
import { toast } from 'sonner'
import type { CommandIdsOf } from '@memry/contracts/commands'
import { useT } from '@memry/i18n/renderer'
import { useTabCommands, type CommandImpl } from '@/commands'
import { useCreateNoteFromNote } from '@/hooks/use-create-note-from-note'
import type { DialogState } from '@/hooks/use-dialog-state'
import { useFileActionLabels } from '@/hooks/use-file-action-labels'
import { useNoteFileActions } from '@/hooks/use-note-file-actions'
import { useNoteMutations, type Note } from '@/hooks/use-notes-query'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useReadwiseBookCommands, type ReadwiseBookCommands } from './use-readwise-book-commands'
import { requestNoteNameInput } from '@/components/note/names/note-name-input-request'

/** The note page's modal surfaces: one is open at a time. */
export type NoteDialog =
  | 'export'
  | 'saveAsTemplate'
  | 'applyTemplate'
  | 'versionHistory'
  | 'move'
  | 'attachments'
  | 'delete'
  | 'reminder'
  | 'readwiseReimport'

export type NoteCommandId = CommandIdsOf<'note'>

interface NoteCommandInput {
  /** Null while the note loads. */
  note: Note | null
  isDeleted: boolean
  isLocked: boolean
  hasOwnLock: boolean
  isFullWidth: boolean
  isLocalGraphOpen: boolean
  setIsLocalGraphOpen: Dispatch<SetStateAction<boolean>>
  dialog: DialogState<NoteDialog>
  titleInputRef: RefObject<HTMLTextAreaElement | null>
  openTemplateInsertRef: RefObject<(() => void) | null>
  openFind: () => void
  isBookmarked: boolean
  toggleBookmark: () => Promise<unknown>
  mindMap: { isAvailable: boolean; isOpen: boolean; toggle: () => void }
  setLocalOnly: (value: boolean) => Promise<void>
  setFullWidth: (value: boolean) => Promise<void>
}

/**
 * The owner of every `note.*` command, registered per tab so a command reaches
 * the note in the active pane, not every open note. The page's overflow menu
 * runs the same `commands` and shows the same `labels`, so a menu item and its
 * palette command are one implementation. A deleted note offers none of them,
 * as its menu is disabled, and a destructive command only opens the page's
 * confirm dialog.
 */
export function useNoteCommands(input: NoteCommandInput): {
  commands: Record<NoteCommandId, CommandImpl>
  labels: Record<NoteCommandId, string>
  moveToFolder: (targetFolder: string) => Promise<void>
  readwise: ReadwiseBookCommands
} {
  const { note, isDeleted, isLocked, hasOwnLock, isFullWidth, dialog, titleInputRef } = input
  const { t } = useT('notes')
  const fileLabels = useFileActionLabels()
  const createNoteFromNote = useCreateNoteFromNote()
  const { moveNote } = useNoteMutations()
  const noteId = note?.id ?? null
  const readwise = useReadwiseBookCommands(note)
  const files = useNoteFileActions({ noteId, path: note?.path, hasOwnLock })

  const ready = note !== null && !isDeleted
  const canEdit = ready && !isLocked
  const hasEditor = ready && note.sizeClass !== 'large-file'
  const isLocalOnly = note?.frontmatter.localOnly ?? false

  const labels: Record<NoteCommandId, string> = {
    'note.find': t('editor.toolbar.find'),
    'note.exportPdf': t('editor.toolbar.export'),
    'note.localGraph': input.isLocalGraphOpen
      ? t('editor.toolbar.hideLocalGraph')
      : t('editor.toolbar.showLocalGraph'),
    'note.versionHistory': t('editor.toolbar.versionHistory'),
    'note.applyTemplate': t('tree.actions.applyTemplate'),
    'note.insertTemplate': t('editor.slashMenu.insertTemplate.title'),
    'note.saveAsTemplate': t('editor.toolbar.saveAsTemplate'),
    'note.newFromNote': t('newNoteFromNote.action'),
    'note.toggleFullWidth': t('editor.toolbar.fullWidth'),
    'note.toggleMindMap': input.mindMap.isOpen
      ? t('editor.toolbar.hideMindMap')
      : t('editor.toolbar.showMindMap'),
    'note.rename': t('editor.toolbar.rename'),
    'note.addName': t('names.addMenu'),
    'note.moveToFolder': t('editor.toolbar.moveToFolder'),
    'note.copyPath': t('editor.toolbar.copyPath'),
    'note.revealInFinder': fileLabels.revealInFolder,
    'note.revealInSidebar': t('editor.toolbar.revealInSidebar'),
    'note.openExternal': fileLabels.openInDefaultApp,
    'note.attachments': t('editor.toolbar.attachments'),
    'note.toggleLocalOnly': isLocalOnly
      ? t('editor.toolbar.disableLocalOnly')
      : t('editor.toolbar.setLocalOnly'),
    'note.toggleLock': hasOwnLock ? t('vaultLock.unlockNote') : t('vaultLock.lockNote'),
    'note.toggleBookmark': input.isBookmarked
      ? t('editor.toolbar.removeBookmark')
      : t('editor.toolbar.addBookmark'),
    'note.setReminder': t('editor.toolbar.setReminder'),
    'note.readwiseReimport': t('readwise.reimportAction'),
    'note.readwiseRefresh': t('readwise.refreshAction'),
    'note.delete': t('editor.toolbar.delete')
  }

  const item = (
    id: NoteCommandId,
    run: () => void | Promise<void>,
    enabled: boolean = ready
  ): CommandImpl => ({ run, enabled, label: labels[id] })

  const moveToFolder = async (targetFolder: string): Promise<void> => {
    if (!noteId) return
    try {
      const result = await moveNote.mutateAsync({ id: noteId, newFolder: targetFolder })
      if (result.success) toast.success(t('page.toast.moved'))
      else toast.error(result.error ?? t('page.toast.moveFailed'))
    } catch (err) {
      toast.error(extractErrorMessage(err, t('page.toast.moveFailed')))
    }
  }

  // Deferred so the palette's or menu's focus restoration does not take focus back.
  const rename = (): void => {
    requestAnimationFrame(() => {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    })
  }

  const commands: Record<NoteCommandId, CommandImpl> = {
    'note.find': { run: input.openFind, enabled: note !== null },
    // Unlabeled: the palette says "Export to PDF…", as the native File menu does.
    'note.exportPdf': {
      run: () => dialog.show('export'),
      enabled: note !== null
    },
    'note.localGraph': item('note.localGraph', () => input.setIsLocalGraphOpen((open) => !open)),
    'note.versionHistory': item('note.versionHistory', () => dialog.show('versionHistory')),
    'note.applyTemplate': item('note.applyTemplate', () => dialog.show('applyTemplate'), hasEditor),
    'note.insertTemplate': item(
      'note.insertTemplate',
      () => input.openTemplateInsertRef.current?.(),
      hasEditor
    ),
    'note.saveAsTemplate': item('note.saveAsTemplate', () => dialog.show('saveAsTemplate')),
    'note.newFromNote': item('note.newFromNote', () => createNoteFromNote(noteId ?? '')),
    'note.toggleFullWidth': item('note.toggleFullWidth', () => input.setFullWidth(!isFullWidth)),
    'note.toggleMindMap': item(
      'note.toggleMindMap',
      input.mindMap.toggle,
      ready && input.mindMap.isAvailable
    ),
    // oxlint-disable-next-line react/refs -- latest-value ref (callbacks/state mirrored for stable handlers); not render output
    'note.rename': item('note.rename', rename, canEdit),
    'note.addName': item('note.addName', () => requestNoteNameInput(noteId ?? ''), canEdit),
    'note.moveToFolder': item('note.moveToFolder', () => dialog.show('move')),
    'note.copyPath': item('note.copyPath', files.copyPath),
    'note.revealInFinder': item('note.revealInFinder', files.revealInFinder),
    'note.revealInSidebar': item('note.revealInSidebar', files.revealInSidebar),
    'note.openExternal': item('note.openExternal', files.openExternal),
    'note.attachments': item('note.attachments', () => dialog.show('attachments')),
    'note.toggleLocalOnly': item(
      'note.toggleLocalOnly',
      () => input.setLocalOnly(!isLocalOnly),
      canEdit
    ),
    'note.toggleLock': item(
      'note.toggleLock',
      files.toggleLock,
      ready && (hasOwnLock || !isLocked)
    ),
    'note.toggleBookmark': item('note.toggleBookmark', async () => {
      await input.toggleBookmark()
    }),
    'note.setReminder': item('note.setReminder', () => dialog.show('reminder')),
    // Unlabeled: the palette says "Refresh Readwise Book Info", so a search for
    // Readwise finds both. A Readwise note offers them on the pulling device only (D16).
    'note.readwiseReimport': {
      run: () => dialog.show('readwiseReimport'),
      enabled: ready && readwise.isLinked && readwise.pullsHere
    },
    'note.readwiseRefresh': {
      run: readwise.refresh,
      enabled: ready && readwise.isLinked && readwise.pullsHere
    },
    'note.delete': item('note.delete', () => dialog.show('delete'))
  }

  useTabCommands('note', commands)
  return { commands, labels, moveToFolder, readwise }
}
