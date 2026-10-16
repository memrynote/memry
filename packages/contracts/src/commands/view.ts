import type { CommandMeta } from './types'

export const VIEW_COMMANDS = {
  'view.toggleSidebar': {
    context: 'app',
    owner: 'sidebar',
    group: 'view',
    i18nKey: 'view.toggleSidebar',
    menu: true,
    // ⌘B is Bold in the note editor and nothing else.
    keyboard: { owner: 'app', default: { key: 'b', modifiers: { meta: true } }, richText: 'yield' }
  },
  'view.toggleDayPanel': {
    context: 'app',
    owner: 'dayPanel',
    group: 'view',
    i18nKey: 'view.toggleDayPanel',
    menu: true,
    keyboard: {
      owner: 'app',
      default: { key: 'b', modifiers: { meta: true, shift: true } },
      menuAccelerator: true
    }
  },
  'view.shortcuts': {
    context: 'app',
    owner: 'shell',
    group: 'view',
    i18nKey: 'view.shortcuts',
    menu: true,
    keyboard: {
      owner: 'app',
      default: { key: '/', modifiers: { meta: true } },
      inInput: 'always',
      // Shift-agnostic: matches `e.key === '?'` whatever layout produced it.
      aliases: [{ chord: { key: '?', modifiers: {} }, inInput: 'never' }],
      capture: true
    }
  },
  'view.zoomIn': {
    context: 'app',
    owner: 'zoom',
    group: 'view',
    i18nKey: 'view.zoomIn',
    menu: true,
    keyboard: {
      owner: 'app',
      default: { key: '=', modifiers: { meta: true } },
      inInput: 'always',
      // On most layouts `+` is Shift+`=`, which the matcher rejects unless the
      // chord asks for it. Once zoom in is rebound, ⌘+ is free again.
      aliases: [
        { chord: { key: '+', modifiers: { meta: true, shift: true } }, whileDefault: true }
      ],
      menuAccelerator: true,
      capture: true
    }
  },
  'view.zoomOut': {
    context: 'app',
    owner: 'zoom',
    group: 'view',
    i18nKey: 'view.zoomOut',
    menu: true,
    keyboard: {
      owner: 'app',
      default: { key: '-', modifiers: { meta: true } },
      inInput: 'always',
      menuAccelerator: true,
      capture: true
    }
  },
  'view.actualSize': {
    context: 'app',
    owner: 'zoom',
    group: 'view',
    i18nKey: 'view.actualSize',
    menu: true,
    keyboard: {
      owner: 'app',
      default: { key: '0', modifiers: { meta: true } },
      inInput: 'always',
      menuAccelerator: true,
      capture: true
    }
  },
  'view.themeLight': {
    context: 'app',
    owner: 'appearance',
    group: 'view',
    i18nKey: 'commands.themeLight',
    menu: true
  },
  'view.themeDark': {
    context: 'app',
    owner: 'appearance',
    group: 'view',
    i18nKey: 'commands.themeDark',
    menu: true
  },
  'view.themeWhite': {
    context: 'app',
    owner: 'appearance',
    group: 'view',
    i18nKey: 'commands.themeWhite',
    menu: true
  },
  'view.themeSystem': {
    context: 'app',
    owner: 'appearance',
    group: 'view',
    i18nKey: 'commands.themeSystem',
    menu: true
  }
} as const satisfies Record<string, CommandMeta>
