/**
 * Linking Pending Component (T118)
 *
 * Shown on new device after scanning QR code, waiting for
 * existing device to approve the linking request.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Loader2, Clock, AlertCircle, Check } from 'lucide-react'
import { cn, formatCountdown } from '@/lib/utils'
import type { CompleteLinkingResponse, GetLinkingStatusResponse } from '@shared/contracts/ipc-sync'

type PendingStatus = 'waiting' | 'approved' | 'completing' | 'completed' | 'expired' | 'error'

const LINKING_POLL_INTERVAL_MS = 2000

interface LinkingEventData {
  sessionId?: string
}

function isLinkingEvent(event: unknown): event is LinkingEventData {
  return typeof event === 'object' && event !== null && 'sessionId' in event
}

interface LinkingPendingProps {
  sessionId: string
  expiresAt: number
  onApproved: (response: CompleteLinkingResponse) => void
  onExpired: () => void
  onCancel: () => void
  className?: string
}

export function LinkingPending({
  sessionId,
  expiresAt,
  onApproved,
  onExpired,
  onCancel,
  className
}: LinkingPendingProps): React.JSX.Element {
  const [status, setStatus] = useState<PendingStatus>('waiting')
  const [countdown, setCountdown] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const pollingRef = useRef<NodeJS.Timeout | null>(null)
  const isMountedRef = useRef(true)

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
  }, [])

  const completeLinking = useCallback(async () => {
    if (!isMountedRef.current) return

    setStatus('completing')

    try {
      const response: CompleteLinkingResponse = await window.api.sync.completeLinking({ sessionId })

      if (!isMountedRef.current) return

      if (!response.success) {
        setError(response.error ?? 'Failed to complete linking')
        setStatus('error')
        return
      }

      setStatus('completed')
      onApproved(response)
    } catch (err) {
      if (!isMountedRef.current) return
      console.error('[LinkingPending] Complete error:', err)
      setError(err instanceof Error ? err.message : 'Failed to complete linking')
      setStatus('error')
    }
  }, [sessionId, onApproved])

  const pollStatus = useCallback(async () => {
    if (!isMountedRef.current || status !== 'waiting') return

    try {
      const response: GetLinkingStatusResponse = await window.api.sync.getLinkingStatus({
        sessionId
      })

      if (!isMountedRef.current || !response.session) return

      const session = response.session

      switch (session.status) {
        case 'approved':
          stopPolling()
          setStatus('approved')
          completeLinking()
          break

        case 'completed':
          stopPolling()
          setStatus('completed')
          break

        case 'expired':
          stopPolling()
          setStatus('expired')
          onExpired()
          break
      }
    } catch (err) {
      console.error('[LinkingPending] Poll error:', err)
    }
  }, [sessionId, status, stopPolling, completeLinking, onExpired])

  useEffect(() => {
    isMountedRef.current = true

    if (status === 'waiting') {
      pollingRef.current = setInterval(pollStatus, LINKING_POLL_INTERVAL_MS)
    }

    return () => {
      isMountedRef.current = false
      stopPolling()
    }
  }, [pollStatus, stopPolling, status])

  useEffect(() => {
    if (status !== 'waiting') return

    const updateCountdown = (): void => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
      setCountdown(remaining)

      if (remaining === 0 && status === 'waiting') {
        stopPolling()
        setStatus('expired')
        onExpired()
      }
    }

    updateCountdown()
    const timer = setInterval(updateCountdown, 1000)

    return () => clearInterval(timer)
  }, [expiresAt, status, stopPolling, onExpired])

  useEffect(() => {
    const unsubApproved = window.api.onLinkingApproved((event: unknown) => {
      if (!isMountedRef.current || !isLinkingEvent(event)) return
      if (event.sessionId === sessionId && status === 'waiting') {
        stopPolling()
        setStatus('approved')
        completeLinking()
      }
    })

    const unsubExpired = window.api.onLinkingExpired((event: unknown) => {
      if (!isMountedRef.current || !isLinkingEvent(event)) return
      if (event.sessionId === sessionId) {
        stopPolling()
        setStatus('expired')
        onExpired()
      }
    })

    return () => {
      unsubApproved()
      unsubExpired()
    }
  }, [sessionId, status, stopPolling, completeLinking, onExpired])

  const handleCancel = useCallback(async () => {
    try {
      await window.api.sync.cancelLinking(sessionId)
    } catch (err) {
      console.warn('[LinkingPending] Cancel error:', err)
    }
    onCancel()
  }, [sessionId, onCancel])

  if (status === 'expired') {
    return (
      <div className={cn('flex flex-col items-center space-y-4 p-6', className)}>
        <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center">
          <AlertCircle className="w-8 h-8 text-amber-500" />
        </div>

        <div className="text-center space-y-2">
          <h3 className="text-lg font-semibold">Session Expired</h3>
          <p className="text-sm text-muted-foreground">
            The linking session has expired. Please scan a new QR code.
          </p>
        </div>

        <Button variant="outline" onClick={onCancel}>
          Go Back
        </Button>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className={cn('flex flex-col items-center space-y-4 p-6', className)}>
        <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
          <AlertCircle className="w-8 h-8 text-destructive" />
        </div>

        <div className="text-center space-y-2">
          <h3 className="text-lg font-semibold">Linking Failed</h3>
          <p className="text-sm text-muted-foreground">{error ?? 'An error occurred'}</p>
        </div>

        <Button variant="outline" onClick={onCancel}>
          Go Back
        </Button>
      </div>
    )
  }

  if (status === 'completed') {
    return (
      <div className={cn('flex flex-col items-center space-y-4 p-6', className)}>
        <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center">
          <Check className="w-8 h-8 text-green-500" />
        </div>

        <div className="text-center space-y-2">
          <h3 className="text-lg font-semibold">Device Linked!</h3>
          <p className="text-sm text-muted-foreground">Your device has been successfully linked.</p>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col items-center space-y-4 p-6', className)}>
      <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
        {status === 'approved' || status === 'completing' ? (
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
        ) : (
          <Clock className="w-8 h-8 text-primary" />
        )}
      </div>

      <div className="text-center space-y-2">
        {status === 'waiting' && (
          <>
            <h3 className="text-lg font-semibold">Waiting for approval</h3>
            <p className="text-sm text-muted-foreground">
              Open Memry on your other device and approve the link request.
            </p>
          </>
        )}
        {(status === 'approved' || status === 'completing') && (
          <>
            <h3 className="text-lg font-semibold">Completing setup</h3>
            <p className="text-sm text-muted-foreground">
              Securely transferring encryption keys...
            </p>
          </>
        )}
      </div>

      {status === 'waiting' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="w-4 h-4" />
          <span>Expires in: {formatCountdown(countdown)}</span>
        </div>
      )}

      <Button
        variant="outline"
        onClick={handleCancel}
        disabled={status === 'approved' || status === 'completing'}
      >
        Cancel
      </Button>
    </div>
  )
}

export default LinkingPending
