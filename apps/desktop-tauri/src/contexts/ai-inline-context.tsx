import { createContext, useContext, type ReactNode } from 'react'
import { useAIInline, type AIInlineState } from '@/hooks/use-ai-inline'

const AIInlineContext = createContext<AIInlineState | null>(null)

export function AIInlineProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const state = useAIInline()
  return <AIInlineContext.Provider value={state}>{children}</AIInlineContext.Provider>
}

export function useAIInlineContext(): AIInlineState {
  const ctx = useContext(AIInlineContext)
  if (!ctx) throw new Error('useAIInlineContext must be used within AIInlineProvider')
  return ctx
}
