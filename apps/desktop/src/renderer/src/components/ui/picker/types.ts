import { createContext, useContext } from 'react'

export type PickerMode = 'single' | 'multi'

export interface PickerContextValue {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: PickerMode
  value: string | string[] | null
  onValueChange: (value: string) => void
  searchQuery: string
  onSearchChange: (query: string) => void
  activePanel: string | null
  onPanelChange: (panel: string | null) => void
}

export const PickerContext = createContext<PickerContextValue | null>(null)

export function usePickerContext(): PickerContextValue {
  const ctx = useContext(PickerContext)
  if (!ctx) throw new Error('Picker compound components must be used within <Picker>')
  return ctx
}

export function usePickerContextOptional(): PickerContextValue | null {
  return useContext(PickerContext)
}

export type PickerIndicator = 'check' | 'checkbox' | 'dot' | 'none'
