import { useEffect, useRef, useState } from 'react'
import { getI18n } from 'react-i18next'
import { GOOGLE_CALENDAR_PROVIDER } from '@memry/contracts/calendar-api'

import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('AgentAccessConsent')

export interface AgentAccessConsentState {
  /** The provider the open prompt asks about, or null when nothing is asked. */
  promptProvider: string | null
  isPromptOpen: boolean
  isSaving: boolean
  error: string | null
  decide: (granted: boolean) => Promise<void>
}

// Google keeps its historical settings channels, so the stored answer and the
// read path for existing installs are exactly what they were.
async function readConsent(provider: string): Promise<boolean | null | undefined> {
  if (provider === GOOGLE_CALENDAR_PROVIDER) {
    return (await window.api.settings.getCalendarGoogleSettings()).agentReadEventsConsent
  }
  const settings = await window.api.settings.getCalendarProviderSettings({ provider })
  return settings?.agentReadEventsConsent
}

async function writeConsent(
  provider: string,
  granted: boolean
): Promise<{ success: boolean; error?: string }> {
  if (provider === GOOGLE_CALENDAR_PROVIDER) {
    return await window.api.settings.setCalendarGoogleSettings({ agentReadEventsConsent: granted })
  }
  return await window.api.settings.setCalendarProviderSettings({
    provider,
    updates: { agentReadEventsConsent: granted }
  })
}

/**
 * No provider's external events reach the agent until the user answers for
 * that provider (#1394). Asks once per provider, the first time someone with
 * selected calendars from it opens the calendar. Google's Workspace Limited Use
 * prompt is one instance; an ICS-only install is asked about its feeds.
 *
 * Only a stored answer closes the question — `null` means "not asked yet", which
 * the agent read path treats as a no. That is why declining stores `false`
 * rather than just dismissing: a dismissal would ask again on the next visit.
 */
export function useAgentAccessConsent(providerIds: string[]): AgentAccessConsentState {
  const [pending, setPending] = useState<string[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const checkedRef = useRef(new Set<string>())
  const providerKey = providerIds.join('\u0000')

  useEffect(() => {
    const unchecked = providerKey
      .split('\u0000')
      .filter((provider) => provider && !checkedRef.current.has(provider))
    if (unchecked.length === 0) return
    for (const provider of unchecked) checkedRef.current.add(provider)

    let cancelled = false
    void (async () => {
      for (const provider of unchecked) {
        try {
          const consent = await readConsent(provider)
          if (cancelled) return
          if (consent === null) {
            setPending((current) => (current.includes(provider) ? current : [...current, provider]))
          }
        } catch (cause) {
          log.error('Failed to read calendar agent access setting', { provider, cause })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [providerKey])

  const promptProvider = pending[0] ?? null

  const decide = async (granted: boolean): Promise<void> => {
    if (!promptProvider) return
    setIsSaving(true)
    setError(null)
    try {
      const result = await writeConsent(promptProvider, granted)
      // No message when the IPC gave no reason: extractErrorMessage falls back to
      // the translated string rather than surfacing an empty or raw error.
      if (!result.success) throw new Error(result.error)
      setPending((current) => current.filter((provider) => provider !== promptProvider))
    } catch (cause) {
      const t = getI18n().getFixedT(null, 'calendar')
      setError(extractErrorMessage(cause, t('agent-access-dialog.save-error')))
    } finally {
      setIsSaving(false)
    }
  }

  return { promptProvider, isPromptOpen: promptProvider !== null, isSaving, error, decide }
}
