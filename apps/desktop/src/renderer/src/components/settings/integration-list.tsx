import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { getAvailableIntegrations, type AuthFlowType } from '@/lib/integration-registry'

const AUTH_LABELS: Record<AuthFlowType, string> = {
  oauth2: 'OAuth 2.0',
  api_key: 'API Key',
  none: 'System'
}

export function IntegrationList(): React.JSX.Element {
  const integrations = getAvailableIntegrations()

  return (
    <div className="space-y-1">
      {integrations.map((integration) => {
        const Icon = integration.icon

        return (
          <div
            key={integration.id}
            className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted/50 group"
          >
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <Icon className="w-4 h-4 text-muted-foreground" />
            </div>

            <div className="flex-1 min-w-0">
              <span className="text-sm font-medium block">{integration.name}</span>
              <span className="text-xs text-muted-foreground block">{integration.description}</span>
            </div>

            <Badge variant="outline" className="text-xs shrink-0">
              {AUTH_LABELS[integration.authFlow]}
            </Badge>

            {integration.comingSoon ? (
              <>
                <Badge variant="secondary" className="text-xs shrink-0">
                  Coming Soon
                </Badge>
                <Button variant="outline" size="sm" disabled>
                  Connect
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm">
                Connect
              </Button>
            )}
          </div>
        )
      })}
    </div>
  )
}
