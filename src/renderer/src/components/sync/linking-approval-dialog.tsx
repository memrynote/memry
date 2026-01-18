/**
 * Device Linking Approval Dialog (T117)
 *
 * Shows on the existing device when a new device requests to link.
 * Allows the user to approve or reject the linking request.
 *
 * @module components/sync/linking-approval-dialog
 */

import { useState, useCallback } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Loader2, Monitor, Terminal, Smartphone, ShieldAlert, AlertTriangle } from 'lucide-react'

// =============================================================================
// Types
// =============================================================================

type DevicePlatform = 'macos' | 'windows' | 'linux' | 'ios' | 'android'

interface LinkingApprovalDialogProps {
  /** Whether the dialog is open */
  isOpen: boolean
  /** Callback to change open state */
  onOpenChange: (open: boolean) => void
  /** Session ID for this linking request */
  sessionId: string
  /** Name of the requesting device */
  deviceName: string
  /** Platform of the requesting device */
  devicePlatform: DevicePlatform | string
  /** New device's X25519 public key (Base64) */
  newDevicePublicKey: string
  /** New device's HMAC proof (Base64) */
  newDeviceConfirm: string
  /** Called when user approves the request with proof data */
  onApprove: (input: {
    sessionId: string
    newDevicePublicKey: string
    newDeviceConfirm: string
  }) => Promise<void>
  /** Called when user rejects the request */
  onReject: () => void
  /** Whether approval is in progress */
  isApproving?: boolean
  /** Error message to display */
  error?: string | null
}

// =============================================================================
// Platform Icons
// =============================================================================

const platformIcons: Record<string, typeof Monitor> = {
  macos: Monitor,
  windows: Monitor,
  linux: Terminal,
  ios: Smartphone,
  android: Smartphone
}

const platformNames: Record<string, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  ios: 'iOS',
  android: 'Android'
}

// =============================================================================
// Component
// =============================================================================

export function LinkingApprovalDialog({
  isOpen,
  onOpenChange,
  sessionId,
  deviceName,
  devicePlatform,
  newDevicePublicKey,
  newDeviceConfirm,
  onApprove,
  onReject,
  isApproving = false,
  error
}: LinkingApprovalDialogProps) {
  const [localError, setLocalError] = useState<string | null>(null)
  // Track approval started locally (before async call begins) to prevent
  // race condition where dialog closes before isApproving prop updates
  const [isApprovingLocal, setIsApprovingLocal] = useState(false)

  const PlatformIcon = platformIcons[devicePlatform] || Monitor
  const platformName = platformNames[devicePlatform] || devicePlatform

  const handleApprove = useCallback(async () => {
    setLocalError(null)
    setIsApprovingLocal(true) // Mark BEFORE async call to prevent race condition
    try {
      await onApprove({
        sessionId,
        newDevicePublicKey,
        newDeviceConfirm
      })
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to approve linking')
      setIsApprovingLocal(false) // Reset on error so user can retry or reject
    }
  }, [onApprove, sessionId, newDevicePublicKey, newDeviceConfirm])

  const handleReject = useCallback(() => {
    onReject()
    onOpenChange(false)
  }, [onReject, onOpenChange])

  // Handle escape key to reject (only if not approving)
  const handleOpenChange = useCallback(
    (open: boolean) => {
      // Don't reject if approval was started (locally tracked or prop)
      if (!open && !isApproving && !isApprovingLocal) {
        handleReject()
      }
      onOpenChange(open)
    },
    [isApproving, isApprovingLocal, handleReject, onOpenChange]
  )

  const displayError = error || localError

  return (
    <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-primary" />
            Device Linking Request
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4 pt-2">
              {/* Device Info */}
              <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-4">
                <div className="rounded-full bg-primary/10 p-2">
                  <PlatformIcon className="size-6 text-primary" aria-hidden="true" />
                </div>
                <div>
                  <p className="font-medium text-foreground">{deviceName}</p>
                  <p className="text-sm text-muted-foreground">{platformName}</p>
                </div>
              </div>

              {/* Description */}
              <p>
                A new device is requesting to link to your account. If you approve, it will have
                access to your synced data.
              </p>

              {/* Security Warning */}
              <div className="flex items-start gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3">
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0 text-yellow-600 dark:text-yellow-400"
                  aria-hidden="true"
                />
                <div className="text-sm text-yellow-700 dark:text-yellow-300">
                  <p className="font-medium">Security Notice</p>
                  <p className="mt-1 text-xs">
                    Only approve if you initiated this request. Never approve linking requests you
                    didn&apos;t expect.
                  </p>
                </div>
              </div>

              {/* Error Message */}
              {displayError && (
                <div
                  className="rounded-lg border border-destructive/30 bg-destructive/5 p-3"
                  role="alert"
                >
                  <p className="text-sm text-destructive">{displayError}</p>
                </div>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter className="flex-col gap-2 sm:flex-row">
          <AlertDialogCancel asChild>
            <Button
              variant="outline"
              onClick={handleReject}
              disabled={isApproving || isApprovingLocal}
              className="w-full sm:w-auto"
            >
              Reject
            </Button>
          </AlertDialogCancel>
          {/* Use regular Button instead of AlertDialogAction to prevent auto-close */}
          <Button
            onClick={handleApprove}
            disabled={isApproving || isApprovingLocal}
            className="w-full sm:w-auto"
          >
            {isApproving || isApprovingLocal ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
                Approving...
              </>
            ) : (
              'Approve'
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default LinkingApprovalDialog
