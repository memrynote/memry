import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { VaultConfig } from '@memry/contracts/vault-api'
import { vaultService, onVaultConfigChanged, onVaultStatusChanged } from '@/services/vault-service'
import { notesKeys } from '@/hooks/use-notes-query'

export const vaultConfigKey = ['vault', 'config'] as const

/**
 * The open vault's config, shared by every reader and kept current: a settings
 * save in any window and main following a renamed journal folder both arrive
 * as `vault:config-changed`. The folder list is refetched alongside, because
 * which folders it hides depends on the journal settings.
 */
export function useVaultConfig(): VaultConfig | null {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: vaultConfigKey,
    queryFn: () => vaultService.getConfig()
  })

  useEffect(() => {
    const unsubConfig = onVaultConfigChanged((config) => {
      queryClient.setQueryData(vaultConfigKey, config)
      void queryClient.invalidateQueries({ queryKey: notesKeys.folders() })
    })
    // A vault switch swaps the whole config. Status also fires on every index
    // progress beat, so only a changed path refetches.
    let lastPath: string | null | undefined
    const unsubStatus = onVaultStatusChanged((status) => {
      if (status.path === lastPath) return
      lastPath = status.path
      void queryClient.invalidateQueries({ queryKey: vaultConfigKey })
    })
    return () => {
      unsubConfig()
      unsubStatus()
    }
  }, [queryClient])

  return query.data ?? null
}
