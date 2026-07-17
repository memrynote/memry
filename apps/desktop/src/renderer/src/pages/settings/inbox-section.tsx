import { useCallback } from 'react'
import { Switch } from '@/components/ui/switch'
import { useInboxPreferences } from '@/hooks/use-inbox-preferences'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { ReviewTimeInput } from '@/components/settings/review-time-input'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH
} from '@/components/settings/settings-primitives'

export function InboxSettings() {
  const { t } = useT('settings')
  const { settings, isLoading, updateSettings } = useInboxPreferences()
  const { settings: general } = useGeneralSettings()

  const handleToggle = useCallback(
    async (checked: boolean) => {
      const ok = await updateSettings({ reviewReminderEnabled: checked })
      if (!ok) toast.error(t('inbox.reviewReminder.error'))
    },
    [t, updateSettings]
  )

  const handleTimeChange = useCallback(
    async (value: string) => {
      const ok = await updateSettings({ reviewReminderTime: value })
      if (!ok) toast.error(t('inbox.reviewReminder.error'))
    },
    [t, updateSettings]
  )

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title={t('inbox.header.title')} subtitle={t('inbox.header.loading')} />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('inbox.header.title')} subtitle={t('inbox.header.subtitle')} />

      <SettingsGroup label={t('inbox.reviewReminder.group')}>
        <SettingRow
          label={t('inbox.reviewReminder.enabled.label')}
          description={t('inbox.reviewReminder.enabled.description')}
        >
          <Switch
            data-testid="inbox-review-toggle"
            checked={settings.reviewReminderEnabled}
            onCheckedChange={(c) => void handleToggle(c)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>

        {settings.reviewReminderEnabled && (
          <SettingRow
            label={t('inbox.reviewReminder.time.label')}
            description={t('inbox.reviewReminder.time.description')}
          >
            <ReviewTimeInput
              data-testid="inbox-review-time"
              value={settings.reviewReminderTime}
              clockFormat={general.clockFormat}
              onChange={(value) => void handleTimeChange(value)}
            />
          </SettingRow>
        )}
      </SettingsGroup>
    </div>
  )
}
