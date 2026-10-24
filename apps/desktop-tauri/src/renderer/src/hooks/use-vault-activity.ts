/**
 * Vault activity hooks.
 *
 * The log is written by the main process (watcher, open-time scan, importers,
 * sync failures); the renderer only reads it and refetches when main says it
 * changed.
 *
 * @module hooks/use-vault-activity
 */

import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ListVaultActivityResult,
  VaultActivityFilter
} from '@memry/contracts/vault-activity-api'

export const vaultActivityKeys = {
  all: ['vault-activity'] as const,
  list: (filter: VaultActivityFilter) => ['vault-activity', filter] as const
}

/** Rows rendered in Settings; the full retained log is in the file. */
export const VAULT_ACTIVITY_LIST_LIMIT = 200

export function useVaultActivity(filter: VaultActivityFilter): {
  data: ListVaultActivityResult | undefined
  isLoading: boolean
  error: unknown
} {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: vaultActivityKeys.list(filter),
    queryFn: () => window.api.vaultActivity.list({ limit: VAULT_ACTIVITY_LIST_LIMIT, filter })
  })

  useEffect(
    () =>
      window.api.onVaultActivityChanged(() => {
        void queryClient.invalidateQueries({ queryKey: vaultActivityKeys.all })
      }),
    [queryClient]
  )

  return { data: query.data, isLoading: query.isLoading, error: query.error }
}
