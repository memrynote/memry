/**
 * Says so when Memry wrote a locked note's text back after it changed outside
 * the app (#2606). The outside edit is kept in the note's version history.
 */

import { useEffect } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

/** Listens for restored locked notes. Should be used once at the app level. */
export function useVaultLockRestoreNotice(): void {
  const { t } = useT('notes')

  useEffect(() => {
    if (!window.api?.onVaultLockExternalEditRestored) return undefined
    return window.api.onVaultLockExternalEditRestored((event) => {
      toast(t('vaultLock.externalEditRestored', { title: event.title }), {
        description: t('vaultLock.externalEditRestoredHint')
      })
    })
  }, [t])
}
