import { useEffect } from 'react'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { setDateMentionPrefs } from '@/components/note/content-area/date-mention'
import type { ClockFormat } from '@/lib/time-format'

// The inline date pill renders as raw DOM (no hooks/settings at render time), so
// push the clock format into its module-level cache whenever it changes. Labels
// recompute on the next render/edit of the block. Week start is synced globally
// by useWeekStartSync (App root). Also returns the clock format so the date
// picker popover can mirror it.
export function useDateMentionPrefs(): { clockFormat: ClockFormat } {
  const { settings: general } = useGeneralSettings()
  useEffect(() => {
    setDateMentionPrefs({ clockFormat: general.clockFormat })
  }, [general.clockFormat])
  return { clockFormat: general.clockFormat }
}
