/**
 * Switch-vault shortcut (⌘⇧O / Ctrl+Shift+O)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const setPlatform = (platform: string): void => {
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
}

type Hook = typeof import('./use-switch-vault-shortcut')
type Bindings = typeof import('@/lib/shortcut-bindings')

async function loadForPlatform(platform: string): Promise<{ hook: Hook; bindings: Bindings }> {
  setPlatform(platform)
  vi.resetModules()
  const bindings = await import('@/lib/shortcut-bindings')
  const hook = await import('./use-switch-vault-shortcut')
  return { hook, bindings }
}

const press = (target: EventTarget, init: KeyboardEventInit): boolean =>
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

describe('useSwitchVaultShortcut', () => {
  const originalPlatform = navigator.platform

  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    setPlatform(originalPlatform)
    vi.resetModules()
  })

  it('fires on ⌘⇧O on macOS', async () => {
    const { hook } = await loadForPlatform('MacIntel')
    const onOpen = vi.fn()
    renderHook(() => hook.useSwitchVaultShortcut(onOpen))

    press(window, { key: 'o', metaKey: true, shiftKey: true })

    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('fires on Ctrl+Shift+O off macOS', async () => {
    const { hook } = await loadForPlatform('Win32')
    const onOpen = vi.fn()
    renderHook(() => hook.useSwitchVaultShortcut(onOpen))

    press(window, { key: 'o', ctrlKey: true, shiftKey: true })

    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('ignores the unmodified O that the inbox uses', async () => {
    const { hook } = await loadForPlatform('MacIntel')
    const onOpen = vi.fn()
    renderHook(() => hook.useSwitchVaultShortcut(onOpen))

    press(window, { key: 'o' })
    press(window, { key: 'o', metaKey: true })

    expect(onOpen).not.toHaveBeenCalled()
  })

  it.each([
    ['input', () => document.createElement('input')],
    ['textarea', () => document.createElement('textarea')],
    ['select', () => document.createElement('select')]
  ])('stays inert while a %s owns focus', async (_name, create) => {
    const { hook } = await loadForPlatform('MacIntel')
    const onOpen = vi.fn()
    renderHook(() => hook.useSwitchVaultShortcut(onOpen))

    const element = create()
    document.body.appendChild(element)
    element.focus()

    press(element, { key: 'o', metaKey: true, shiftKey: true })

    expect(onOpen).not.toHaveBeenCalled()
  })

  it('stays inert while a rich-text editor owns focus', async () => {
    const { hook } = await loadForPlatform('MacIntel')
    const onOpen = vi.fn()
    renderHook(() => hook.useSwitchVaultShortcut(onOpen))

    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    editor.tabIndex = 0
    document.body.appendChild(editor)
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(editor, 'isContentEditable', { value: true, configurable: true })
    editor.focus()

    press(editor, { key: 'o', metaKey: true, shiftKey: true })

    expect(onOpen).not.toHaveBeenCalled()
  })

  it('uses the registry default when older settings carry no binding for it', async () => {
    const { hook, bindings } = await loadForPlatform('MacIntel')
    // Settings written before this shortcut existed: overrides for other ids only.
    bindings.__setShortcutOverridesForTests({
      'nav.search': { key: 'j', modifiers: { meta: true } }
    })

    const onOpen = vi.fn()
    renderHook(() => hook.useSwitchVaultShortcut(onOpen))

    press(window, { key: 'o', metaKey: true, shiftKey: true })

    expect(onOpen).toHaveBeenCalledTimes(1)
    bindings.__setShortcutOverridesForTests({})
  })

  it('honours a user rebind', async () => {
    const { hook, bindings } = await loadForPlatform('MacIntel')
    bindings.__setShortcutOverridesForTests({
      'nav.switchVault': { key: 'y', modifiers: { meta: true, alt: true } }
    })

    const onOpen = vi.fn()
    renderHook(() => hook.useSwitchVaultShortcut(onOpen))

    press(window, { key: 'o', metaKey: true, shiftKey: true })
    expect(onOpen).not.toHaveBeenCalled()

    press(window, { key: 'y', metaKey: true, altKey: true })
    expect(onOpen).toHaveBeenCalledTimes(1)
    bindings.__setShortcutOverridesForTests({})
  })
})
