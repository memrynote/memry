import { useEffect } from 'react'
import { useT } from '@memry/i18n/renderer'
import { useTabs } from '@/contexts/tabs'
import { buildReminderTargetTab } from '@/lib/open-reminder-target'
import { getVaultSwitchState } from '@/lib/vault-switch-state'
import { createLogger } from '@/lib/logger'

const log = createLogger('StickyOpenTarget')

/**
 * Opens what a sticky send created when the sticky asks (Open, ⌘O): main
 * reveals this window and forwards the target here.
 */
export function useStickyOpenTarget(): void {
  const { openTab } = useTabs()
  const { t } = useT('inbox')

  useEffect(() => {
    return window.api.sticky.onOpenTargetRequested(({ kind, targetId }) => {
      // The leaving vault is still on screen during a switch; its tab would be wrong.
      if (getVaultSwitchState().pending !== null) return
      const tab = buildReminderTargetTab({
        targetType: kind,
        targetId,
        targetTitle: null,
        fallbacks: {
          note: t('reminder.noteFallback'),
          journal: t('reminder.journalFallback'),
          task: t('reminder.taskFallback')
        }
      })
      if (!tab) {
        log.warn(`Sticky target is unusable: ${kind} ${targetId}`)
        return
      }
      openTab(tab)
    })
  }, [openTab, t])
}
