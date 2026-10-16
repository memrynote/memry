import type { PlatformBinding } from './types'

/**
 * Frozen copy of the 30 shortcuts as the retired `lib/shortcut-registry.ts` shipped them
 * (git: apps/desktop/src/renderer/src/lib/shortcut-registry.ts at the commit
 * before commands existed). Users' saved overrides are keyed by these ids, so
 * an edit here is a compatibility break, not a refactor.
 */
export const LEGACY_SHORTCUTS: readonly {
  id: string
  i18nKey: string
  rebindable: boolean
  binding: PlatformBinding
}[] = [
  {
    id: 'nav.newNote',
    i18nKey: 'nav.newNote',
    rebindable: true,
    binding: { key: 'n', modifiers: { meta: true } }
  },
  {
    id: 'nav.search',
    i18nKey: 'nav.search',
    rebindable: true,
    binding: { key: 'k', modifiers: { meta: true } }
  },
  {
    id: 'nav.settings',
    i18nKey: 'nav.settings',
    rebindable: true,
    binding: { key: ',', modifiers: { meta: true } }
  },
  {
    id: 'nav.switchVault',
    i18nKey: 'nav.switchVault',
    rebindable: true,
    binding: { key: 'o', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'nav.nextVault',
    i18nKey: 'nav.nextVault',
    rebindable: true,
    binding: {
      mac: { key: 'ArrowRight', modifiers: { meta: true, ctrl: true } },
      other: { key: 'ArrowRight', modifiers: { meta: true, alt: true } }
    }
  },
  {
    id: 'nav.prevVault',
    i18nKey: 'nav.prevVault',
    rebindable: true,
    binding: {
      mac: { key: 'ArrowLeft', modifiers: { meta: true, ctrl: true } },
      other: { key: 'ArrowLeft', modifiers: { meta: true, alt: true } }
    }
  },
  {
    id: 'tabs.closeTab',
    i18nKey: 'tabs.close',
    rebindable: true,
    binding: { key: 'w', modifiers: { meta: true } }
  },
  {
    id: 'tabs.nextTab',
    i18nKey: 'tabs.next',
    rebindable: true,
    binding: { key: 'Tab', modifiers: { ctrl: true } }
  },
  {
    id: 'tabs.prevTab',
    i18nKey: 'tabs.previous',
    rebindable: true,
    binding: { key: 'Tab', modifiers: { ctrl: true, shift: true } }
  },
  {
    id: 'tabs.reopenTab',
    i18nKey: 'tabs.reopen',
    rebindable: true,
    binding: { key: 't', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'tabs.navBack',
    i18nKey: 'tabs.navBack',
    rebindable: true,
    binding: { key: '[', modifiers: { meta: true } }
  },
  {
    id: 'tabs.navForward',
    i18nKey: 'tabs.navForward',
    rebindable: true,
    binding: { key: ']', modifiers: { meta: true } }
  },
  {
    id: 'tabs.newTab',
    i18nKey: 'tabs.newTab',
    rebindable: true,
    binding: { key: 't', modifiers: { meta: true } }
  },
  {
    id: 'tabs.closeAllTabs',
    i18nKey: 'tabs.closeAll',
    rebindable: true,
    binding: { key: 'w', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'tabs.pinTab',
    i18nKey: 'tabs.pin',
    rebindable: true,
    binding: { key: 'p', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'tabs.duplicateTab',
    i18nKey: 'tabs.duplicate',
    rebindable: true,
    binding: { key: 'd', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'tabs.splitRight',
    i18nKey: 'tabs.splitRight',
    rebindable: true,
    binding: { key: '\\', modifiers: { meta: true } }
  },
  {
    id: 'tabs.splitDown',
    i18nKey: 'tabs.splitDown',
    rebindable: true,
    binding: { key: '\\', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'tabs.closeSplit',
    i18nKey: 'tabs.closeSplit',
    rebindable: true,
    binding: { key: 'w', modifiers: { meta: true, alt: true } }
  },
  {
    id: 'editor.bold',
    i18nKey: 'editor.bold',
    rebindable: false,
    binding: { key: 'b', modifiers: { meta: true } }
  },
  {
    id: 'editor.italic',
    i18nKey: 'editor.italic',
    rebindable: false,
    binding: { key: 'i', modifiers: { meta: true } }
  },
  {
    id: 'editor.underline',
    i18nKey: 'editor.underline',
    rebindable: false,
    binding: { key: 'u', modifiers: { meta: true } }
  },
  {
    id: 'editor.strikethrough',
    i18nKey: 'editor.strikethrough',
    rebindable: false,
    binding: { key: 's', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'editor.code',
    i18nKey: 'editor.code',
    rebindable: false,
    binding: { key: 'e', modifiers: { meta: true } }
  },
  {
    id: 'view.toggleSidebar',
    i18nKey: 'view.toggleSidebar',
    rebindable: true,
    binding: { key: 'b', modifiers: { meta: true } }
  },
  {
    id: 'view.toggleDayPanel',
    i18nKey: 'view.toggleDayPanel',
    rebindable: true,
    binding: { key: 'b', modifiers: { meta: true, shift: true } }
  },
  {
    id: 'view.shortcuts',
    i18nKey: 'view.shortcuts',
    rebindable: true,
    binding: { key: '/', modifiers: { meta: true } }
  },
  {
    id: 'view.zoomIn',
    i18nKey: 'view.zoomIn',
    rebindable: true,
    binding: { key: '=', modifiers: { meta: true } }
  },
  {
    id: 'view.zoomOut',
    i18nKey: 'view.zoomOut',
    rebindable: true,
    binding: { key: '-', modifiers: { meta: true } }
  },
  {
    id: 'view.actualSize',
    i18nKey: 'view.actualSize',
    rebindable: true,
    binding: { key: '0', modifiers: { meta: true } }
  }
]
