import { useCallback } from 'react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { useInboxPreferences } from '@/hooks/use-inbox-preferences'
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

  const handleToggle = useCallback(
    async (checked: boolean) => {
      const ok = await updateSettings({ reviewReminderEnabled: checked })
      if (!ok) toast.error(t('inbox.reviewReminder.error'))
    },
    [t, updateSettings]
  )

  const handleTimeChange = useCallback(
    async (value: string) => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return
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
            <Input
              data-testid="inbox-review-time"
              type="time"
              value={settings.reviewReminderTime}
              onChange={(e) => void handleTimeChange(e.target.value)}
              className="w-28 h-7 text-center text-xs/4 px-2"
            />
          </SettingRow>
        )}
      </SettingsGroup>
    </div>
  )
}
