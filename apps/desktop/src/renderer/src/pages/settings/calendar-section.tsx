import { useCallback } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Switch } from '@/components/ui/switch'
import { useCalendarPreferences } from '@/hooks/use-calendar-preferences'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  COMPACT_SELECT,
  ACCENT_SWITCH
} from '@/components/settings/settings-primitives'
import { GoogleCalendarConnection } from '@/components/settings/google-calendar-connection'
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

  const handleWeekStartChange = useCallback(
    async (value: string) => {
      if (!value) return
      const next = value as CalendarSettings['weekStartDay']
      const success = await updateSettings({ weekStartDay: next })
      if (!success) toast.error(t('calendar.weekStart.error'))
    },
    [t, updateSettings]
  )

  const handleShowNotesChange = useCallback(
    async (checked: boolean) => {
      const success = await updateSettings({ showNotesOnCalendar: checked })
      if (!success) toast.error(t('calendar.showNotesOnCalendar.error'))
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

      <SettingsGroup label={t('calendar.google.name')}>
        <GoogleCalendarConnection />
      </SettingsGroup>

      <SettingsGroup label={t('calendar.groups.weekStart')}>
        <SettingRow
          label={t('calendar.weekStart.label')}
          description={t('calendar.weekStart.description')}
        >
          <ToggleGroup
            type="single"
            value={settings.weekStartDay}
            onValueChange={(...args) => void handleWeekStartChange(...args)}
            className="gap-0 rounded-md border border-border overflow-clip"
          >
            <ToggleGroupItem
              value="sunday"
              aria-label={t('calendar.weekStart.options.sunday')}
              className="rounded-none border-none px-3 h-7 text-xs/4 font-medium data-[state=on]:bg-[var(--tint)] data-[state=on]:text-white"
            >
              {t('calendar.weekStart.options.sunday')}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="monday"
              aria-label={t('calendar.weekStart.options.monday')}
              className="rounded-none border-none border-s border-border px-3 h-7 text-xs/4 font-medium data-[state=on]:bg-[var(--tint)] data-[state=on]:text-white"
            >
              {t('calendar.weekStart.options.monday')}
            </ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup label={t('calendar.groups.dayCellClick')}>
        <SettingRow
          label={t('calendar.defaultBehavior.label')}
          description={t('calendar.defaultBehavior.description')}
        >
          <Select
            value={settings.dayCellClickBehavior}
            onValueChange={(...args) => void handleGlobalChange(...args)}
          >
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
          <Select
            value={settings.calendarPageClickOverride}
            onValueChange={(...args) => void handleOverrideChange(...args)}
          >
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

      <SettingsGroup label={t('calendar.groups.notes')}>
        <SettingRow
          label={t('calendar.showNotesOnCalendar.label')}
          description={t('calendar.showNotesOnCalendar.description')}
        >
          <Switch
            checked={settings.showNotesOnCalendar}
            onCheckedChange={(...args) => void handleShowNotesChange(...args)}
            className={ACCENT_SWITCH}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}

export default CalendarSettingsSection
