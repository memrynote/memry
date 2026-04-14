import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { type ReactNode } from 'react'
import { HintModeProvider, useHintModeContext } from '@/contexts/hint-mode'

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <HintModeProvider>{children}</HintModeProvider>
)

const mockRect: DOMRect = {
  x: 10,
  y: 10,
  width: 100,
  height: 30,
  top: 10,
  left: 10,
  bottom: 40,
  right: 110,
  toJSON: () => ({})
} as DOMRect

const addButton = (text: string): HTMLButtonElement => {
  const btn = document.createElement('button')
  btn.textContent = text
  btn.getBoundingClientRect = () => mockRect
  Object.defineProperty(btn, 'offsetParent', { value: document.body, configurable: true })
  document.body.appendChild(btn)
  return btn
}

describe('HintModeProvider', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('activate scans DOM and assigns labels', () => {
    addButton('Inbox')
    addButton('Journal')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())

    expect(result.current.state.isActive).toBe(true)
    expect(result.current.state.hints).toHaveLength(2)
    expect(result.current.state.hints[0].label).toBe('I')
    expect(result.current.state.hints[1].label).toBe('J')
  })

  it('deactivate resets state', () => {
    addButton('Test')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    expect(result.current.state.isActive).toBe(true)

    act(() => result.current.deactivate())
    expect(result.current.state.isActive).toBe(false)
    expect(result.current.state.hints).toHaveLength(0)
  })

  it('typeChar narrows matches', () => {
    addButton('Tags')
    addButton('Tasks')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    expect(result.current.state.hints[0].label).toBe('TA')
    expect(result.current.state.hints[1].label).toBe('TS')

    act(() => result.current.typeChar('T'))
    expect(result.current.state.typedChars).toBe('T')
  })

  it('typeChar triggers click on unique match', () => {
    const btn = addButton('Inbox')
    const clickSpy = vi.spyOn(btn, 'click')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    act(() => result.current.typeChar('I'))

    expect(clickSpy).toHaveBeenCalledOnce()
    expect(result.current.state.isActive).toBe(false)
  })

  it('backspace removes last typed char', () => {
    addButton('Tags')
    addButton('Tasks')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    act(() => result.current.typeChar('T'))
    expect(result.current.state.typedChars).toBe('T')

    act(() => result.current.backspace())
    expect(result.current.state.typedChars).toBe('')
  })

  it('double activate toggles off', () => {
    addButton('Test')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    expect(result.current.state.isActive).toBe(true)

    act(() => result.current.activate())
    expect(result.current.state.isActive).toBe(false)
  })

  it('activate with no clickable elements is a no-op', () => {
    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    expect(result.current.state.isActive).toBe(false)
  })

  it('ignores non-matching typeChar', () => {
    addButton('Inbox')

    const { result } = renderHook(() => useHintModeContext(), { wrapper })

    act(() => result.current.activate())
    act(() => result.current.typeChar('Z'))

    expect(result.current.state.typedChars).toBe('')
    expect(result.current.state.isActive).toBe(true)
  })
})
