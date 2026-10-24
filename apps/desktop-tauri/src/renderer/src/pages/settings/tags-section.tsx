import { TagManager } from '@/components/settings/tag-manager'
import { SettingsHeader } from '@/components/settings/settings-primitives'
import { useT } from '@memry/i18n/renderer'

export function TagsSettings() {
  const { t } = useT('settings')

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('tags.header.title')} subtitle={t('tags.header.subtitle')} />
      <TagManager />
    </div>
  )
}
