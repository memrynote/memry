/**
 * AI Agent Context
 * Global state management for the AI agent panel visibility
 */

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react'

// ============================================================================
// TYPES
// ============================================================================

export interface AIAgentContextValue {
  /** Whether the AI agent panel is open */
  isOpen: boolean
  /** Toggle the AI agent panel */
  toggle: () => void
  /** Open the AI agent panel */
  open: () => void
  /** Close the AI agent panel */
  close: () => void
}

interface AIAgentProviderProps {
  children: ReactNode
  /** Default open state */
  defaultOpen?: boolean
}

// ============================================================================
// CONTEXT
// ============================================================================

const AIAgentContext = createContext<AIAgentContextValue | null>(null)

// ============================================================================
// HOOK
// ============================================================================

export const useAIAgent = (): AIAgentContextValue => {
  const context = useContext(AIAgentContext)
  if (!context) {
    throw new Error('useAIAgent must be used within an AIAgentProvider')
  }
  return context
}

// ============================================================================
// PROVIDER
// ============================================================================

export const AIAgentProvider = ({
  children,
  defaultOpen = false
}: AIAgentProviderProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev)
  }, [])

  const open = useCallback(() => {
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
  }, [])

  const value = useMemo<AIAgentContextValue>(
    () => ({
      isOpen,
      toggle,
      open,
      close
    }),
    [isOpen, toggle, open, close]
  )

  return <AIAgentContext.Provider value={value}>{children}</AIAgentContext.Provider>
}

export default AIAgentProvider
