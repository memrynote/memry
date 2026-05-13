import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { createLogger } from '@/lib/logger'

const log = createLogger('Context:AISettings')

interface AISettingsContextValue {
  enabled: boolean
  isLoading: boolean
  reload: () => Promise<void>
}

const FALLBACK_AI_SETTINGS: AISettingsContextValue = {
  enabled: true,
  isLoading: false,
  reload: async () => {}
}

const AISettingsContext = createContext<AISettingsContextValue | null>(null)

function hasAISettingsApi(): boolean {
  return typeof window !== 'undefined' && typeof window.api?.settings?.getAISettings === 'function'
}

export function AISettingsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [enabled, setEnabled] = useState(false)
  const [isLoading, setIsLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!hasAISettingsApi()) {
      setEnabled(true)
      setIsLoading(false)
      return
    }

    try {
      const settings = await window.api.settings.getAISettings()
      setEnabled(settings.enabled)
    } catch (error) {
      log.error('Failed to load AI settings', error)
      setEnabled(false)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    let mounted = true

    void (async () => {
      if (!hasAISettingsApi()) {
        if (mounted) {
          setEnabled(true)
          setIsLoading(false)
        }
        return
      }

      try {
        const settings = await window.api.settings.getAISettings()
        if (mounted) setEnabled(settings.enabled)
      } catch (error) {
        log.error('Failed to load AI settings', error)
        if (mounted) setEnabled(false)
      } finally {
        if (mounted) setIsLoading(false)
      }
    })()

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.api?.onSettingsChanged !== 'function') {
      return
    }

    return window.api.onSettingsChanged((event) => {
      if (event.key !== 'ai') return
      const value = event.value as Partial<{ enabled: boolean }>
      if (typeof value.enabled === 'boolean') {
        setEnabled(value.enabled)
        setIsLoading(false)
      }
    })
  }, [])

  const value = useMemo<AISettingsContextValue>(
    () => ({ enabled, isLoading, reload }),
    [enabled, isLoading, reload]
  )

  return <AISettingsContext.Provider value={value}>{children}</AISettingsContext.Provider>
}

export function useAISettingsContext(): AISettingsContextValue {
  return useContext(AISettingsContext) ?? FALLBACK_AI_SETTINGS
}
