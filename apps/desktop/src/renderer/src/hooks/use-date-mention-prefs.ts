import { useEffect } from 'react'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useTaskPreferences } from '@/hooks/use-task-preferences'
import { setDateMentionPrefs } from '@/components/note/content-area/date-mention'
import type { ClockFormat } from '@/lib/time-format'

// The inline date pill renders as raw DOM (no hooks/settings at render time),
// so push the relevant settings into its module-level cache whenever they
// change. Labels recompute on the next render/edit of the block. Also returns
// the clock format so the date picker popover can mirror it.
export function useDateMentionPrefs(): { clockFormat: ClockFormat } {
  const { settings: general } = useGeneralSettings()
  const { settings: tasks } = useTaskPreferences()
  useEffect(() => {
    setDateMentionPrefs({
      clockFormat: general.clockFormat,
      weekStartsOn: tasks.weekStartDay === 'sunday' ? 0 : 1
    })
  }, [general.clockFormat, tasks.weekStartDay])
  return { clockFormat: general.clockFormat }
}
