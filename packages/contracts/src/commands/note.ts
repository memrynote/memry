import type { CommandMeta } from './types'

/** Acts on the note shown in the active tab. */
export const NOTE_COMMANDS = {
  'note.exportPdf': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'file.exportPdf',
    menu: true
  },
  'note.find': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'edit.find',
    menu: true
  },
  'note.localGraph': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteLocalGraph'
  },
  'note.versionHistory': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteVersionHistory'
  },
  'note.applyTemplate': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteApplyTemplate'
  },
  'note.insertTemplate': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteInsertTemplate'
  },
  'note.saveAsTemplate': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteSaveAsTemplate'
  },
  'note.newFromNote': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteNewFromNote'
  },
  'note.toggleFullWidth': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteToggleFullWidth'
  },
  'note.toggleMindMap': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteToggleMindMap'
  },
  'note.rename': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteRename'
  },
  'note.addName': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteAddName'
  },
  'note.moveToFolder': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteMoveToFolder'
  },
  'note.copyPath': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteCopyPath'
  },
  'note.revealInFinder': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteRevealInFinder'
  },
  'note.revealInSidebar': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteRevealInSidebar'
  },
  'note.openExternal': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteOpenExternal'
  },
  'note.attachments': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteAttachments'
  },
  'note.toggleLocalOnly': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteToggleLocalOnly'
  },
  'note.toggleLock': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteToggleLock'
  },
  'note.toggleBookmark': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteToggleBookmark'
  },
  'note.setReminder': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteSetReminder'
  },
  'note.delete': {
    context: 'note',
    owner: 'note',
    group: 'note',
    i18nKey: 'commands.noteDelete',
    destructive: true
  }
} as const satisfies Record<string, CommandMeta>
