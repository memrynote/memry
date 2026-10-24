/**
 * `nav.switchVault` (⌘⇧O / Ctrl+Shift+O), end to end through the keyboard
 * dispatcher. Paging (`nav.nextVault`/`nav.prevVault`) is covered with the
 * pager itself in `vault-pager.test.tsx`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const mocks = vi.hoisted(() => ({ openSwitcher: vi.fn() }))

vi.mock('@/lib/vault-switcher-open', () => ({ requestVaultSwitcherOpen: mocks.openSwitcher }))

const setPlatform = (platform: string): void => {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
}

/** `isMac` is frozen when the shortcut base first loads, so each platform loads its own graph. */
async function loadForPlatform(platform: string) {
  setPlatform(platform)
  vi.resetModules()
  const commands = await import('@/commands')
  const bindings = await import('@/lib/shortcut-bindings')
  const switchState = await import('@/lib/vault-switch-state')
  const { useVaultPagerCommands } = await import('./use-vault-pager-commands')
  const mount = (paused = false): void => {
    renderHook(() => {
      commands.useCommandDispatcher()
      useVaultPagerCommands(paused)
    })
  }
  return { mount, bindings, switchState }
}

/** Returns false when the dispatcher consumed the key. */
const press = (target: EventTarget, init: KeyboardEventInit): boolean =>
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

describe('nav.switchVault', () => {
  const originalPlatform = navigator.platform

  beforeEach(() => {
    document.body.innerHTML = ''
    mocks.openSwitcher.mockClear()
  })

  afterEach(() => {
    setPlatform(originalPlatform)
    vi.resetModules()
  })

  it('opens the switcher on ⌘⇧O on macOS and consumes the key', async () => {
    const { mount } = await loadForPlatform('MacIntel')
    mount()

    const notConsumed = press(window, { key: 'o', metaKey: true, shiftKey: true })

    expect(mocks.openSwitcher).toHaveBeenCalledTimes(1)
    expect(notConsumed).toBe(false)
  })

  it('opens the switcher on Ctrl+Shift+O off macOS', async () => {
    const { mount } = await loadForPlatform('Win32')
    mount()

    press(window, { key: 'o', ctrlKey: true, shiftKey: true })

    expect(mocks.openSwitcher).toHaveBeenCalledTimes(1)
  })

  it('stays out of the way while a vault switch is in flight, then works again', async () => {
    const { mount, switchState } = await loadForPlatform('MacIntel')
    mount()

    switchState.beginVaultSwitch({ path: '/b', name: 'B' }, null)
    const notConsumed = press(window, { key: 'o', metaKey: true, shiftKey: true })

    expect(mocks.openSwitcher).not.toHaveBeenCalled()
    // Nothing ran, so the chord passes through like any unhandled key.
    expect(notConsumed).toBe(true)

    switchState.endVaultSwitch(true)
    press(window, { key: 'o', metaKey: true, shiftKey: true })
    expect(mocks.openSwitcher).toHaveBeenCalledTimes(1)
  })

  it('ignores the unmodified O that the inbox uses', async () => {
    const { mount } = await loadForPlatform('MacIntel')
    mount()

    press(window, { key: 'o' })
    press(window, { key: 'o', metaKey: true })

    expect(mocks.openSwitcher).not.toHaveBeenCalled()
  })

  it.each([
    ['input', () => document.createElement('input')],
    ['textarea', () => document.createElement('textarea')],
    ['select', () => document.createElement('select')]
  ])('fires while a %s owns focus, since ⌘⇧O types nothing', async (_name, create) => {
    const { mount } = await loadForPlatform('MacIntel')
    mount()

    const element = create()
    document.body.appendChild(element)
    element.focus()
    press(element, { key: 'o', metaKey: true, shiftKey: true })

    expect(mocks.openSwitcher).toHaveBeenCalledTimes(1)
  })

  it('keeps a rebind without ⌘/Ctrl out of text fields, where it would eat typing', async () => {
    const { mount, bindings } = await loadForPlatform('MacIntel')
    bindings.__setShortcutOverridesForTests({ 'nav.switchVault': { key: 'F2', modifiers: {} } })
    mount()

    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    press(input, { key: 'F2' })
    expect(mocks.openSwitcher).not.toHaveBeenCalled()

    input.blur()
    press(window, { key: 'F2' })
    expect(mocks.openSwitcher).toHaveBeenCalledTimes(1)
    bindings.__setShortcutOverridesForTests({})
  })

  it('fires while a rich-text editor owns focus, since no editor command collides', async () => {
    const { mount } = await loadForPlatform('MacIntel')
    mount()

    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    editor.tabIndex = 0
    document.body.appendChild(editor)
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editor, 'isContentEditable', { value: true, configurable: true })
    editor.focus()
    press(editor, { key: 'o', metaKey: true, shiftKey: true })

    expect(mocks.openSwitcher).toHaveBeenCalledTimes(1)
  })

  it('uses the default when saved settings carry no binding for it', async () => {
    const { mount, bindings } = await loadForPlatform('MacIntel')
    bindings.__setShortcutOverridesForTests({
      'nav.search': { key: 'j', modifiers: { meta: true } }
    })
    mount()

    press(window, { key: 'o', metaKey: true, shiftKey: true })

    expect(mocks.openSwitcher).toHaveBeenCalledTimes(1)
    bindings.__setShortcutOverridesForTests({})
  })

  it('honours a user rebind and frees the default chord', async () => {
    const { mount, bindings } = await loadForPlatform('MacIntel')
    bindings.__setShortcutOverridesForTests({
      'nav.switchVault': { key: 'y', modifiers: { meta: true, alt: true } }
    })
    mount()

    press(window, { key: 'o', metaKey: true, shiftKey: true })
    expect(mocks.openSwitcher).not.toHaveBeenCalled()

    press(window, { key: 'y', metaKey: true, altKey: true })
    expect(mocks.openSwitcher).toHaveBeenCalledTimes(1)
    bindings.__setShortcutOverridesForTests({})
  })

  it('still opens while paging is paused for Settings', async () => {
    const { mount } = await loadForPlatform('MacIntel')
    mount(true)

    press(window, { key: 'o', metaKey: true, shiftKey: true })

    expect(mocks.openSwitcher).toHaveBeenCalledTimes(1)
  })
})
