import { toast } from 'sonner'
import type { TriggerSyncResult } from '@memry/contracts/ipc-sync-ops'
import { extractErrorMessage } from '@/lib/ipc-error'
import { requestOpenSettings } from '@/lib/settings-navigation'

/** `t` of the `errors` namespace. */
type ErrorsT = (key: string) => string

/**
 * Says why Sync Now moved nothing (#3382). The result used to be dropped, so a
 * click that did nothing looked exactly like a sync that worked.
 */
export function announceSyncNowResult(result: TriggerSyncResult, t: ErrorsT): void {
  if (result.success) return
  switch (result.reason) {
    case 'offline':
      toast.info(t('sync.networkOffline'))
      return
    case 'signed_out':
      toast.error(t('sync.syncNowSignedOut'), {
        duration: 10000,
        action: {
          label: t('sync.openAccountSettings'),
          onClick: () => requestOpenSettings('account')
        }
      })
      return
    case 'busy':
      toast.info(t('sync.syncNowBusy'))
      return
    case 'paused':
      toast.info(t('sync.syncNowPaused'))
      return
    case 'failed':
    case 'unavailable':
      toast.error(extractErrorMessage(result.error, t('sync.triggerFailed')), { duration: 10000 })
  }
}
