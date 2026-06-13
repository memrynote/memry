import { useEffect } from 'react'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { useTaskPreferences } from '@/hooks/use-task-preferences'
import { setDateMentionPrefs } from '@/components/note/content-area/date-mention'

// The inline date pill renders as raw DOM (no hooks/settings at render time),
// so push the relevant settings into its module-level cache whenever they
// change. Labels recompute on the next render/edit of the block.
export function useDateMentionPrefs(): void {
  const { settings: general } = useGeneralSettings()
  const { settings: tasks } = useTaskPreferences()
  useEffect(() => {
    setDateMentionPrefs({
      clockFormat: general.clockFormat,
      weekStartsOn: tasks.weekStartDay === 'sunday' ? 0 : 1
    })
  }, [general.clockFormat, tasks.weekStartDay])
}
