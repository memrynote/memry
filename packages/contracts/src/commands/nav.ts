import type { CommandMeta } from './types'

export const NAV_COMMANDS = {
  'nav.newNote': {
    context: 'app',
    owner: 'shell',
    group: 'navigation',
    i18nKey: 'nav.newNote',
    menu: true,
    keyboard: { owner: 'app', default: { key: 'n', modifiers: { meta: true } }, inInput: 'always' }
  },
  'nav.search': {
    context: 'app',
    owner: 'shell',
    group: 'navigation',
    i18nKey: 'nav.search',
    menu: true,
    keyboard: {
      owner: 'app',
      default: { key: 'k', modifiers: { meta: true } },
      inInput: 'always',
      yieldToLocalCommandMenu: true,
      capture: true
    }
  },
  // The palette lists every other command, so it does not list itself.
  'nav.commands': {
    context: 'app',
    owner: 'shell',
    group: 'navigation',
    i18nKey: 'nav.commands',
    menu: true,
    palette: false,
    // Inherits the capture phase of the ⌘P search alias it replaced.
    keyboard: {
      owner: 'app',
      default: { key: 'p', modifiers: { meta: true } },
      inInput: 'always',
      capture: true
    }
  },
  'nav.settings': {
    context: 'app',
    owner: 'settings',
    group: 'navigation',
    i18nKey: 'nav.settings',
    menu: true,
    keyboard: { owner: 'app', default: { key: ',', modifiers: { meta: true } }, inInput: 'always' }
  },
  'nav.switchVault': {
    context: 'app',
    owner: 'vaultPager',
    group: 'navigation',
    i18nKey: 'nav.switchVault',
    keyboard: {
      owner: 'app',
      default: { key: 'o', modifiers: { meta: true, shift: true } },
      capture: true
    }
  },
  // ⌃⌘←/→ on macOS. Elsewhere `meta` already means Ctrl, and Ctrl+arrow is
  // word-jump in every text field, so the chord adds Alt instead.
  'nav.nextVault': {
    context: 'app',
    owner: 'vaultPager',
    group: 'navigation',
    i18nKey: 'nav.nextVault',
    keyboard: {
      owner: 'app',
      default: {
        mac: { key: 'ArrowRight', modifiers: { meta: true, ctrl: true } },
        other: { key: 'ArrowRight', modifiers: { meta: true, alt: true } }
      },
      skipAltGraph: true,
      capture: true
    }
  },
  'nav.prevVault': {
    context: 'app',
    owner: 'vaultPager',
    group: 'navigation',
    i18nKey: 'nav.prevVault',
    keyboard: {
      owner: 'app',
      default: {
        mac: { key: 'ArrowLeft', modifiers: { meta: true, ctrl: true } },
        other: { key: 'ArrowLeft', modifiers: { meta: true, alt: true } }
      },
      skipAltGraph: true,
      capture: true
    }
  }
} as const satisfies Record<string, CommandMeta>
