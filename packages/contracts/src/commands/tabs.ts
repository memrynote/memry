import type { CommandMeta } from './types'

export const TABS_COMMANDS = {
  'tabs.closeTab': {
    context: 'app',
    owner: 'tabs',
    group: 'tabs',
    i18nKey: 'tabs.close',
    menu: true,
    keyboard: {
      owner: 'app',
      default: { key: 'w', modifiers: { meta: true } },
      menuAccelerator: true
    }
  },
  'tabs.nextTab': {
    context: 'app',
    owner: 'tabs',
    group: 'tabs',
    i18nKey: 'tabs.next',
    palette: false,
    keyboard: { owner: 'app', default: { key: 'Tab', modifiers: { ctrl: true } } }
  },
  'tabs.prevTab': {
    context: 'app',
    owner: 'tabs',
    group: 'tabs',
    i18nKey: 'tabs.previous',
    palette: false,
    keyboard: { owner: 'app', default: { key: 'Tab', modifiers: { ctrl: true, shift: true } } }
  },
  'tabs.reopenTab': {
    context: 'app',
    owner: 'tabs',
    group: 'tabs',
    i18nKey: 'tabs.reopen',
    keyboard: { owner: 'app', default: { key: 't', modifiers: { meta: true, shift: true } } }
  },
  'tabs.navBack': {
    context: 'app',
    owner: 'tabs',
    group: 'tabs',
    i18nKey: 'tabs.navBack',
    keyboard: {
      owner: 'app',
      default: { key: '[', modifiers: { meta: true } },
      menuAccelerator: true
    }
  },
  'tabs.navForward': {
    context: 'app',
    owner: 'tabs',
    group: 'tabs',
    i18nKey: 'tabs.navForward',
    keyboard: {
      owner: 'app',
      default: { key: ']', modifiers: { meta: true } },
      menuAccelerator: true
    }
  },
  'tabs.newTab': {
    context: 'app',
    owner: 'tabs',
    group: 'tabs',
    i18nKey: 'tabs.newTab',
    keyboard: { owner: 'app', default: { key: 't', modifiers: { meta: true } } }
  },
  'tabs.closeAllTabs': {
    context: 'app',
    owner: 'tabs',
    group: 'tabs',
    i18nKey: 'tabs.closeAll',
    keyboard: { owner: 'app', default: { key: 'w', modifiers: { meta: true, shift: true } } }
  },
  'tabs.pinTab': {
    context: 'app',
    owner: 'tabs',
    group: 'tabs',
    i18nKey: 'tabs.pin',
    keyboard: { owner: 'app', default: { key: 'p', modifiers: { meta: true, shift: true } } }
  },
  'tabs.duplicateTab': {
    context: 'app',
    owner: 'tabs',
    group: 'tabs',
    i18nKey: 'tabs.duplicate',
    keyboard: { owner: 'app', default: { key: 'd', modifiers: { meta: true, shift: true } } }
  },
  'tabs.splitRight': {
    context: 'app',
    owner: 'tabs',
    group: 'tabs',
    i18nKey: 'tabs.splitRight',
    keyboard: { owner: 'app', default: { key: '\\', modifiers: { meta: true } } }
  },
  'tabs.splitDown': {
    context: 'app',
    owner: 'tabs',
    group: 'tabs',
    i18nKey: 'tabs.splitDown',
    keyboard: { owner: 'app', default: { key: '\\', modifiers: { meta: true, shift: true } } }
  },
  'tabs.closeSplit': {
    context: 'app',
    owner: 'tabs',
    group: 'tabs',
    i18nKey: 'tabs.closeSplit',
    keyboard: { owner: 'app', default: { key: 'w', modifiers: { meta: true, alt: true } } }
  }
} as const satisfies Record<string, CommandMeta>
