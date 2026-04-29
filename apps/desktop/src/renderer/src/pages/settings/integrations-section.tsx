import { IntegrationList } from '@/components/settings/integration-list'
import { SettingsHeader } from '@/components/settings/settings-primitives'
import { useT } from '@memry/i18n/renderer'

export function IntegrationsSettings() {
  const { t } = useT('settings')

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader
        title={t('integrations.header.title')}
        subtitle={t('integrations.header.subtitle')}
      />
      <IntegrationList />
    </div>
  )
}
