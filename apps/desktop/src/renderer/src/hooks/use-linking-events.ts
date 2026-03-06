import { useState, useEffect, useCallback } from 'react'
import type { LinkingRequestEvent } from '@memry/contracts/ipc-events'

interface LinkingEventsState {
  pendingRequest: LinkingRequestEvent | null
  recentlyApproved: string | null
  clearRequest: () => void
  clearApproved: () => void
}

export function useLinkingEvents(): LinkingEventsState {
  const [pendingRequest, setPendingRequest] = useState<LinkingRequestEvent | null>(null)
  const [recentlyApproved, setRecentlyApproved] = useState<string | null>(null)

  useEffect(() => {
    const unsubRequest = window.api.onLinkingRequest((event) => {
      setPendingRequest(event)
    })

    const unsubApproved = window.api.onLinkingApproved((event) => {
      setPendingRequest(null)
      setRecentlyApproved(event.sessionId)
    })

    return () => {
      unsubRequest()
      unsubApproved()
    }
  }, [])

  const clearRequest = useCallback(() => setPendingRequest(null), [])
  const clearApproved = useCallback(() => setRecentlyApproved(null), [])

  return { pendingRequest, recentlyApproved, clearRequest, clearApproved }
}
