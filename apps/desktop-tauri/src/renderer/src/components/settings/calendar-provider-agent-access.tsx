import { useEffect, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { CalendarSwitchRow } from '@/components/settings/calendar-provider-row'

const log = createLogger('CalendarProviderAgentAccess')

export function providerSettingsQueryKey(providerId: string): readonly string[] {
  return ['calendar', providerId, 'settings'] as const
}

/**
 * Whether the AI agent may read this provider's events (#1394). Each provider
 * answers for itself; Google keeps its own switch in its section.
 */
export function ProviderAgentAccessRow({ providerId }: { providerId: string }): React.JSX.Element {
  const { t } = useT('settings')
  const [consent, setConsent] = useState<boolean | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => window.api.settings.getCalendarProviderSettings({ provider: providerId }))
      .then((settings) => {
        if (!cancelled) setConsent(settings?.agentReadEventsConsent ?? null)
      })
      .catch((cause: unknown) => {
        log.warn('Could not read calendar agent access', { providerId, cause })
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [providerId])

  const save = async (granted: boolean): Promise<void> => {
    setIsSaving(true)
    setError(null)
    try {
      const result = await window.api.settings.setCalendarProviderSettings({
        provider: providerId,
        updates: { agentReadEventsConsent: granted }
      })
      if (!result.success) throw new Error(result.error)
      setConsent(granted)
    } catch (cause) {
      setError(extractErrorMessage(cause, t('calendar.providers.agentAccess.error')))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <CalendarSwitchRow
      label={t('calendar.providers.agentAccess.label')}
      description={t('calendar.providers.agentAccess.description')}
      checked={consent === true}
      disabled={isLoading || isSaving}
      onCheckedChange={(checked) => void save(checked)}
      error={error}
      data-testid={`calendar-provider-agent-access-${providerId}`}
    />
  )
}
