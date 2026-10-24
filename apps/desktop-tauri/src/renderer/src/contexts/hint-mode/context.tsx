import {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  useCallback,
  useEffect,
  type ReactNode
} from 'react'
import type { HintModeState, HintModeActions, HintModeContextType } from './types'
import { scanClickableElements } from '@/lib/dom-scanner'
import { assignLabels } from '@/lib/label-assigner'
import { hintModeActiveRef } from './active-ref'

const INITIAL_STATE: HintModeState = {
  isActive: false,
  hints: [],
  typedChars: ''
}

// State and actions live in separate contexts: the state object changes on every
// typed hint character, the action bundle never does. Consumers that only need
// the actions (the global keydown listener) stay out of that render path.
const HintModeStateContext = createContext<HintModeState | null>(null)
const HintModeActionsContext = createContext<HintModeActions | null>(null)

export const HintModeProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [state, setState] = useState<HintModeState>(INITIAL_STATE)

  // Latest committed state, read inside the actions so each one keeps a stable
  // identity across renders (same pattern as use-keyboard-shortcuts-base.ts).
  // Synced in an effect, not during render, so the actions observe exactly the
  // value the previous closures would have captured.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const deactivate = useCallback(() => {
    hintModeActiveRef.current = false
    setState(INITIAL_STATE)
  }, [])

  const activate = useCallback(() => {
    if (stateRef.current.isActive) {
      deactivate()
      return
    }

    const elements = scanClickableElements()
    if (elements.length === 0) return

    const hints = assignLabels(elements)
    hintModeActiveRef.current = true
    setState({ isActive: true, hints, typedChars: '' })
  }, [deactivate])

  const typeChar = useCallback(
    (char: string) => {
      const upper = char.toUpperCase()
      const next = stateRef.current.typedChars + upper
      const matching = stateRef.current.hints.filter((h) => h.label.startsWith(next))

      if (matching.length === 0) return

      if (matching.length === 1 && matching[0].label === next) {
        const target = matching[0].element
        target.click()
        if (document.contains(target)) target.focus()
        deactivate()
        return
      }

      setState((prev) => ({ ...prev, typedChars: next }))
    },
    [deactivate]
  )

  const backspace = useCallback(() => {
    setState((prev) => ({
      ...prev,
      typedChars: prev.typedChars.slice(0, -1)
    }))
  }, [])

  useEffect(() => {
    return () => {
      hintModeActiveRef.current = false
    }
  }, [])

  const actions = useMemo<HintModeActions>(
    () => ({ activate, deactivate, typeChar, backspace }),
    [activate, deactivate, typeChar, backspace]
  )

  return (
    <HintModeActionsContext.Provider value={actions}>
      <HintModeStateContext.Provider value={state}>{children}</HintModeStateContext.Provider>
    </HintModeActionsContext.Provider>
  )
}

export const useHintModeState = (): HintModeState => {
  const state = useContext(HintModeStateContext)
  if (!state) throw new Error('useHintModeState must be inside HintModeProvider')
  return state
}

export const useHintModeActions = (): HintModeActions => {
  const actions = useContext(HintModeActionsContext)
  if (!actions) throw new Error('useHintModeActions must be inside HintModeProvider')
  return actions
}

export const useHintModeContext = (): HintModeContextType => {
  const state = useHintModeState()
  const actions = useHintModeActions()
  return useMemo(() => ({ state, ...actions }), [state, actions])
}
