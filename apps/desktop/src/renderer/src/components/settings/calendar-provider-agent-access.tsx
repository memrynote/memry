import { useEffect, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { Switch } from '@/components/ui/switch'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { ACCENT_SWITCH } from '@/components/settings/settings-primitives'

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
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px]/4 font-medium text-foreground">
          {t('calendar.providers.agentAccess.label')}
        </span>
        <p className="text-xs/4 text-muted-foreground">
          {t('calendar.providers.agentAccess.description')}
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <Switch
        checked={consent === true}
        disabled={isLoading || isSaving}
        onCheckedChange={(checked) => void save(checked)}
        aria-label={t('calendar.providers.agentAccess.label')}
        className={ACCENT_SWITCH}
        data-testid={`calendar-provider-agent-access-${providerId}`}
      />
    </div>
  )
}
