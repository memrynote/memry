import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, fireEvent } from '@testing-library/react'
import { type ReactNode } from 'react'
import { HintModeProvider, useHintModeContext } from '@/contexts/hint-mode'
import { useHintActivation } from '@/hooks/use-hint-activation'

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

  it('useHintActivation starts hint mode from plain F and ignores text inputs', () => {
    addButton('Inbox')
    const input = document.createElement('input')
    document.body.appendChild(input)

    const { result } = renderHook(
      () => {
        useHintActivation()
        return useHintModeContext()
      },
      { wrapper }
    )

    input.focus()
    fireEvent.keyDown(window, { key: 'f', code: 'KeyF' })
    expect(result.current.state.isActive).toBe(false)

    input.blur()
    fireEvent.keyDown(window, { key: 'f', code: 'KeyF' })
    expect(result.current.state.isActive).toBe(true)
  })

  it('useHintActivation handles active-mode typing, backspace, escape, composition, and input blur', () => {
    const btn = addButton('Inbox')
    addButton('Ideas')
    const clickSpy = vi.spyOn(btn, 'click')
    const input = document.createElement('input')
    document.body.appendChild(input)

    const { result } = renderHook(
      () => {
        useHintActivation()
        return useHintModeContext()
      },
      { wrapper }
    )

    fireEvent.keyDown(window, { key: 'f', code: 'KeyF', isComposing: true })
    expect(result.current.state.isActive).toBe(false)

    fireEvent.keyDown(window, { key: 'F', code: 'KeyF', altKey: true })
    expect(result.current.state.isActive).toBe(true)

    fireEvent.keyDown(window, { key: 'x' })
    expect(result.current.state.typedChars).toBe('')
    fireEvent.keyDown(window, { key: 'I' })
    expect(result.current.state.typedChars).toBe('I')
    expect(clickSpy).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Backspace' })
    expect(result.current.state.typedChars).toBe('')

    fireEvent.keyDown(window, { key: 'I' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(result.current.state.isActive).toBe(false)

    fireEvent.keyDown(window, { key: 'F', code: 'KeyF', altKey: true })
    fireEvent.keyDown(window, { key: 'I' })
    fireEvent.keyDown(window, { key: 'N' })
    expect(clickSpy).toHaveBeenCalledOnce()
    expect(result.current.state.isActive).toBe(false)

    input.focus()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.activeElement).not.toBe(input)
  })
})
