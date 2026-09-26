import { useCallback, useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useInboxPreferences } from '@/hooks/use-inbox-preferences'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { ReviewTimeInput } from '@/components/settings/review-time-input'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import type { ImageFilingMode } from '@memry/domain-inbox'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  ACCENT_SWITCH
} from '@/components/settings/settings-primitives'

const SEGMENT_ITEM =
  'h-auto min-w-0 rounded-[5px] border-none py-0.75 px-2.5 text-xs/4 text-muted-foreground shadow-none hover:bg-transparent data-[state=on]:bg-background data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(0_0_0/0.08)]'

export function InboxSettings() {
  const { t } = useT('settings')
  const { settings, isLoading, updateSettings } = useInboxPreferences()
  const { settings: general } = useGeneralSettings()
  const [isSendingTest, setIsSendingTest] = useState(false)

  const handleSendTest = useCallback(async () => {
    setIsSendingTest(true)
    try {
      const { supported } = await window.api.settings.sendTestInboxReviewNotification()
      if (supported) {
        toast.success(t('inbox.reviewReminder.test.sent'), {
          description: t('inbox.reviewReminder.test.sentHint')
        })
      } else {
        toast.error(t('inbox.reviewReminder.test.unsupported'))
      }
    } catch {
      toast.error(t('inbox.reviewReminder.error'))
    } finally {
      setIsSendingTest(false)
    }
  }, [t])

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

  const handleImageModeChange = useCallback(
    async (mode: ImageFilingMode) => {
      const ok = await updateSettings({ imageFilingMode: mode })
      if (!ok) toast.error(t('inbox.imageFiling.error'))
    },
    [t, updateSettings]
  )

  // The switch reads "ask me", so it is the inverse of the remembered flag —
  // turning it back on is how a user who clicked "don't ask again" gets the
  // filing prompt back.
  const handleAskAgainChange = useCallback(
    async (askAgain: boolean) => {
      const ok = await updateSettings({ imageFilingModeRemembered: !askAgain })
      if (!ok) toast.error(t('inbox.imageFiling.error'))
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

        <SettingRow
          label={t('inbox.reviewReminder.test.label')}
          description={t('inbox.reviewReminder.test.description')}
        >
          <Button
            data-testid="inbox-review-test"
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs/4 shadow-none"
            disabled={isSendingTest}
            onClick={() => void handleSendTest()}
          >
            {t('inbox.reviewReminder.test.button')}
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('inbox.imageFiling.group')}>
        <SettingRow
          label={t('inbox.imageFiling.mode.label')}
          description={t('inbox.imageFiling.mode.description')}
        >
          <ToggleGroup
            type="single"
            value={settings.imageFilingMode}
            onValueChange={(value) => {
              if (value) void handleImageModeChange(value as ImageFilingMode)
            }}
            aria-label={t('inbox.imageFiling.mode.label')}
            className="gap-0 rounded-[7px] bg-muted p-0.5"
          >
            {(['embed', 'link'] as const).map((mode) => (
              <ToggleGroupItem
                key={mode}
                value={mode}
                data-testid={`inbox-image-filing-${mode}`}
                className={SEGMENT_ITEM}
              >
                {t(`inbox.imageFiling.mode.${mode}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>

        <SettingRow
          label={t('inbox.imageFiling.ask.label')}
          description={t('inbox.imageFiling.ask.description')}
        >
          <Switch
            data-testid="inbox-image-filing-ask"
            checked={!settings.imageFilingModeRemembered}
            onCheckedChange={(c) => void handleAskAgainChange(c)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}
