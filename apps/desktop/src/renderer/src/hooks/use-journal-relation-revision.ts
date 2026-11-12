import { useEffect, useMemo, useState } from 'react'
import { parseRelationUri } from '@memry/contracts/relation-uri'
import {
  onJournalEntryCreated,
  onJournalEntryUpdated,
  onJournalEntryDeleted,
  onJournalExternalChange
} from '@/services/journal-service'

/** Refresh relation labels when a referenced journal day gains or loses its file. */
export function useJournalRelationRevision(uris: readonly string[]): number {
  const [revision, setRevision] = useState(0)
  const dates = useMemo(
    () =>
      new Set(
        uris.flatMap((uri) => {
          const ref = parseRelationUri(uri)
          return ref?.kind === 'journal' ? [ref.id] : []
        })
      ),
    [uris]
  )

  useEffect(() => {
    if (dates.size === 0) return undefined
    const refresh = ({ date }: { date: string }) => {
      if (dates.has(date)) setRevision((previous) => previous + 1)
    }
    const unsubscribers = [
      onJournalEntryCreated(refresh),
      onJournalEntryUpdated(refresh),
      onJournalEntryDeleted(refresh),
      onJournalExternalChange(refresh)
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [dates])

  return revision
}
