import { createContext, useContext, useState, useCallback, useMemo } from 'react'
import { toSafeToken } from '@memry/contracts/telemetry-api'
import { trackTelemetry } from '@/lib/telemetry'

export type SettingsSection =
  | 'general'
  | 'editor'
  | 'templates'
  | 'journal'
  | 'tasks'
  | 'inbox'
  | 'calendar'
  | 'vault'
  | 'appearance'
  | 'ai'
  | 'agent-providers'
  | 'agent-mcp'
  | 'import'
  | 'tags'
  | 'properties'
  | 'shortcuts'
  | 'command-line'
  | 'account'
  | 'features'

export type SettingsFocusTarget = 'voice-local-model'

const DEFAULT_SECTION: SettingsSection = 'account'

interface SettingsModalContextValue {
  isOpen: boolean
  activeSection: SettingsSection
  focusTarget: SettingsFocusTarget | null
  focusRequestId: number
  setActiveSection: (section: SettingsSection) => void
  open: (section?: string) => void
  close: () => void
}

const SettingsModalContext = createContext<SettingsModalContextValue | null>(null)

function parseSettingsTarget(section?: string): {
  section: SettingsSection
  focusTarget: SettingsFocusTarget | null
} {
  if (section === 'ai:voice-local-model') {
    return { section: 'ai', focusTarget: 'voice-local-model' }
  }

  return { section: (section as SettingsSection) ?? DEFAULT_SECTION, focusTarget: null }
}

export function SettingsModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeSection, setActiveSectionState] = useState<SettingsSection>(DEFAULT_SECTION)
  const [focusTarget, setFocusTarget] = useState<SettingsFocusTarget | null>(null)
  const [focusRequestId, setFocusRequestId] = useState(0)

  const setActiveSection = useCallback((section: SettingsSection) => {
    setActiveSectionState(section)
    setFocusTarget(null)
  }, [])

  const open = useCallback((section?: string) => {
    const target = parseSettingsTarget(section)
    setActiveSectionState(target.section)
    setFocusTarget(target.focusTarget)
    if (target.focusTarget) {
      setFocusRequestId((id) => id + 1)
    }
    setIsOpen(true)
    // Settings is a modal, not a tab, so App's tab-driven page_viewed never
    // fires for it — emit here. Section names are a closed set of code tokens.
    void trackTelemetry('page_viewed', {
      surface: 'settings',
      action: 'viewed',
      objectType: toSafeToken(target.section, 'general')
    })
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
    setFocusTarget(null)
  }, [])

  const value = useMemo<SettingsModalContextValue>(
    () => ({ isOpen, activeSection, focusTarget, focusRequestId, setActiveSection, open, close }),
    [isOpen, activeSection, focusTarget, focusRequestId, setActiveSection, open, close]
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
