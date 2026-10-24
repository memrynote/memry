import { describe, expect, it } from 'vitest'
import { COMMANDS } from '@memry/contracts/commands'
import { RESOURCES } from '@memry/i18n/locales'
import { SHORTCUT_ENTRIES, SHORTCUT_GROUP_ORDER } from './shortcut-catalog'

/**
 * English strings the 30 legacy shortcuts shipped with, copied from the
 * pre-commands shortcut registry: [id, i18nKey, group, label, description].
 */
const LEGACY_COPY = [
  ['nav.newNote', 'nav.newNote', 'navigation', 'New Note', 'Create a new note'],
  ['nav.search', 'nav.search', 'navigation', 'Search', 'Open global search'],
  ['nav.settings', 'nav.settings', 'navigation', 'Open Settings', 'Open the settings panel'],
  ['nav.switchVault', 'nav.switchVault', 'navigation', 'Switch Vault', 'Open the vault switcher'],
  [
    'nav.nextVault',
    'nav.nextVault',
    'navigation',
    'Next Vault',
    'Move to the next vault in the sidebar'
  ],
  [
    'nav.prevVault',
    'nav.prevVault',
    'navigation',
    'Previous Vault',
    'Move to the previous vault in the sidebar'
  ],
  ['tabs.closeTab', 'tabs.close', 'tabs', 'Close Tab', 'Close the current tab'],
  ['tabs.nextTab', 'tabs.next', 'tabs', 'Next Tab', 'Switch to the next tab'],
  ['tabs.prevTab', 'tabs.previous', 'tabs', 'Previous Tab', 'Switch to the previous tab'],
  [
    'tabs.reopenTab',
    'tabs.reopen',
    'tabs',
    'Reopen Last Tab',
    'Reopen the most recently closed tab'
  ],
  [
    'tabs.navBack',
    'tabs.navBack',
    'tabs',
    'Navigate Back',
    'Re-activate the previously active tab'
  ],
  ['tabs.navForward', 'tabs.navForward', 'tabs', 'Navigate Forward', 'Redo a back navigation'],
  ['tabs.newTab', 'tabs.newTab', 'tabs', 'New Tab', 'Open the new tab menu'],
  [
    'tabs.closeAllTabs',
    'tabs.closeAll',
    'tabs',
    'Close All Tabs',
    'Close every tab in the current pane'
  ],
  ['tabs.pinTab', 'tabs.pin', 'tabs', 'Pin Tab', 'Pin or unpin the current tab'],
  [
    'tabs.duplicateTab',
    'tabs.duplicate',
    'tabs',
    'Duplicate Tab',
    'Open a copy of the current tab'
  ],
  [
    'tabs.splitRight',
    'tabs.splitRight',
    'tabs',
    'Split Right',
    'Split the current pane side by side'
  ],
  [
    'tabs.splitDown',
    'tabs.splitDown',
    'tabs',
    'Split Down',
    'Split the current pane top and bottom'
  ],
  [
    'tabs.closeSplit',
    'tabs.closeSplit',
    'tabs',
    'Close Split Pane',
    'Close the current split pane'
  ],
  ['editor.bold', 'editor.bold', 'editor', 'Bold', 'Toggle bold formatting'],
  ['editor.italic', 'editor.italic', 'editor', 'Italic', 'Toggle italic formatting'],
  ['editor.underline', 'editor.underline', 'editor', 'Underline', 'Toggle underline formatting'],
  [
    'editor.strikethrough',
    'editor.strikethrough',
    'editor',
    'Strikethrough',
    'Toggle strikethrough formatting'
  ],
  ['editor.code', 'editor.code', 'editor', 'Inline Code', 'Toggle inline code formatting'],
  [
    'view.toggleSidebar',
    'view.toggleSidebar',
    'view',
    'Toggle Sidebar',
    'Show or hide the sidebar'
  ],
  [
    'view.toggleDayPanel',
    'view.toggleDayPanel',
    'view',
    'Toggle Day Panel',
    'Show or hide the day panel on the right'
  ],
  [
    'view.shortcuts',
    'view.shortcuts',
    'view',
    'Keyboard Shortcuts Help',
    'Show keyboard shortcuts reference'
  ],
  ['view.zoomIn', 'view.zoomIn', 'view', 'Zoom In', 'Make everything larger'],
  ['view.zoomOut', 'view.zoomOut', 'view', 'Zoom Out', 'Make everything smaller'],
  ['view.actualSize', 'view.actualSize', 'view', 'Actual Size', 'Reset zoom to 100%']
] as const

const GROUP_LABELS: Record<string, string> = {
  navigation: 'Navigation',
  tabs: 'Tabs',
  editor: 'Editor',
  view: 'View'
}

function lookup(path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined,
      RESOURCES.en.settings
    )
}

describe('shortcut catalog i18n', () => {
  it('has a non-empty label and description for every shortcut command i18nKey', () => {
    for (const [id, meta] of Object.entries(COMMANDS)) {
      if (!('keyboard' in meta)) continue
      expect(lookup(`shortcuts.entries.${meta.i18nKey}.label`), `${id} label`).toEqual(
        expect.any(String)
      )
      expect(lookup(`shortcuts.entries.${meta.i18nKey}.label`), `${id} label`).not.toBe('')
      expect(lookup(`shortcuts.entries.${meta.i18nKey}.description`), `${id} description`).toEqual(
        expect.any(String)
      )
      expect(lookup(`shortcuts.entries.${meta.i18nKey}.description`), `${id} description`).not.toBe(
        ''
      )
    }
  })

  it('labels every other command from the menu namespace', () => {
    for (const [id, meta] of Object.entries(COMMANDS)) {
      if ('keyboard' in meta) continue
      const label = meta.i18nKey
        .split('.')
        .reduce<unknown>(
          (value, part) =>
            value && typeof value === 'object'
              ? (value as Record<string, unknown>)[part]
              : undefined,
          RESOURCES.en.menu
        )
      expect(label, `${id} -> menu:${meta.i18nKey}`).toEqual(expect.any(String))
    }
  })

  it('keeps the English label and description of every legacy shortcut', () => {
    for (const [id, i18nKey, group, label, description] of LEGACY_COPY) {
      const entry = SHORTCUT_ENTRIES.find((candidate) => candidate.id === id)
      expect(entry?.i18nKey).toBe(i18nKey)
      expect(entry?.group).toBe(group)
      expect(lookup(`shortcuts.entries.${i18nKey}.label`)).toBe(label)
      expect(lookup(`shortcuts.entries.${i18nKey}.description`)).toBe(description)
    }
  })

  it('has settings namespace labels for every shortcut group', () => {
    for (const group of SHORTCUT_GROUP_ORDER) {
      expect(lookup(`shortcuts.categories.${group}`)).toBe(GROUP_LABELS[group])
    }
  })
})
