import { useEffect } from 'react'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { setDateFormatPref, type DateFormat } from '@/lib/format-date'

// Returns the active date format AND syncs it into format-date's module cache so
// pure (non-React) helpers pick it up. Components that render dates call this so
// they re-render when the setting changes.
export function useDateFormat(): DateFormat {
  const { settings } = useGeneralSettings()
  useEffect(() => {
    setDateFormatPref(settings.dateFormat)
  }, [settings.dateFormat])
  return settings.dateFormat
}
