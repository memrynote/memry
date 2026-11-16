import { useCallback, useState } from 'react'
import type { AccountVaultInfo } from '../../../preload/index.d'
import { vaultService } from '@/services/vault-service'

/**
 * Account vault directory for the switcher: refreshed on demand (switcher
 * open), keeps the last known list when offline or signed out.
 */
export function useAccountVaults(): {
  accountVaults: AccountVaultInfo[]
  refresh: () => Promise<void>
} {
  const [accountVaults, setAccountVaults] = useState<AccountVaultInfo[]>([])

  const refresh = useCallback(async () => {
    try {
      setAccountVaults(await vaultService.listAccount())
    } catch {
      // offline or signed out — keep the last known list
    }
  }, [])

  return { accountVaults, refresh }
}
