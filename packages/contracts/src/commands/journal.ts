import type { CommandMeta } from './types'

/** Acts on the journal day, month or year shown in the active tab. */
export const JOURNAL_COMMANDS = {
  'journal.previous': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalPrevious'
  },
  'journal.next': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalNext'
  },
  'journal.today': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalToday'
  },
  'journal.find': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalFind'
  },
  'journal.localGraph': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalLocalGraph'
  },
  'journal.versionHistory': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalVersionHistory'
  },
  'journal.export': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalExport'
  },
  'journal.insertTemplate': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalInsertTemplate'
  },
  'journal.saveAsTemplate': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalSaveAsTemplate'
  },
  'journal.toggleFullWidth': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalToggleFullWidth'
  },
  'journal.toggleMindMap': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalToggleMindMap'
  },
  'journal.addName': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalAddName'
  },
  'journal.copyPath': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalCopyPath'
  },
  'journal.revealInFinder': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalRevealInFinder'
  },
  'journal.openExternal': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalOpenExternal'
  },
  'journal.attachments': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalAttachments'
  },
  'journal.toggleLock': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalToggleLock'
  },
  'journal.toggleBookmark': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalToggleBookmark'
  },
  'journal.delete': {
    context: 'journal',
    owner: 'journal',
    group: 'note',
    i18nKey: 'commands.journalDelete',
    destructive: true
  }
} as const satisfies Record<string, CommandMeta>
