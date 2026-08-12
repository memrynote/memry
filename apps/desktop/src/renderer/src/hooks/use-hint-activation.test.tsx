import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, fireEvent, render } from '@testing-library/react'
import { memo, type ReactNode } from 'react'
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

  // ---------------------------------------------------------------------------
  // Regression guard for the listener/context stabilisation (issue #1101).
  // `routes` below must stay byte-identical before and after that change: it is
  // the proof that stabilising the capture-phase listener did not move a single
  // key between "hint mode swallows it" and "hint mode lets it through".
  // ---------------------------------------------------------------------------

  interface Routed {
    prevented: boolean
    reachedDocument: boolean
    isActive: boolean
    typedChars: string
    inputFocused: boolean
  }

  const keydownCalls = (spy: ReturnType<typeof vi.spyOn>): number =>
    spy.mock.calls.filter((call) => call[0] === 'keydown').length

  it('routes every key to the same outcome, active and inactive', () => {
    const tags = addButton('Tags')
    addButton('Tasks')
    const tagsClick = vi.spyOn(tags, 'click')
    const input = document.createElement('input')
    document.body.appendChild(input)
    // Dispatch target below `window` so a capture-phase stopPropagation() is
    // observable: window capture runs first, document capture only if allowed.
    const surface = document.createElement('div')
    document.body.appendChild(surface)

    const { result } = renderHook(
      () => {
        useHintActivation()
        return useHintModeContext()
      },
      { wrapper }
    )

    const routes: Record<string, Routed> = {}
    const route = (name: string, init: Record<string, unknown>): void => {
      let reachedDocument = false
      const probe = (): void => {
        reachedDocument = true
      }
      document.addEventListener('keydown', probe, true)
      const notPrevented = fireEvent.keyDown(surface, init)
      document.removeEventListener('keydown', probe, true)
      routes[name] = {
        prevented: !notPrevented,
        reachedDocument,
        isActive: result.current.state.isActive,
        typedChars: result.current.state.typedChars,
        inputFocused: document.activeElement === input
      }
    }

    // --- hint mode inactive -------------------------------------------------
    route('composing f', { key: 'f', code: 'KeyF', isComposing: true })
    route('ime f (keyCode 229)', { key: 'f', code: 'KeyF', keyCode: 229 })
    route('meta+f', { key: 'f', code: 'KeyF', metaKey: true })
    route('ctrl+f', { key: 'f', code: 'KeyF', ctrlKey: true })
    route('shift+f', { key: 'F', code: 'KeyF', shiftKey: true })
    route('plain a', { key: 'a', code: 'KeyA' })
    route('escape, nothing focused', { key: 'Escape', code: 'Escape' })
    input.focus()
    route('plain f, input focused', { key: 'f', code: 'KeyF' })
    route('escape, input focused', { key: 'Escape', code: 'Escape' })
    route('plain f, input blurred', { key: 'f', code: 'KeyF' })

    // --- hint mode active ---------------------------------------------------
    route('active: no-match z', { key: 'z', code: 'KeyZ' })
    route('active: t narrows', { key: 't', code: 'KeyT' })
    route('active: backspace', { key: 'Backspace', code: 'Backspace' })
    route('active: meta+a', { key: 'a', code: 'KeyA', metaKey: true })
    route('active: ctrl+a', { key: 'a', code: 'KeyA', ctrlKey: true })
    route('active: alt+a', { key: 'a', code: 'KeyA', altKey: true })
    route('active: tab', { key: 'Tab', code: 'Tab' })
    route('active: escape deactivates', { key: 'Escape', code: 'Escape' })

    // --- alt+F re-entry, through to a unique match --------------------------
    route('alt+f re-activates', { key: 'F', code: 'KeyF', altKey: true })
    route('active: t narrows again', { key: 't', code: 'KeyT' })
    route('active: a picks TA', { key: 'a', code: 'KeyA' })

    expect(routes).toEqual({
      'composing f': {
        prevented: false,
        reachedDocument: true,
        isActive: false,
        typedChars: '',
        inputFocused: false
      },
      'ime f (keyCode 229)': {
        prevented: false,
        reachedDocument: true,
        isActive: false,
        typedChars: '',
        inputFocused: false
      },
      'meta+f': {
        prevented: false,
        reachedDocument: true,
        isActive: false,
        typedChars: '',
        inputFocused: false
      },
      'ctrl+f': {
        prevented: false,
        reachedDocument: true,
        isActive: false,
        typedChars: '',
        inputFocused: false
      },
      'shift+f': {
        prevented: false,
        reachedDocument: true,
        isActive: false,
        typedChars: '',
        inputFocused: false
      },
      'plain a': {
        prevented: false,
        reachedDocument: true,
        isActive: false,
        typedChars: '',
        inputFocused: false
      },
      'escape, nothing focused': {
        prevented: false,
        reachedDocument: true,
        isActive: false,
        typedChars: '',
        inputFocused: false
      },
      'plain f, input focused': {
        prevented: false,
        reachedDocument: true,
        isActive: false,
        typedChars: '',
        inputFocused: true
      },
      'escape, input focused': {
        prevented: false,
        reachedDocument: true,
        isActive: false,
        typedChars: '',
        inputFocused: false
      },
      'plain f, input blurred': {
        prevented: true,
        reachedDocument: false,
        isActive: true,
        typedChars: '',
        inputFocused: false
      },
      'active: no-match z': {
        prevented: true,
        reachedDocument: false,
        isActive: true,
        typedChars: '',
        inputFocused: false
      },
      'active: t narrows': {
        prevented: true,
        reachedDocument: false,
        isActive: true,
        typedChars: 'T',
        inputFocused: false
      },
      'active: backspace': {
        prevented: true,
        reachedDocument: false,
        isActive: true,
        typedChars: '',
        inputFocused: false
      },
      'active: meta+a': {
        prevented: false,
        reachedDocument: true,
        isActive: true,
        typedChars: '',
        inputFocused: false
      },
      'active: ctrl+a': {
        prevented: false,
        reachedDocument: true,
        isActive: true,
        typedChars: '',
        inputFocused: false
      },
      'active: alt+a': {
        prevented: false,
        reachedDocument: true,
        isActive: true,
        typedChars: '',
        inputFocused: false
      },
      'active: tab': {
        prevented: false,
        reachedDocument: true,
        isActive: true,
        typedChars: '',
        inputFocused: false
      },
      'active: escape deactivates': {
        prevented: true,
        reachedDocument: false,
        isActive: false,
        typedChars: '',
        inputFocused: false
      },
      'alt+f re-activates': {
        prevented: true,
        reachedDocument: false,
        isActive: true,
        typedChars: '',
        inputFocused: false
      },
      'active: t narrows again': {
        prevented: true,
        reachedDocument: false,
        isActive: true,
        typedChars: 'T',
        inputFocused: false
      },
      'active: a picks TA': {
        prevented: true,
        reachedDocument: false,
        isActive: false,
        typedChars: '',
        inputFocused: false
      }
    } satisfies Record<string, Routed>)

    expect(tagsClick).toHaveBeenCalledOnce()
  })

  it('binds the capture-phase keydown listener once for a whole hint session', () => {
    addButton('Tags')
    addButton('Tasks')

    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    try {
      const { result, unmount } = renderHook(
        () => {
          useHintActivation()
          return useHintModeContext()
        },
        { wrapper }
      )

      expect(keydownCalls(addSpy)).toBe(1)

      fireEvent.keyDown(window, { key: 'F', code: 'KeyF', altKey: true })
      fireEvent.keyDown(window, { key: 't' })
      fireEvent.keyDown(window, { key: 'Backspace' })
      fireEvent.keyDown(window, { key: 't' })
      fireEvent.keyDown(window, { key: 'Escape' })

      expect(result.current.state.isActive).toBe(false)
      // Before the fix this was 6 adds / 5 removes: every state change rebuilt
      // `typeChar`/`activate`, which were effect deps.
      expect(keydownCalls(addSpy)).toBe(1)
      expect(keydownCalls(removeSpy)).toBe(0)

      unmount()
      expect(keydownCalls(removeSpy)).toBe(1)
    } finally {
      addSpy.mockRestore()
      removeSpy.mockRestore()
    }
  })

  it('keeps the context value referentially stable across provider re-renders', () => {
    let consumerRenders = 0

    const Consumer = memo(function Consumer(): null {
      useHintModeContext()
      consumerRenders += 1
      return null
    })

    const Host = ({ tick }: { tick: number }): React.JSX.Element => (
      <HintModeProvider>
        <span>{tick}</span>
        <Consumer />
      </HintModeProvider>
    )

    const { rerender } = render(<Host tick={0} />)
    expect(consumerRenders).toBe(1)

    // Provider re-renders (new children), hint state untouched. Before the fix
    // the provider handed out a fresh value object here and every consumer
    // re-rendered with it.
    rerender(<Host tick={1} />)
    expect(consumerRenders).toBe(1)
  })
})
