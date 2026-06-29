import { useT } from '@memry/i18n/renderer'
import { Switch } from '@/components/ui/switch'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH
} from '@/components/settings/settings-primitives'
import { useFeatureFlags } from '@/hooks/use-feature-flags'
import { FEATURE_KEYS, type FeatureKey } from '@memry/contracts/feature-flags'

export function FeaturesSection() {
  const { t } = useT('settings')
  const { flags, setFlag } = useFeatureFlags()

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('features.header.title')} subtitle={t('features.header.subtitle')} />
      <SettingsGroup>
        {FEATURE_KEYS.map((key: FeatureKey) => (
          <SettingRow
            key={key}
            label={t(`features.items.${key}.label`)}
            description={t(`features.items.${key}.description`)}
          >
            <Switch
              aria-label={t(`features.items.${key}.label`)}
              checked={flags[key]}
              onCheckedChange={(value) => void setFlag(key, value)}
              className={ACCENT_SWITCH}
            />
          </SettingRow>
        ))}
      </SettingsGroup>
    </div>
  )
}

export default FeaturesSection
