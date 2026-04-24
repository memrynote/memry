import { IntegrationList } from '@/components/settings/integration-list'
import { SettingsHeader } from '@/components/settings/settings-primitives'

export function IntegrationsSettings() {
  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader
        title="Integrations"
        subtitle="Connect external services to enrich your workflow"
      />
      <IntegrationList />
    </div>
  )
}
