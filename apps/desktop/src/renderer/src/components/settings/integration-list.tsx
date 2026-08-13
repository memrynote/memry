import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getAvailableIntegrations, type AuthFlowType } from '@/lib/integration-registry'
import { calendarProviderPresentation } from '@/lib/calendar-provider-presentation'
import { listCalendarProviders } from '@/services/calendar-service'
import { CalendarProviderRow } from './calendar-provider-row'
import { useT } from '@memry/i18n/renderer'

const AUTH_LABELS: Record<AuthFlowType, string> = {
  oauth2: 'integrations.auth.oauth2',
  api_key: 'integrations.auth.apiKey',
  none: 'integrations.auth.none'
}

export const calendarProvidersQueryKey = ['calendar', 'providers'] as const

function GenericIntegrationRow({
  integration
}: {
  integration: ReturnType<typeof getAvailableIntegrations>[number]
}): React.JSX.Element {
  const { t } = useT('settings')
  const Icon = integration.icon

  return (
    <div className="flex items-center justify-between h-12 px-4 shrink-0 group">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-7 h-7 rounded-md bg-muted flex items-center justify-center shrink-0">
          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-px min-w-0">
          <span className="font-medium text-[13px]/4 text-foreground">
            {t(`integrations.registry.${integration.i18nKey}.name`)}
          </span>
          <span className="text-xs/4 text-muted-foreground truncate">
            {t(`integrations.registry.${integration.i18nKey}.description`)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0 ms-4">
        <Badge variant="secondary" className="text-[10px]/3 px-1.5 py-0 h-4 border-0">
          {t(AUTH_LABELS[integration.authFlow])}
        </Badge>
        {integration.comingSoon ? (
          <Badge
            variant="secondary"
            className="text-[10px]/3 px-1.5 py-0 h-4 border-0 text-muted-foreground"
          >
            {t('integrations.comingSoon')}
          </Badge>
        ) : (
          <Button variant="outline" size="sm" className="h-7 px-3 text-xs/4">
            {t('integrations.connect')}
          </Button>
        )}
      </div>
    </div>
  )
}

export function IntegrationList(): React.JSX.Element {
  // Calendar providers come from main, not from a hardcoded renderer list —
  // main is the only place that knows what this build can actually connect
  // and what each provider is capable of.
  const { data: providerData } = useQuery({
    queryKey: calendarProvidersQueryKey,
    queryFn: () => listCalendarProviders()
  })
  const calendarProviders = providerData?.providers ?? []
  const calendarI18nKeys = new Set(
    calendarProviders.map((provider) => calendarProviderPresentation(provider.id).i18nKey)
  )

  // Whatever the static registry lists for a provider main already reports is
  // a duplicate of the live row, so it is dropped rather than shown twice.
  const otherIntegrations = getAvailableIntegrations().filter(
    (integration) => !calendarI18nKeys.has(integration.i18nKey)
  )

  const rows = [
    ...calendarProviders.map((provider) => ({
      key: `calendar:${provider.id}`,
      element: <CalendarProviderRow provider={provider} />
    })),
    ...otherIntegrations.map((integration) => ({
      key: integration.id,
      element: <GenericIntegrationRow integration={integration} />
    }))
  ]

  return (
    <div className="flex flex-col rounded-lg overflow-clip border border-border bg-surface-active">
      {rows.map((row, i) => (
        <div key={row.key}>
          {i > 0 && <div className="h-px bg-border" />}
          {row.element}
        </div>
      ))}
    </div>
  )
}
