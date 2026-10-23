import { describe, expect, it } from 'vitest'
import type { ShortcutBinding } from '../settings-schemas'
import {
  COMMANDS,
  LEGACY_SHORTCUT_IDS,
  SETTINGS_SECTIONS,
  settingsCommandId,
  type CommandId
} from './index'
import { LEGACY_SHORTCUTS } from './legacy-shortcuts.fixture'
import { resolvePlatformBinding, type CommandMeta, type KeyboardSpec } from './types'

const entries = Object.entries(COMMANDS) as [CommandId, CommandMeta][]

function chord(binding: ShortcutBinding): string {
  const { meta, ctrl, shift, alt } = binding.modifiers
  return [meta && 'meta', ctrl && 'ctrl', shift && 'shift', alt && 'alt', binding.key.toLowerCase()]
    .filter(Boolean)
    .join('+')
}

describe('legacy shortcut compatibility', () => {
  it('keeps exactly the 30 ids users saved overrides under', () => {
    expect(LEGACY_SHORTCUTS).toHaveLength(30)
    expect([...LEGACY_SHORTCUT_IDS]).toEqual(LEGACY_SHORTCUTS.map((row) => row.id))
  })

  it.each(LEGACY_SHORTCUTS.map((row) => [row.id, row] as const))(
    '%s keeps its i18n key and default binding on both platforms',
    (id, row) => {
      const meta: CommandMeta = COMMANDS[id as CommandId]
      const keyboard = meta.keyboard
      expect(keyboard).toBeDefined()
      expect(meta.i18nKey).toBe(row.i18nKey)
      expect(keyboard!.owner === 'app').toBe(row.rebindable)

      const binding = keyboard!.owner === 'app' ? keyboard!.default : keyboard!.display
      for (const isMac of [true, false]) {
        expect(resolvePlatformBinding(binding, isMac)).toEqual(
          resolvePlatformBinding(row.binding, isMac)
        )
      }
    }
  )
})

describe('COMMANDS', () => {
  it('uses dotted ids', () => {
    for (const [id] of entries) expect(id).toMatch(/^[a-z]+\.[a-zA-Z0-9]+$/)
  })

  it('gives destructive commands no keyboard default', () => {
    for (const [id, meta] of entries.filter(([, m]) => m.destructive)) {
      expect(meta.keyboard, id).toBeUndefined()
    }
  })

  it('never mirrors a richText-yielding command as a native menu accelerator', () => {
    // A macOS menu accelerator is a live key equivalent: it would take ⌘B from Bold.
    for (const [id, meta] of entries) {
      const keyboard = meta.keyboard
      const mirroredAsAccelerator = keyboard?.owner === 'app' && Boolean(keyboard.menuAccelerator)
      expect(mirroredAsAccelerator ? keyboard.richText : undefined, id).not.toBe('yield')
    }
  })

  it('mirrors exactly the accelerators the native menu shows today', () => {
    const mirrored = entries
      .filter(([, meta]) => meta.keyboard?.owner === 'app' && meta.keyboard.menuAccelerator)
      .map(([id]) => id)
    expect(mirrored.sort()).toEqual(
      [
        'tabs.navBack',
        'tabs.navForward',
        'tabs.closeTab',
        'view.actualSize',
        'view.zoomIn',
        'view.zoomOut',
        'view.toggleDayPanel'
      ].sort()
    )
  })

  it('keeps each owner in one context', () => {
    const contextByOwner = new Map<string, string>()
    for (const [id, meta] of entries) {
      const seen = contextByOwner.get(meta.owner)
      expect(seen === undefined || seen === meta.context, `${id} (${meta.owner})`).toBe(true)
      contextByOwner.set(meta.owner, meta.context)
    }
  })

  it.each([true, false])('gives no two app shortcuts the same default chord (mac: %s)', (isMac) => {
    const owners = new Map<string, string>()
    for (const [id, meta] of entries) {
      if (meta.keyboard?.owner !== 'app') continue
      const key = chord(resolvePlatformBinding(meta.keyboard.default, isMac))
      expect(owners.get(key), `${id} shares ${key} with ${owners.get(key)}`).toBeUndefined()
      owners.set(key, id)
    }
  })

  it('encodes the guard policies the hooks apply today', () => {
    const app = (id: CommandId) => {
      const keyboard: KeyboardSpec | undefined = (COMMANDS[id] as CommandMeta).keyboard
      if (keyboard?.owner !== 'app') throw new Error(`${id} has no app keyboard spec`)
      return keyboard
    }

    expect(app('view.toggleSidebar').richText).toBe('yield')
    expect(app('nav.nextVault').skipAltGraph).toBe(true)
    expect(app('nav.prevVault').skipAltGraph).toBe(true)
    expect(app('nav.search').yieldToLocalCommandMenu).toBe(true)
    for (const id of ['nav.newNote', 'nav.search', 'nav.settings', 'view.shortcuts'] as const) {
      expect(app(id).inInput, id).toBe('always')
    }
    for (const id of ['view.zoomIn', 'view.zoomOut', 'view.actualSize'] as const) {
      expect(app(id).inInput, id).toBe('always')
    }
    expect(app('view.shortcuts').aliases).toEqual([
      { chord: { key: '?', modifiers: {} }, inInput: 'never' }
    ])
    expect(app('view.zoomIn').aliases).toEqual([
      { chord: { key: '+', modifiers: { meta: true, shift: true } }, whileDefault: true }
    ])
  })
})

describe('keyboard phase', () => {
  // Each id's old listener, read from HEAD: use-search-shortcut, use-switch-vault-shortcut,
  // the vault-pager listener, use-app-zoom and App.tsx's help effect were capture. Every other
  // chord rode the bubble phase, where a widget that stops propagation (Excalidraw) keeps it.
  it('puts exactly the chords that were capture-phase before the registry in capture', () => {
    const capture = entries
      .filter(([, meta]) => meta.keyboard?.owner === 'app' && meta.keyboard.capture)
      .map(([id]) => id)
    expect(capture.sort()).toEqual(
      [
        'nav.search',
        'nav.commands',
        'nav.switchVault',
        'nav.nextVault',
        'nav.prevVault',
        'view.zoomIn',
        'view.zoomOut',
        'view.actualSize',
        'view.shortcuts'
      ].sort()
    )
  })
})

describe('the commands palette command', () => {
  it('owns ⌘P, and ⌘K search no longer aliases it', () => {
    const commands = COMMANDS['nav.commands'].keyboard
    expect(commands.default).toEqual({ key: 'p', modifiers: { meta: true } })
    expect(commands.inInput).toBe('always')
    expect('aliases' in COMMANDS['nav.search'].keyboard).toBe(false)
  })

  it('is not listed in the palette it opens', () => {
    expect(COMMANDS['nav.commands'].palette).toBe(false)
  })
})

describe('settings section commands', () => {
  it('has exactly one command per section, named after it', () => {
    const ids = entries.filter(([, meta]) => meta.owner === 'settings' && meta.group === 'settings')
    expect(ids.map(([id]) => id).sort()).toEqual(
      SETTINGS_SECTIONS.map((section) => settingsCommandId(section)).sort()
    )
  })

  it('turns a hyphenated section into camel case', () => {
    expect(settingsCommandId('agent-providers')).toBe('settings.openAgentProviders')
    expect(settingsCommandId('command-line')).toBe('settings.openCommandLine')
    expect(settingsCommandId('general')).toBe('settings.openGeneral')
  })
})

describe('resolvePlatformBinding', () => {
  const mac: ShortcutBinding = { key: 'ArrowRight', modifiers: { meta: true, ctrl: true } }
  const other: ShortcutBinding = { key: 'ArrowRight', modifiers: { meta: true, alt: true } }

  it('picks the platform half of a split binding', () => {
    expect(resolvePlatformBinding({ mac, other }, true)).toBe(mac)
    expect(resolvePlatformBinding({ mac, other }, false)).toBe(other)
  })

  it('returns a plain binding unchanged', () => {
    expect(resolvePlatformBinding(mac, false)).toBe(mac)
  })
})
