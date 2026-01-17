/**
 * Linking Pending / Waiting for Approval Screen (T118)
 *
 * Shows on the new device while waiting for approval from the existing device.
 * Listens for approval/rejection events and handles completion.
 *
 * @module components/sync/linking-pending
 */

import { useState, useCallback } from 'react'
import {
  Loader2,
  CheckCircle,
  XCircle,
  AlertCircle,
  Clock,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useLinkingEvents, useCancelLinking } from '@/hooks/use-device-linking'

// =============================================================================
// Types
// =============================================================================

interface LinkingPendingProps {
  /** Session ID for this linking attempt */
  sessionId: string
  /** Called when user cancels the linking */
  onCancel: () => void
  /** Called when linking is approved and completed */
  onApproved: () => void
  /** Called when linking is rejected */
  onRejected: (reason: string) => void
  className?: string
}

type LinkingStatus = 'waiting' | 'completing' | 'approved' | 'rejected' | 'error' | 'cancelled'

// =============================================================================
// Component
// =============================================================================

export function LinkingPending({
  sessionId,
  onCancel,
  onApproved,
  onRejected,
  className
}: LinkingPendingProps) {
  const [status, setStatus] = useState<LinkingStatus>('waiting')
  const [_error, _setError] = useState<string | null>(null) // Reserved for future error handling
  const [rejectionReason, setRejectionReason] = useState<string | null>(null)

  const cancelLinking = useCancelLinking()

  // Subscribe to linking events
  useLinkingEvents({
    onLinkingApproved: (event) => {
      if (event.sessionId === sessionId) {
        setStatus('approved')
        // Small delay to show success state before calling callback
        setTimeout(() => {
          onApproved()
        }, 1500)
      }
    },
    onLinkingRejected: (event) => {
      if (event.sessionId === sessionId) {
        setStatus('rejected')
        setRejectionReason(event.reason || 'Request was rejected by the other device')
        // Small delay to show rejected state before calling callback
        setTimeout(() => {
          onRejected(event.reason)
        }, 2000)
      }
    }
  })

  // Handle cancel
  const handleCancel = useCallback(async () => {
    try {
      await cancelLinking.mutateAsync()
      setStatus('cancelled')
    } catch (err) {
      // Still call onCancel even if cancel fails
    }
    onCancel()
  }, [cancelLinking, onCancel])

  return (
    <div className={cn('space-y-6', className)}>
      {/* Waiting State */}
      {status === 'waiting' && (
        <>
          {/* Spinner */}
          <div className="flex justify-center">
            <div className="relative">
              <div className="rounded-full bg-primary/10 p-6">
                <Loader2 className="size-12 animate-spin text-primary" aria-hidden="true" />
              </div>
              <div className="absolute -bottom-1 -right-1 rounded-full bg-background p-1">
                <Clock className="size-5 text-muted-foreground" aria-hidden="true" />
              </div>
            </div>
          </div>

          {/* Title & Description */}
          <div className="space-y-2 text-center">
            <h2 className="text-xl font-semibold">Waiting for Approval</h2>
            <p className="text-sm text-muted-foreground">
              A request has been sent to your other device. Please approve the
              linking request there to continue.
            </p>
          </div>

          {/* Instructions */}
          <div className="rounded-lg border bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground">
              On your existing device, you should see a prompt asking you to approve
              this new device. Once approved, your account will be linked automatically.
            </p>
          </div>

          {/* Cancel Button */}
          <Button
            variant="outline"
            onClick={handleCancel}
            className="w-full"
            disabled={cancelLinking.isPending}
          >
            {cancelLinking.isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                Cancelling...
              </>
            ) : (
              <>
                <X className="mr-2 size-4" aria-hidden="true" />
                Cancel
              </>
            )}
          </Button>
        </>
      )}

      {/* Completing State */}
      {status === 'completing' && (
        <>
          <div className="flex justify-center">
            <div className="rounded-full bg-primary/10 p-6">
              <Loader2 className="size-12 animate-spin text-primary" aria-hidden="true" />
            </div>
          </div>
          <div className="space-y-2 text-center">
            <h2 className="text-xl font-semibold">Completing Setup</h2>
            <p className="text-sm text-muted-foreground">
              Linking approved! Setting up your device...
            </p>
          </div>
        </>
      )}

      {/* Approved State */}
      {status === 'approved' && (
        <>
          <div className="flex justify-center">
            <div className="rounded-full bg-green-500/10 p-6">
              <CheckCircle className="size-12 text-green-500" aria-hidden="true" />
            </div>
          </div>
          <div className="space-y-2 text-center">
            <h2 className="text-xl font-semibold text-green-600 dark:text-green-400">
              Device Linked!
            </h2>
            <p className="text-sm text-muted-foreground">
              Your device has been successfully linked to your account.
            </p>
          </div>
        </>
      )}

      {/* Rejected State */}
      {status === 'rejected' && (
        <>
          <div className="flex justify-center">
            <div className="rounded-full bg-destructive/10 p-6">
              <XCircle className="size-12 text-destructive" aria-hidden="true" />
            </div>
          </div>
          <div className="space-y-2 text-center">
            <h2 className="text-xl font-semibold text-destructive">
              Request Rejected
            </h2>
            <p className="text-sm text-muted-foreground">
              {rejectionReason || 'The linking request was rejected by the other device.'}
            </p>
          </div>
          <Button
            variant="outline"
            onClick={onCancel}
            className="w-full"
          >
            Go Back
          </Button>
        </>
      )}

      {/* Error State */}
      {status === 'error' && (
        <>
          <div className="flex justify-center">
            <div className="rounded-full bg-destructive/10 p-6">
              <AlertCircle className="size-12 text-destructive" aria-hidden="true" />
            </div>
          </div>
          <div className="space-y-2 text-center">
            <h2 className="text-xl font-semibold text-destructive">
              Something Went Wrong
            </h2>
            <p className="text-sm text-muted-foreground">
              {_error || 'An error occurred while linking your device. Please try again.'}
            </p>
          </div>
          <Button
            variant="outline"
            onClick={onCancel}
            className="w-full"
          >
            Go Back
          </Button>
        </>
      )}

      {/* Cancelled State */}
      {status === 'cancelled' && (
        <>
          <div className="flex justify-center">
            <div className="rounded-full bg-muted p-6">
              <X className="size-12 text-muted-foreground" aria-hidden="true" />
            </div>
          </div>
          <div className="space-y-2 text-center">
            <h2 className="text-xl font-semibold">Linking Cancelled</h2>
            <p className="text-sm text-muted-foreground">
              The linking process has been cancelled.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

export default LinkingPending
