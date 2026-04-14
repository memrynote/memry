import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getAvailableIntegrations, type AuthFlowType } from '@/lib/integration-registry'
import { GoogleCalendarIntegrationRow } from './google-calendar-integration-row'

const AUTH_LABELS: Record<AuthFlowType, string> = {
  oauth2: 'OAuth 2.0',
  api_key: 'API Key',
  none: 'System'
}

function GenericIntegrationRow({
  integration
}: {
  integration: ReturnType<typeof getAvailableIntegrations>[number]
}): React.JSX.Element {
  const Icon = integration.icon

  return (
    <div className="flex items-center justify-between h-12 px-4 shrink-0 group">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className="w-7 h-7 rounded-md bg-muted flex items-center justify-center shrink-0">
          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
        <div className="flex flex-col gap-px min-w-0">
          <span className="font-medium text-[13px]/4 text-foreground">{integration.name}</span>
          <span className="text-xs/4 text-muted-foreground truncate">{integration.description}</span>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0 ml-4">
        <Badge variant="secondary" className="text-[10px]/3 px-1.5 py-0 h-4 border-0">
          {AUTH_LABELS[integration.authFlow]}
        </Badge>
        {integration.comingSoon ? (
          <Badge
            variant="secondary"
            className="text-[10px]/3 px-1.5 py-0 h-4 border-0 text-muted-foreground"
          >
            Coming Soon
          </Badge>
        ) : (
          <Button variant="outline" size="sm" className="h-7 px-3 text-xs/4">
            Connect
          </Button>
        )}
      </div>
    </div>
  )
}

export function IntegrationList(): React.JSX.Element {
  const integrations = getAvailableIntegrations()

  return (
    <div className="flex flex-col rounded-lg overflow-clip border border-border">
      {integrations.map((integration, i) => {
        return (
          <div key={integration.id}>
            {i > 0 && <div className="h-px bg-border" />}
            {integration.id === 'google-calendar' ? (
              <GoogleCalendarIntegrationRow />
            ) : (
              <GenericIntegrationRow integration={integration} />
            )}
          </div>
        )
      })}
    </div>
  )
}
