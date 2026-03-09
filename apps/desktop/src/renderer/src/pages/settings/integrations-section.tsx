import { IntegrationList } from '@/components/settings/integration-list'

export function IntegrationsSettings() {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">Integrations</h3>
        <p className="text-sm text-muted-foreground">
          Connect external services to enrich your workflow
        </p>
      </div>

      <IntegrationList />
    </div>
  )
}
