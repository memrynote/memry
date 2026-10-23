import type { CommandMeta, KeyboardSpec } from './types'

/**
 * Fold the note or journal day in the active tab to a level. Level is a view
 * of the note, never saved, so these are view commands. The owner exists once
 * per tab and is available only while that tab shows a foldable note.
 */
const foldKey = (digit: string): KeyboardSpec => ({
  owner: 'app',
  default: { key: digit, modifiers: { meta: true, alt: true } },
  // Ctrl+Alt is AltGr on Windows, so it would fire for typed characters.
  skipAltGraph: true
})

export const FOLD_COMMANDS = {
  'fold.full': {
    context: 'app',
    owner: 'fold',
    group: 'view',
    i18nKey: 'view.foldFull',
    keyboard: foldKey('1')
  },
  'fold.brief': {
    context: 'app',
    owner: 'fold',
    group: 'view',
    i18nKey: 'view.foldBrief',
    keyboard: foldKey('2')
  },
  'fold.key': {
    context: 'app',
    owner: 'fold',
    group: 'view',
    i18nKey: 'view.foldKey',
    keyboard: foldKey('3')
  },
  'fold.takeaway': {
    context: 'app',
    owner: 'fold',
    group: 'view',
    i18nKey: 'view.foldTakeaway',
    keyboard: foldKey('4')
  },
  'fold.topic': {
    context: 'app',
    owner: 'fold',
    group: 'view',
    i18nKey: 'view.foldTopic',
    keyboard: foldKey('5')
  }
} as const satisfies Record<string, CommandMeta>
