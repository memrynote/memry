import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useModifierHeld } from './use-modifier-held'

vi.mock('@/contexts/hint-mode', () => ({
  hintModeActiveRef: { current: false }
}))

// Set both ctrlKey and metaKey so the assertions hold regardless of platform.
const modInit = { ctrlKey: true, metaKey: true } as const

describe('useModifierHeld', () => {
  it('is true while the modifier is held and false after release', () => {
    const { result } = renderHook(() => useModifierHeld())
    expect(result.current).toBe(false)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', modInit))
    })
    expect(result.current).toBe(true)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { ctrlKey: false, metaKey: false }))
    })
    expect(result.current).toBe(false)
  })

  it('resets to false on window blur', () => {
    const { result } = renderHook(() => useModifierHeld())

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', modInit))
    })
    expect(result.current).toBe(true)

    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(result.current).toBe(false)
  })

  it('activates even while a text input is focused (works on inbox/tasks/editor)', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    const { result } = renderHook(() => useModifierHeld())

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { ...modInit, bubbles: true }))
    })
    expect(result.current).toBe(true)

    input.remove()
  })
})
