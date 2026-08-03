import { useEffect, useRef, useState } from 'react'
import { getI18n } from 'react-i18next'

import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('AgentAccessConsent')

export interface AgentAccessConsentState {
  isPromptOpen: boolean
  isSaving: boolean
  error: string | null
  decide: (granted: boolean) => Promise<void>
}

/**
 * Google Workspace Limited Use: asks once, the first time someone with imported
 * Google calendars opens the calendar, whether the agent may read those events.
 *
 * Only a stored answer closes the question — `null` means "not asked yet", which
 * the agent read path treats as a no. That is why declining stores `false`
 * rather than just dismissing: a dismissal would ask again on the next visit.
 */
export function useAgentAccessConsent(hasImportedSources: boolean): AgentAccessConsentState {
  const [isPromptOpen, setIsPromptOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const checkedRef = useRef(false)

  useEffect(() => {
    if (checkedRef.current) return
    if (!hasImportedSources) return
    checkedRef.current = true

    let cancelled = false
    void window.api.settings
      .getCalendarGoogleSettings()
      .then((settings) => {
        if (cancelled) return
        if (settings.agentReadEventsConsent === null) setIsPromptOpen(true)
      })
      .catch((cause) => {
        log.error('Failed to read Google Calendar agent access setting', cause)
      })

    return () => {
      cancelled = true
    }
  }, [hasImportedSources])

  const decide = async (granted: boolean): Promise<void> => {
    setIsSaving(true)
    setError(null)
    try {
      const result = await window.api.settings.setCalendarGoogleSettings({
        agentReadEventsConsent: granted
      })
      // No message when the IPC gave no reason: extractErrorMessage falls back to
      // the translated string rather than surfacing an empty or raw error.
      if (!result.success) throw new Error(result.error)
      setIsPromptOpen(false)
    } catch (cause) {
      const t = getI18n().getFixedT(null, 'calendar')
      setError(extractErrorMessage(cause, t('agent-access-dialog.save-error')))
    } finally {
      setIsSaving(false)
    }
  }

  return { isPromptOpen, isSaving, error, decide }
}
