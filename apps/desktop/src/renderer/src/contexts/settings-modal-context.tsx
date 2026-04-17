import { createContext, useContext, useState, useCallback, useMemo } from 'react'

export type SettingsSection =
  | 'general'
  | 'editor'
  | 'templates'
  | 'journal'
  | 'tasks'
  | 'vault'
  | 'appearance'
  | 'ai'
  | 'integrations'
  | 'tags'
  | 'properties'
  | 'shortcuts'
  | 'account'

const DEFAULT_SECTION: SettingsSection = 'account'

interface SettingsModalContextValue {
  isOpen: boolean
  activeSection: SettingsSection
  setActiveSection: (section: SettingsSection) => void
  open: (section?: string) => void
  close: () => void
}

const SettingsModalContext = createContext<SettingsModalContextValue | null>(null)

export function SettingsModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeSection, setActiveSection] = useState<SettingsSection>(DEFAULT_SECTION)

  const open = useCallback((section?: string) => {
    setActiveSection((section as SettingsSection) ?? DEFAULT_SECTION)
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
  }, [])

  const value = useMemo<SettingsModalContextValue>(
    () => ({ isOpen, activeSection, setActiveSection, open, close }),
    [isOpen, activeSection, open, close]
  )

  return <SettingsModalContext.Provider value={value}>{children}</SettingsModalContext.Provider>
}

export function useSettingsModal(): SettingsModalContextValue {
  const context = useContext(SettingsModalContext)
  if (!context) {
    throw new Error('useSettingsModal must be used within a SettingsModalProvider')
  }
  return context
}
