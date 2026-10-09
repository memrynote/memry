import { useCallback, useContext, useEffect, useSyncExternalStore } from 'react'
import { QueryClientContext } from '@tanstack/react-query'
import type { TagSchemaSnapshot } from '@memry/contracts/tag-schema-api'
import { tagsService } from '@/services/tags-service'
import { objectIdentityOf, tagSchemaQueryKey, type ObjectIdentity } from './use-tag-schemas'

const noop = (): void => {}

/**
 * The schema snapshot for chrome that can render outside a QueryClient
 * (tab strip, notes tree, note title in tests and secondary windows): reads
 * the shared schema snapshot from the cache when there is a client, starts
 * the fetch once if nothing has, and is simply null without one.
 */
export function useOptionalTagSchemaSnapshot(): TagSchemaSnapshot | undefined {
  const client = useContext(QueryClientContext)
  const subscribe = useCallback(
    (onChange: () => void) => (client ? client.getQueryCache().subscribe(onChange) : noop),
    [client]
  )
  const snapshot = useSyncExternalStore(subscribe, () =>
    client?.getQueryData<TagSchemaSnapshot>(tagSchemaQueryKey)
  )
  useEffect(() => {
    if (!client || client.getQueryData(tagSchemaQueryKey)) return
    // prefetchQuery never rejects; a failed read leaves the plain icons.
    void client.prefetchQuery({
      queryKey: tagSchemaQueryKey,
      queryFn: () => tagsService.getSchemaSnapshot(),
      staleTime: Infinity
    })
  }, [client])
  return snapshot
}

export function useOptionalObjectIdentity(
  noteId: string | null | undefined
): ObjectIdentity | null {
  return objectIdentityOf(useOptionalTagSchemaSnapshot(), noteId)
}
