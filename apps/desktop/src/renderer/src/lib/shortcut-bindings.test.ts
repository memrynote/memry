import { afterEach, describe, expect, it } from 'vitest'
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
})
