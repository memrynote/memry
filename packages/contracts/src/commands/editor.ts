import type { CommandMeta } from './types'

/**
 * Commands that act on the editor the user last focused in the active tab. The
 * five formatting keys are owned by ProseMirror: Settings lists them read-only
 * and the dispatcher never matches them. The rest have no key.
 */
export const EDITOR_COMMANDS = {
  'editor.bold': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'editor.bold',
    menu: true,
    keyboard: { owner: 'editor', display: { key: 'b', modifiers: { meta: true } } }
  },
  'editor.italic': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'editor.italic',
    menu: true,
    keyboard: { owner: 'editor', display: { key: 'i', modifiers: { meta: true } } }
  },
  'editor.underline': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'editor.underline',
    keyboard: { owner: 'editor', display: { key: 'u', modifiers: { meta: true } } }
  },
  'editor.strikethrough': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'editor.strikethrough',
    menu: true,
    keyboard: { owner: 'editor', display: { key: 's', modifiers: { meta: true, shift: true } } }
  },
  'editor.code': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'editor.code',
    menu: true,
    keyboard: { owner: 'editor', display: { key: 'e', modifiers: { meta: true } } }
  },
  'editor.undo': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'edit.undo',
    menu: true
  },
  'editor.redo': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'edit.redo',
    menu: true
  },
  'editor.heading1': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'format.heading1',
    menu: true
  },
  'editor.heading2': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'format.heading2',
    menu: true
  },
  'editor.heading3': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'format.heading3',
    menu: true
  },
  'editor.heading4': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'format.heading4',
    menu: true
  },
  'editor.heading5': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'format.heading5',
    menu: true
  },
  'editor.heading6': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'format.heading6',
    menu: true
  },
  'editor.body': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'format.body',
    menu: true
  },
  'editor.highlight': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'format.highlight',
    menu: true
  },
  'editor.insertCodeBlock': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'insert.codeBlock',
    menu: true
  },
  'editor.insertTable': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'insert.table',
    menu: true
  },
  'editor.insertBulletList': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'insert.bulletList',
    menu: true
  },
  'editor.insertNumberedList': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'insert.numberedList',
    menu: true
  },
  'editor.insertTaskList': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'insert.taskList',
    menu: true
  },
  'editor.insertAttachment': {
    context: 'app',
    owner: 'editor',
    group: 'editor',
    i18nKey: 'insert.attachment',
    menu: true
  }
} as const satisfies Record<string, CommandMeta>
