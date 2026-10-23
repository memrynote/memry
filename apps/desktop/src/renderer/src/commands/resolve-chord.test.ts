import { describe, expect, it } from 'vitest'
import type { CommandId } from '@memry/contracts/commands'
import type { FolderNoteShortcut } from '@memry/contracts/settings-schemas'
import { resolveChord, resolveFolderChord, type KeydownEnv } from './resolve-chord'

// Off macOS `meta` is Ctrl, so a default of ⌘W is a Ctrl+W keystroke here.
const env = (overrides: Partial<KeydownEnv> = {}): KeydownEnv => ({
  isMac: false,
  isRecording: false,
  isBlocked: false,
  isInInput: false,
  isRichTextFocused: false,
  focusOwnsLocalCommandMenu: false,
  overrides: {},
  folderShortcuts: [],
  isAvailable: () => true,
  ...overrides
})

const press = (init: KeyboardEventInit): KeyboardEvent =>
  new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })

// Both window listeners see every key; the capture one runs first and consumes what it resolves.
const resolve = (e: KeyboardEvent, world: KeydownEnv): CommandId | null =>
  resolveChord(e, world, 'capture') ?? resolveChord(e, world, 'bubble')

describe('resolveChord: which phase a command listens in', () => {
  it('resolves a bubble command only in the bubble phase', () => {
    const back = press({ key: '[', ctrlKey: true })
    expect(resolveChord(back, env(), 'capture')).toBeNull()
    expect(resolveChord(back, env(), 'bubble')).toBe('tabs.navBack')
  })

  it('resolves a capture command only in the capture phase, aliases included', () => {
    const search = press({ key: 'k', ctrlKey: true })
    expect(resolveChord(search, env(), 'capture')).toBe('nav.search')
    expect(resolveChord(search, env(), 'bubble')).toBeNull()

    const question = press({ key: '?', shiftKey: true })
    expect(resolveChord(question, env(), 'capture')).toBe('view.shortcuts')
    expect(resolveChord(question, env(), 'bubble')).toBeNull()
  })

  it('hands a chord to the winner even when the winner listens in the other phase', () => {
    // ⌘P is capture-phase nav.commands by default. The user gave it to pin, which is bubble.
    const rebound = { 'tabs.pinTab': { key: 'p', modifiers: { meta: true } } }
    const chord = press({ key: 'p', ctrlKey: true })
    expect(resolveChord(chord, env({ overrides: rebound }), 'capture')).toBeNull()
    expect(resolveChord(chord, env({ overrides: rebound }), 'bubble')).toBe('tabs.pinTab')
  })

  it('keeps a rebound command in its own phase', () => {
    const rebound = { 'tabs.navBack': { key: 'y', modifiers: { meta: true } } }
    const chosen = press({ key: 'y', ctrlKey: true })
    expect(resolveChord(chosen, env({ overrides: rebound }), 'capture')).toBeNull()
    expect(resolveChord(chosen, env({ overrides: rebound }), 'bubble')).toBe('tabs.navBack')
  })
})

describe('resolveChord: which command a keystroke means', () => {
  it.each<[string, KeyboardEventInit, CommandId]>([
    ['⌘W closes the tab', { key: 'w', ctrlKey: true }, 'tabs.closeTab'],
    [
      '⌘⇧W closes all tabs, not the tab',
      { key: 'W', ctrlKey: true, shiftKey: true },
      'tabs.closeAllTabs'
    ],
    ['⌘⌥W closes the split', { key: 'w', ctrlKey: true, altKey: true }, 'tabs.closeSplit'],
    // Option+digit types a symbol on macOS; the chord matches the physical key.
    ['⌘⌥2 folds to Brief', { key: '2', code: 'Digit2', ctrlKey: true, altKey: true }, 'fold.brief'],
    ['⌘⌥5 folds to Topic', { key: '5', code: 'Digit5', ctrlKey: true, altKey: true }, 'fold.topic'],
    ['Ctrl+Tab is the next tab', { key: 'Tab', ctrlKey: true }, 'tabs.nextTab'],
    [
      'Ctrl+⇧Tab is the previous tab',
      { key: 'Tab', ctrlKey: true, shiftKey: true },
      'tabs.prevTab'
    ],
    ['⌘\\ splits right', { key: '\\', ctrlKey: true }, 'tabs.splitRight'],
    [
      '⌘⇧\\ splits down on the real keystroke, which reports "|"',
      { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true },
      'tabs.splitDown'
    ],
    [
      'an Option-composed key falls back to the physical key',
      { key: '∑', code: 'KeyW', ctrlKey: true, altKey: true },
      'tabs.closeSplit'
    ],
    ['⌘, opens settings', { key: ',', ctrlKey: true }, 'nav.settings']
  ])('%s', (_name, init, id) => {
    expect(resolve(press(init), env())).toBe(id)
  })

  it('returns null for a chord nothing is bound to', () => {
    expect(resolve(press({ key: 'q', ctrlKey: true }), env())).toBeNull()
    expect(resolve(press({ key: 'w' }), env())).toBeNull()
  })

  it('never matches a key the note editor owns', () => {
    // ⌘I is editor.italic: display-only, so the app has nothing to run.
    expect(resolve(press({ key: 'i', ctrlKey: true }), env())).toBeNull()
    expect(resolve(press({ key: 'S', ctrlKey: true, shiftKey: true }), env())).toBeNull()
  })
})

describe('resolveChord: when the keystroke is not for a command', () => {
  it('stands down while Settings records a chord', () => {
    expect(resolve(press({ key: 'w', ctrlKey: true }), env({ isRecording: true }))).toBeNull()
  })

  it('stands down while hint mode or a vault switch holds the keyboard', () => {
    expect(resolve(press({ key: 'w', ctrlKey: true }), env({ isBlocked: true }))).toBeNull()
  })

  it('skips a command with no available owner and lets the key pass', () => {
    const noSplit = env({ isAvailable: (id) => id !== 'tabs.closeSplit' })
    expect(resolve(press({ key: 'w', ctrlKey: true, altKey: true }), noSplit)).toBeNull()
    expect(resolve(press({ key: 'w', ctrlKey: true }), noSplit)).toBe('tabs.closeTab')
  })
})

describe('resolveChord: typing in a field or the editor', () => {
  it('fires a ⌘/Ctrl chord with the caret in a field', () => {
    expect(resolve(press({ key: 'w', ctrlKey: true }), env({ isInInput: true }))).toBe(
      'tabs.closeTab'
    )
  })

  it('keeps a rebind without ⌘/Ctrl out of fields, where it would eat typing', () => {
    const rebound = { 'tabs.splitRight': { key: 'y', modifiers: {} } }
    expect(resolve(press({ key: 'y' }), env({ isInInput: true, overrides: rebound }))).toBeNull()
    expect(resolve(press({ key: 'y' }), env({ overrides: rebound }))).toBe('tabs.splitRight')
  })

  it('lets Escape through a field, as the base shortcut hook always has', () => {
    const rebound = { 'tabs.closeTab': { key: 'Escape', modifiers: {} } }
    expect(resolve(press({ key: 'Escape' }), env({ isInInput: true, overrides: rebound }))).toBe(
      'tabs.closeTab'
    )
  })

  it("honors inInput 'always': ⌘N fires with the caret anywhere", () => {
    expect(resolve(press({ key: 'n', ctrlKey: true }), env({ isInInput: true }))).toBe(
      'nav.newNote'
    )
  })

  it('yields ⌘B to the editor while rich text has focus, but not ⌘⇧B', () => {
    const inEditor = env({ isInInput: true, isRichTextFocused: true })
    expect(resolve(press({ key: 'b', ctrlKey: true }), inEditor)).toBeNull()
    expect(resolve(press({ key: 'B', ctrlKey: true, shiftKey: true }), inEditor)).toBe(
      'view.toggleDayPanel'
    )
    expect(resolve(press({ key: 'b', ctrlKey: true }), env())).toBe('view.toggleSidebar')
  })
})

describe('resolveChord: aliases', () => {
  it("fires the shift-agnostic ? alias outside fields, and never inside one (inInput 'never')", () => {
    const question = press({ key: '?', shiftKey: true })
    expect(resolve(question, env())).toBe('view.shortcuts')
    expect(resolve(question, env({ isInInput: true }))).toBeNull()
    expect(resolve(press({ key: '?', ctrlKey: true }), env())).toBeNull()
  })

  it('still fires ⌘/ inside a field', () => {
    expect(resolve(press({ key: '/', ctrlKey: true }), env({ isInInput: true }))).toBe(
      'view.shortcuts'
    )
  })

  it('keeps the ? alias after the user rebinds the help dialog', () => {
    const rebound = { 'view.shortcuts': { key: 'h', modifiers: { meta: true } } }
    expect(resolve(press({ key: '?', shiftKey: true }), env({ overrides: rebound }))).toBe(
      'view.shortcuts'
    )
  })

  it('accepts ⌘+ for zoom in only while zoom in is still on its default', () => {
    const plus = press({ key: '+', ctrlKey: true, shiftKey: true })
    expect(resolve(plus, env())).toBe('view.zoomIn')

    const rebound = { 'view.zoomIn': { key: 'j', modifiers: { meta: true } } }
    expect(resolve(plus, env({ overrides: rebound }))).toBeNull()
    expect(resolve(press({ key: 'j', ctrlKey: true }), env({ overrides: rebound }))).toBe(
      'view.zoomIn'
    )
  })
})

describe('resolveChord: user rebinds', () => {
  it('frees the default chord once a command is rebound', () => {
    const rebound = { 'tabs.pinTab': { key: 'y', modifiers: { meta: true } } }
    expect(
      resolve(press({ key: 'P', ctrlKey: true, shiftKey: true }), env({ overrides: rebound }))
    ).toBeNull()
    expect(resolve(press({ key: 'y', ctrlKey: true }), env({ overrides: rebound }))).toBe(
      'tabs.pinTab'
    )
  })

  it('resolves a collision in favor of the rebound command, even one later in the table', () => {
    // ⌘T is tabs.newTab by default. The user gave it to pin as well.
    const rebound = { 'tabs.pinTab': { key: 't', modifiers: { meta: true } } }
    expect(resolve(press({ key: 't', ctrlKey: true }), env({ overrides: rebound }))).toBe(
      'tabs.pinTab'
    )
  })

  it('resolves a collision in favor of the rebound command, even one earlier in the table', () => {
    // nav.newNote comes first in the table and owns ⌘N by default.
    const rebound = { 'tabs.closeTab': { key: 'n', modifiers: { meta: true } } }
    expect(resolve(press({ key: 'n', ctrlKey: true }), env({ overrides: rebound }))).toBe(
      'tabs.closeTab'
    )
  })

  it('falls back to the default owner when the rebound command is unavailable', () => {
    const rebound = { 'tabs.pinTab': { key: 't', modifiers: { meta: true } } }
    const noPin = env({ overrides: rebound, isAvailable: (id) => id !== 'tabs.pinTab' })
    expect(resolve(press({ key: 't', ctrlKey: true }), noPin)).toBe('tabs.newTab')
  })
})

describe('resolveChord: ⌘P belongs to the commands palette unless the user took it', () => {
  it('lets a user who bound ⌘P to another command keep it', () => {
    // Before the commands palette, ⌘P opened search; a user may have rebound it since.
    const rebound = { 'tabs.pinTab': { key: 'p', modifiers: { meta: true } } }
    expect(resolve(press({ key: 'p', ctrlKey: true }), env({ overrides: rebound }))).toBe(
      'tabs.pinTab'
    )
  })

  it('moves the commands palette to the key the user picked, and frees ⌘P', () => {
    const rebound = { 'nav.commands': { key: 'j', modifiers: { meta: true, shift: true } } }
    const chosen = press({ key: 'J', ctrlKey: true, shiftKey: true })
    expect(resolve(chosen, env({ overrides: rebound }))).toBe('nav.commands')
    expect(resolve(press({ key: 'p', ctrlKey: true }), env({ overrides: rebound }))).toBeNull()
  })

  it('no longer reaches search from ⌘P', () => {
    expect(resolve(press({ key: 'p', ctrlKey: true }), env())).not.toBe('nav.search')
  })
})

describe('resolveChord: platform bindings and AltGr', () => {
  const nextVaultMac = { key: 'ArrowRight', metaKey: true, ctrlKey: true }
  const nextVaultOther = { key: 'ArrowRight', ctrlKey: true, altKey: true }

  it('pages vaults with ⌃⌘→ on macOS and not with the other platforms chord', () => {
    expect(resolve(press(nextVaultMac), env({ isMac: true }))).toBe('nav.nextVault')
    expect(resolve(press(nextVaultOther), env({ isMac: true }))).toBeNull()
  })

  it('pages vaults with Ctrl+Alt+→ elsewhere and not with the macOS chord', () => {
    expect(resolve(press(nextVaultOther), env())).toBe('nav.nextVault')
    expect(resolve(press(nextVaultMac), env())).toBeNull()
  })

  it('does not page vaults for AltGr, which Windows reports as Ctrl+Alt', () => {
    const altGr = press(nextVaultOther)
    altGr.getModifierState = (key: string) => key === 'AltGraph'
    expect(resolve(altGr, env())).toBeNull()
  })

  it('reads ⌘ as the Meta key on macOS and as Ctrl elsewhere', () => {
    expect(resolve(press({ key: 'w', metaKey: true }), env({ isMac: true }))).toBe('tabs.closeTab')
    expect(resolve(press({ key: 'w', metaKey: true }), env())).toBeNull()
  })
})

describe('resolveChord: local command menus', () => {
  it('yields ⌘K to a surface that owns its own ⌘K menu, without touching other chords', () => {
    const inCalendar = env({ focusOwnsLocalCommandMenu: true })
    expect(resolve(press({ key: 'k', ctrlKey: true }), inCalendar)).toBeNull()
    expect(resolve(press({ key: 'k', ctrlKey: true }), env())).toBe('nav.search')
    expect(resolve(press({ key: 'w', ctrlKey: true }), inCalendar)).toBe('tabs.closeTab')
  })

  it('gives ⌘P to the commands palette everywhere, the local menu and fields included', () => {
    const inCalendar = env({ focusOwnsLocalCommandMenu: true, isInInput: true })
    expect(resolve(press({ key: 'p', ctrlKey: true }), inCalendar)).toBe('nav.commands')
    expect(resolve(press({ key: 'p', ctrlKey: true }), env())).toBe('nav.commands')
  })
})

describe("resolveChord: fold chords yield to the user's own shortcuts", () => {
  const folderOnFold: FolderNoteShortcut = {
    folder: 'Work',
    binding: { key: '1', modifiers: { meta: true, alt: true } }
  }
  const chord = press({ key: '1', code: 'Digit1', ctrlKey: true, altKey: true })

  it('fold.full keeps its chord until a folder shortcut takes it', () => {
    expect(resolve(chord, env())).toBe('fold.full')
    expect(resolve(chord, env({ folderShortcuts: [folderOnFold] }))).toBeNull()
  })

  it('a folder shortcut on another chord leaves fold alone', () => {
    const other = { ...folderOnFold, binding: { key: '9', modifiers: { meta: true, alt: true } } }
    expect(resolve(chord, env({ folderShortcuts: [other] }))).toBe('fold.full')
  })

  it('a rebound fold command beats the folder shortcut like any rebound command', () => {
    const rebound = { 'fold.full': { key: '1', modifiers: { meta: true, alt: true } } }
    expect(resolve(chord, env({ overrides: rebound, folderShortcuts: [folderOnFold] }))).toBe(
      'fold.full'
    )
  })

  it('other commands still beat a folder shortcut on a shared chord', () => {
    const close = { folder: 'Work', binding: { key: 'w', modifiers: { meta: true } } }
    expect(resolve(press({ key: 'w', ctrlKey: true }), env({ folderShortcuts: [close] }))).toBe(
      'tabs.closeTab'
    )
  })
})

describe('resolveFolderChord: a folder shortcut the user added', () => {
  const work: FolderNoteShortcut = {
    folder: 'Work',
    binding: { key: '1', modifiers: { meta: true, alt: true } }
  }
  const bare: FolderNoteShortcut = { folder: 'Bare', binding: { key: 'j', modifiers: {} } }
  const shortcuts = [work, bare]
  const chord = press({ key: '1', ctrlKey: true, altKey: true })

  it('names the folder whose chord was pressed', () => {
    expect(resolveFolderChord(chord, env(), shortcuts)).toBe('Work')
    expect(
      resolveFolderChord(press({ key: '2', ctrlKey: true, altKey: true }), env(), shortcuts)
    ).toBeNull()
  })

  it('stands down while Settings records a chord, hint mode or a vault switch holds the keyboard', () => {
    expect(resolveFolderChord(chord, env({ isRecording: true }), shortcuts)).toBeNull()
    expect(resolveFolderChord(chord, env({ isBlocked: true }), shortcuts)).toBeNull()
  })

  it('fires a ⌘/Ctrl chord in the editor and keeps a bare key out of fields', () => {
    expect(resolveFolderChord(chord, env({ isInInput: true }), shortcuts)).toBe('Work')
    const j = press({ key: 'j' })
    expect(resolveFolderChord(j, env(), shortcuts)).toBe('Bare')
    expect(resolveFolderChord(j, env({ isInInput: true }), shortcuts)).toBeNull()
  })
})
