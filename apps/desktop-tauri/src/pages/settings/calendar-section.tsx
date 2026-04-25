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
import {
  SettingsHeader,
  SettingsGroup,
  SettingRow,
  COMPACT_SELECT
} from '@/components/settings/settings-primitives'
import type { CalendarSettings } from '@/types/settings-schemas'

const GLOBAL_CLICK_OPTIONS = [
  { value: 'journal', label: 'Open Journal' },
  { value: 'calendar', label: 'Open Calendar' }
] as const

const OVERRIDE_OPTIONS = [
  { value: 'inherit', label: 'Use global setting' },
  { value: 'calendar', label: 'Open Calendar' },
  { value: 'journal', label: 'Open Journal' }
] as const

export function CalendarSettingsSection() {
  const { settings, isLoading, updateSettings } = useCalendarPreferences()

  const handleGlobalChange = useCallback(
    async (value: string) => {
      const next = value as CalendarSettings['dayCellClickBehavior']
      const success = await updateSettings({ dayCellClickBehavior: next })
      if (!success) toast.error('Failed to update day click behavior')
    },
    [updateSettings]
  )

  const handleOverrideChange = useCallback(
    async (value: string) => {
      const next = value as CalendarSettings['calendarPageClickOverride']
      const success = await updateSettings({ calendarPageClickOverride: next })
      if (!success) toast.error('Failed to update calendar page override')
    },
    [updateSettings]
  )

  if (isLoading) {
    return (
      <div className="flex flex-col">
        <SettingsHeader title="Calendar" subtitle="Loading settings..." />
      </div>
    )
  }

  return (
    <div className="flex flex-col text-xs/4">
      <SettingsHeader title="Calendar" subtitle="Configure day-cell behavior in the Day Panel" />

      <SettingsGroup label="Day Cell Click">
        <SettingRow
          label="Default behavior"
          description="When clicking a day in the Day Panel calendar from any non-calendar tab"
        >
          <Select value={settings.dayCellClickBehavior} onValueChange={handleGlobalChange}>
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GLOBAL_CLICK_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>

        <SettingRow
          label="Calendar page override"
          description="Behavior when the Calendar tab is active (defaults to Open Calendar)"
        >
          <Select value={settings.calendarPageClickOverride} onValueChange={handleOverrideChange}>
            <SelectTrigger className={COMPACT_SELECT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OVERRIDE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
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
