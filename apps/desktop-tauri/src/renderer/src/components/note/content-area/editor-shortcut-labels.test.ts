import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, formatKeyboardShortcut } from '@blocknote/core'
import { getDefaultSlashMenuItems } from '@blocknote/core/extensions'
import { en } from '@blocknote/core/locales'

const originalPlatform = navigator.platform

// The catalog reads the platform once, at import, so each platform loads it fresh.
async function onPlatform(platform: string) {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
  vi.resetModules()
  return import('./editor-shortcut-labels')
}

/** What BlockNote shows: its slash badges and its toolbar tooltips, after its own formatting. */
async function shownShortcuts(platform: string) {
  const { withShortcutBadges, withShortcutLabels } = await onPlatform(platform)
  const badges = withShortcutBadges(getDefaultSlashMenuItems(BlockNoteEditor.create()))
    .map((item) => item.badge)
    .filter((badge): badge is string => Boolean(badge))
  const toolbar = withShortcutLabels(en).formatting_toolbar
  const tooltip = (key: 'strike' | 'code' | 'unnest'): string =>
    formatKeyboardShortcut(toolbar[key].secondary_tooltip, en.generic.ctrl_shortcut)
  return {
    badges,
    strike: tooltip('strike'),
    code: tooltip('code'),
    unnest: tooltip('unnest')
  }
}

// #3510: BlockNote's formatter swaps only Mod, so macOS read "⌘-Alt-1".
describe('editor shortcut labels', () => {
  afterEach(() => {
    Object.defineProperty(navigator, 'platform', { value: originalPlatform, configurable: true })
  })

  it('shows macOS keycaps, never modifier words', async () => {
    const shown = await shownShortcuts('MacIntel')

    expect(shown.badges).toContain('⌥⌘1')
    expect(shown.badges).toContain('⇧⌘8')
    for (const label of [...shown.badges, shown.strike, shown.unnest]) {
      expect(label).not.toMatch(/Alt|Shift|Ctrl|Cmd|Mod|[-+]/)
    }
    expect(shown.strike).toBe('⇧⌘S')
    expect(shown.code).toBe('⌘E')
    expect(shown.unnest).toBe('⇧⇥')
  })

  it('shows Ctrl, Alt and Shift elsewhere', async () => {
    const shown = await shownShortcuts('Win32')

    expect(shown.badges).toContain('Ctrl+Alt+1')
    expect(shown.badges).toContain('Ctrl+Shift+8')
    expect(shown.strike).toBe('Ctrl+Shift+S')
    expect(shown.code).toBe('Ctrl+E')
  })
})
