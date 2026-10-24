/**
 * Index Recovery Notice Hook
 *
 * Tells the user, once and calmly, that Memry repaired its own search index.
 *
 * Before this, a damaged index was completely silent: search returned zero
 * results forever and nothing said why (#1585). The repair is automatic, so
 * this is a statement of fact rather than a request — there is nothing for the
 * user to do, and the notice says so.
 *
 * @module hooks/use-index-recovery-notice
 */

import { useEffect } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { onVaultIndexRecovered } from '@/services/vault-service'

/**
 * Listens for automatic index recovery. Should be used once at the app level.
 */
export function useIndexRecoveryNotice(): void {
  const { t } = useT('common')

  useEffect(() => {
    return onVaultIndexRecovered((event) => {
      // 'missing' is a brand-new vault building its index for the first time.
      // Nothing was repaired, so saying so would only worry people.
      if (event.reason === 'missing') {
        return
      }

      toast(t('toast.searchIndexRepaired'), {
        description: t('toast.searchIndexRepairedHint')
      })
    })
  }, [t])
}
