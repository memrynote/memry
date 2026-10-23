import { useEffect } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { createLogger } from '@/lib/logger'
import { unwrapIpcResult } from '@/lib/ipc-error'

const log = createLogger('ReadwiseErrorToast')

/**
 * The one Readwise toast (#1418, D19): an error the user must fix, an invalid
 * or revoked token or an expired subscription, once per error episode. Main
 * owns the once-per-episode flag and answers `ackErrorToast` with `first` only
 * once, so two windows or a missed event never show it twice. Network errors,
 * rate limits and successful runs show nothing.
 */
export function useReadwiseErrorToast(openReadwise: () => void): void {
  const { t } = useT('settings')

  useEffect(() => {
    let active = true
    const check = async (): Promise<void> => {
      try {
        const status = unwrapIpcResult(await window.api.import.readwise.status(), '')
        const kind = status.error?.kind
        // Only these two need the user. The rest retry by themselves and stay in the banner.
        if (kind !== 'invalid-token' && kind !== 'subscription-expired') return
        if (!status.connected) return
        const { first } = unwrapIpcResult(await window.api.import.readwise.ackErrorToast(), '')
        if (!active || !first) return
        toast(t(`import.dialog.readwise.errorToast.${kind}.title`), {
          description: t(`import.dialog.readwise.errorToast.${kind}.description`),
          duration: 15_000,
          action: { label: t('import.dialog.readwise.errorToast.open'), onClick: openReadwise }
        })
      } catch (err) {
        // No vault open yet, or Readwise is not set up: there is nothing to tell.
        log.debug('Readwise error toast check skipped', err)
      }
    }
    void check()
    const unsubscribe = window.api.onReadwiseStatusChanged(() => void check())
    return () => {
      active = false
      unsubscribe()
    }
  }, [t, openReadwise])
}
