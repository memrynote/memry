import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  __setShortcutOverridesForTests,
  getShortcutBinding,
  useShortcutBinding
} from './shortcut-bindings'

describe('shortcut bindings store', () => {
  afterEach(() => {
    __setShortcutOverridesForTests({})
  })

  it('falls back to the registry default when nothing is overridden', () => {
    expect(getShortcutBinding('view.toggleSidebar')).toEqual({
      key: 'b',
      modifiers: { meta: true }
    })
  })

  it('returns the user override instead of the default', () => {
    __setShortcutOverridesForTests({
      'view.toggleSidebar': { key: 'b', modifiers: { alt: true } }
    })

    expect(getShortcutBinding('view.toggleSidebar')).toEqual({
      key: 'b',
      modifiers: { alt: true }
    })
  })

  it('returns a stable reference so subscribers do not re-render in a loop', () => {
    expect(getShortcutBinding('nav.settings')).toBe(getShortcutBinding('nav.settings'))
  })

  it('pushes a rebind to subscribers without a reload', () => {
    const { result } = renderHook(() => useShortcutBinding('nav.search'))

    expect(result.current).toEqual({ key: 'k', modifiers: { meta: true } })

    act(() => {
      __setShortcutOverridesForTests({
        'nav.search': { key: 'j', modifiers: { meta: true, shift: true } }
      })
    })

    expect(result.current).toEqual({ key: 'j', modifiers: { meta: true, shift: true } })
  })

  it("reloads rebinds when a vault switch brings another vault's settings", async () => {
    vi.resetModules()
    let onVaultStatus: ((status: { isOpen: boolean; path: string | null }) => void) | null = null
    const vaultA = { overrides: { 'nav.search': { key: 'a', modifiers: { meta: true } } } }
    const getKeyboardSettings = vi
      .fn()
      .mockResolvedValueOnce(vaultA)
      .mockResolvedValueOnce(vaultA)
      .mockResolvedValue({ overrides: {} })
    ;(window as unknown as { api: unknown }).api = {
      settings: { getKeyboardSettings },
      onSettingsChanged: vi.fn(() => vi.fn()),
      onVaultStatusChanged: vi.fn((cb: typeof onVaultStatus) => {
        onVaultStatus = cb
        return vi.fn()
      })
    }
    const fresh = await import('./shortcut-bindings')
    const { result } = renderHook(() => fresh.useShortcutBinding('nav.search'))

    await vi.waitFor(() => expect(result.current.key).toBe('a'))

    // The first status names the open vault; repeats (index progress) do not reload.
    act(() => onVaultStatus?.({ isOpen: true, path: '/vault-a' }))
    act(() => onVaultStatus?.({ isOpen: true, path: '/vault-a' }))
    await vi.waitFor(() => expect(getKeyboardSettings).toHaveBeenCalledTimes(2))
    expect(result.current.key).toBe('a')

    act(() => onVaultStatus?.({ isOpen: true, path: '/vault-b' }))
    await vi.waitFor(() => expect(result.current).toEqual({ key: 'k', modifiers: { meta: true } }))
    expect(getKeyboardSettings).toHaveBeenCalledTimes(3)
  })
})
