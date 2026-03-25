import { createContext, useContext, useState, useCallback, useMemo } from 'react'

interface SettingsModalContextValue {
  isOpen: boolean
  open: (section?: string) => void
  close: () => void
}

const SettingsModalContext = createContext<SettingsModalContextValue | null>(null)

const SETTINGS_SECTION_KEY = 'memry_settings_section'

export function SettingsModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)

  const open = useCallback((section?: string) => {
    if (section) {
      localStorage.setItem(SETTINGS_SECTION_KEY, section)
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: SETTINGS_SECTION_KEY,
          newValue: section
        })
      )
    }
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
  }, [])

  const value = useMemo<SettingsModalContextValue>(
    () => ({ isOpen, open, close }),
    [isOpen, open, close]
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
