import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { CommandIdsOf } from '@memry/contracts/commands'
import { useT } from '@memry/i18n/renderer'
import { useTabCommands, type CommandImpl } from '@/commands'
import { requestNoteNameInput } from '@/components/note/names/note-name-input-request'
import type { JournalMenuAction } from '@/components/journal'
import type { DialogState } from '@/hooks/use-dialog-state'
import { useFileActionLabels } from '@/hooks/use-file-action-labels'
import { useNoteFileActions } from '@/hooks/use-note-file-actions'

/** The journal page's modal surfaces: one is open at a time. */
export type JournalDialog =
  | 'export'
  | 'saveAsTemplate'
  | 'versionHistory'
  | 'attachments'
  | 'delete'

export type JournalCommandId = CommandIdsOf<'journal'>

/** The overflow-menu items that run a command; the rest have their own header props. */
const MENU_COMMANDS: Partial<Record<JournalMenuAction, JournalCommandId>> = {
  'local-graph': 'journal.localGraph',
  find: 'journal.find',
  'insert-template': 'journal.insertTemplate',
  'save-as-template': 'journal.saveAsTemplate',
  'add-name': 'journal.addName',
  'copy-path': 'journal.copyPath',
  'reveal-in-finder': 'journal.revealInFinder',
  'open-external': 'journal.openExternal',
  attachments: 'journal.attachments',
  lock: 'journal.toggleLock',
  delete: 'journal.delete'
}

interface JournalCommandInput {
  viewType: 'day' | 'month' | 'year'
  isToday: boolean
  /** Null on a day nobody has written: there is no entry file to act on. */
  entryId: string | null
  isLocked: boolean
  hasOwnLock: boolean
  isFullWidth: boolean
  isLocalGraphOpen: boolean
  setIsLocalGraphOpen: Dispatch<SetStateAction<boolean>>
  dialog: DialogState<JournalDialog>
  openTemplateInsertRef: RefObject<(() => void) | null>
  openFind: () => void
  goPrevious: () => void
  goNext: () => void
  goToday: () => void
  isBookmarked: boolean
  toggleBookmark: () => Promise<void>
  toggleFullWidth: () => void
  mindMap: { isAvailable: boolean; isOpen: boolean; toggle: () => void }
}

/**
 * The owner of every `journal.*` command, registered per tab so a command reaches
 * the journal in the active pane. The page's header buttons and overflow menu run
 * these same `commands`, so a menu item and its palette command are one
 * implementation. Delete only opens the page's confirm dialog.
 */
export function useJournalCommands(input: JournalCommandInput): {
  commands: Record<JournalCommandId, CommandImpl>
  runMenuAction: (action: JournalMenuAction) => void
} {
  const { viewType, entryId, isLocked, hasOwnLock, dialog } = input
  const { t } = useT('journal')
  const { t: tNotes } = useT('notes')
  const fileLabels = useFileActionLabels()
  const files = useNoteFileActions({ noteId: entryId, hasOwnLock })

  const isDay = viewType === 'day'
  const hasEntry = isDay && entryId !== null
  const canEdit = isDay && !isLocked

  const stepLabel = {
    day: ['nav.previousDay', 'nav.nextDay'],
    month: ['nav.previousMonth', 'nav.nextMonth'],
    year: ['nav.previousYear', 'nav.nextYear']
  } as const

  const item = (
    label: string,
    run: () => void | Promise<void>,
    enabled: boolean = isDay
  ): CommandImpl => ({ run, enabled, label })

  const commands: Record<JournalCommandId, CommandImpl> = {
    'journal.previous': item(t(stepLabel[viewType][0]), input.goPrevious, true),
    'journal.next': item(t(stepLabel[viewType][1]), input.goNext, true),
    'journal.today': item(t('action.goToToday'), input.goToday, !(isDay && input.isToday)),
    'journal.find': item(tNotes('editor.toolbar.find'), input.openFind),
    'journal.localGraph': item(
      input.isLocalGraphOpen
        ? tNotes('editor.toolbar.hideLocalGraph')
        : tNotes('editor.toolbar.showLocalGraph'),
      () => input.setIsLocalGraphOpen((open) => !open),
      hasEntry
    ),
    'journal.versionHistory': item(
      t('action.versionHistory'),
      () => dialog.show('versionHistory'),
      hasEntry
    ),
    'journal.export': item(t('action.export'), () => dialog.show('export'), hasEntry),
    'journal.insertTemplate': item(
      tNotes('editor.slashMenu.insertTemplate.title'),
      () => input.openTemplateInsertRef.current?.(),
      canEdit
    ),
    'journal.saveAsTemplate': item(
      tNotes('editor.toolbar.saveAsTemplate'),
      () => dialog.show('saveAsTemplate'),
      hasEntry
    ),
    'journal.toggleFullWidth': item(t('action.fullWidth'), input.toggleFullWidth),
    'journal.toggleMindMap': item(
      input.mindMap.isOpen
        ? tNotes('editor.toolbar.hideMindMap')
        : tNotes('editor.toolbar.showMindMap'),
      input.mindMap.toggle,
      isDay && input.mindMap.isAvailable
    ),
    'journal.addName': item(
      tNotes('names.addMenu'),
      () => requestNoteNameInput(entryId ?? ''),
      hasEntry && !isLocked
    ),
    'journal.copyPath': item(tNotes('editor.toolbar.copyPath'), files.copyPath, hasEntry),
    'journal.revealInFinder': item(fileLabels.revealInFolder, files.revealInFinder, hasEntry),
    'journal.openExternal': item(fileLabels.openInDefaultApp, files.openExternal, hasEntry),
    'journal.attachments': item(
      tNotes('editor.toolbar.attachments'),
      () => dialog.show('attachments'),
      hasEntry
    ),
    'journal.toggleLock': item(
      hasOwnLock ? t('action.unlockEntry') : t('action.lockEntry'),
      files.toggleLock,
      hasEntry && (hasOwnLock || !isLocked)
    ),
    'journal.toggleBookmark': item(
      input.isBookmarked ? t('action.removeBookmark') : t('action.addBookmark'),
      input.toggleBookmark
    ),
    'journal.delete': item(t('action.deleteEntry'), () => dialog.show('delete'), hasEntry)
  }

  useTabCommands('journal', commands)

  const runMenuAction = (action: JournalMenuAction): void => {
    const id = MENU_COMMANDS[action]
    if (id) void commands[id].run({ source: 'ui' })
  }
  return { commands, runMenuAction }
}
