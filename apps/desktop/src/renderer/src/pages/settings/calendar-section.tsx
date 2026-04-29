import { useCallback } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useCalendarPreferences } from '@/hooks/use-calendar-preferences'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'
import type { CalendarSettings } from '@memry/contracts/settings-schemas'

const GLOBAL_CLICK_OPTIONS = [
  { value: 'journal', labelKey: 'calendar.options.openJournal' },
  { value: 'calendar', labelKey: 'calendar.options.openCalendar' }
] as const

const OVERRIDE_OPTIONS = [
  { value: 'inherit', labelKey: 'calendar.options.useGlobal' },
  { value: 'calendar', labelKey: 'calendar.options.openCalendar' },
  { value: 'journal', labelKey: 'calendar.options.openJournal' }
] as const

export function CalendarSettingsSection() {
  const { t } = useT('settings')
  const { settings, isLoading, updateSettings } = useCalendarPreferences()

  const handleGlobalChange = useCallback(
    async (value: string) => {
      const next = value as CalendarSettings['dayCellClickBehavior']
      const success = await updateSettings({ dayCellClickBehavior: next })
      if (!success) toast.error(t('calendar.defaultBehavior.error'))
    },
    [t, updateSettings]
  )

  const handleOverrideChange = useCallback(
    async (value: string) => {
      const next = value as CalendarSettings['calendarPageClickOverride']
      const success = await updateSettings({ calendarPageClickOverride: next })
      if (!success) toast.error(t('calendar.pageOverride.error'))
    },
    [t, updateSettings]
  )

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader
          title={t('calendar.header.title')}
          subtitle={t('calendar.header.loading')}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title={t('calendar.header.title')} subtitle={t('calendar.header.subtitle')} />

      <SettingsGroup label={t('calendar.groups.dayCellClick')}>
        <SettingRow
          label={t('calendar.defaultBehavior.label')}
          description={t('calendar.defaultBehavior.description')}
        >
          <Select value={settings.dayCellClickBehavior} onValueChange={handleGlobalChange}>
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GLOBAL_CLICK_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label={t('calendar.pageOverride.label')}
          description={t('calendar.pageOverride.description')}
        >
          <Select value={settings.calendarPageClickOverride} onValueChange={handleOverrideChange}>
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OVERRIDE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}

export default CalendarSettingsSection
