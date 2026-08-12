import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act, render, renderHook } from '@testing-library/react'
import { memo } from 'react'
import {
  HintModeProvider,
  useHintModeActions,
  useHintModeContext,
  useHintModeState,
  type HintModeActions
} from '@/contexts/hint-mode'

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

describe('hint mode state/action contexts', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('keeps actions-only consumers out of the hint keystroke render path', () => {
    addButton('Tags')
    addButton('Tasks')

    let actionsRenders = 0
    let stateRenders = 0
    const actionsSeen: HintModeActions[] = []

    const ActionsOnly = memo(function ActionsOnly(): null {
      actionsSeen.push(useHintModeActions())
      actionsRenders += 1
      return null
    })

    const StateOnly = memo(function StateOnly(): null {
      useHintModeState()
      stateRenders += 1
      return null
    })

    render(
      <HintModeProvider>
        <ActionsOnly />
        <StateOnly />
      </HintModeProvider>
    )

    expect(actionsRenders).toBe(1)
    expect(stateRenders).toBe(1)

    const actions = actionsSeen[0]

    act(() => actions.activate())
    expect(stateRenders).toBe(2)
    expect(actionsRenders).toBe(1)

    act(() => actions.typeChar('T'))
    expect(stateRenders).toBe(3)
    expect(actionsRenders).toBe(1)

    act(() => actions.backspace())
    expect(stateRenders).toBe(4)
    expect(actionsRenders).toBe(1)

    act(() => actions.deactivate())
    expect(stateRenders).toBe(5)
    expect(actionsRenders).toBe(1)

    // Same bundle throughout: this identity is what lets the global keydown
    // listener bind once instead of per keystroke.
    expect(actionsSeen).toHaveLength(1)
  })

  it('exposes stable action identities while the state object changes', () => {
    addButton('Tags')
    addButton('Tasks')

    const { result } = renderHook(
      () => ({ state: useHintModeState(), actions: useHintModeActions() }),
      { wrapper: HintModeProvider }
    )

    const firstState = result.current.state
    const firstActions = result.current.actions

    act(() => result.current.actions.activate())
    expect(result.current.state).not.toBe(firstState)
    expect(result.current.actions).toBe(firstActions)
    expect(result.current.actions.activate).toBe(firstActions.activate)
    expect(result.current.actions.typeChar).toBe(firstActions.typeChar)
    expect(result.current.actions.backspace).toBe(firstActions.backspace)
    expect(result.current.actions.deactivate).toBe(firstActions.deactivate)

    const activeState = result.current.state
    act(() => result.current.actions.typeChar('T'))
    expect(result.current.state).not.toBe(activeState)
    expect(result.current.actions).toBe(firstActions)
  })

  it('composes useHintModeContext from both contexts', () => {
    addButton('Tags')
    addButton('Tasks')

    const { result, rerender } = renderHook(() => useHintModeContext(), {
      wrapper: HintModeProvider
    })

    const first = result.current
    rerender()
    expect(result.current).toBe(first)

    act(() => result.current.activate())
    expect(result.current).not.toBe(first)
    expect(result.current.state.isActive).toBe(true)
    expect(result.current.activate).toBe(first.activate)
  })

  it('throws when the hooks are used outside the provider', () => {
    expect(() => renderHook(() => useHintModeState())).toThrow(
      'useHintModeState must be inside HintModeProvider'
    )
    expect(() => renderHook(() => useHintModeActions())).toThrow(
      'useHintModeActions must be inside HintModeProvider'
    )
    expect(() => renderHook(() => useHintModeContext())).toThrow(
      'useHintModeState must be inside HintModeProvider'
    )
  })
})
