import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode
} from 'react'
import type { HintModeState, HintModeContextType } from './types'
import { scanClickableElements } from '@/lib/dom-scanner'
import { assignLabels } from '@/lib/label-assigner'

export const hintModeActiveRef: { current: boolean } = { current: false }

const INITIAL_STATE: HintModeState = {
  isActive: false,
  hints: [],
  typedChars: ''
}

const HintModeContext = createContext<HintModeContextType | null>(null)

export const HintModeProvider = ({ children }: { children: ReactNode }): React.JSX.Element => {
  const [state, setState] = useState<HintModeState>(INITIAL_STATE)
  const stateRef = useRef(state)
  stateRef.current = state

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

  const value: HintModeContextType = { state, activate, deactivate, typeChar, backspace }

  return <HintModeContext.Provider value={value}>{children}</HintModeContext.Provider>
}

export const useHintModeContext = (): HintModeContextType => {
  const ctx = useContext(HintModeContext)
  if (!ctx) throw new Error('useHintModeContext must be inside HintModeProvider')
  return ctx
}
