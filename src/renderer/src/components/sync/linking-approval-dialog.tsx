import { useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { LinkingRequestEvent } from '@shared/contracts/ipc-events'
import { Monitor, Smartphone, Loader2 } from 'lucide-react'

interface LinkingApprovalDialogProps {
  open: boolean
  event: LinkingRequestEvent | null
  onApprove: (sessionId: string) => void
  onReject: () => void
}

const PLATFORM_ICONS: Record<string, typeof Monitor> = {
  desktop: Monitor,
  mobile: Smartphone
}

export function LinkingApprovalDialog({
  open,
  event,
  onApprove,
  onReject
}: LinkingApprovalDialogProps): React.JSX.Element {
  const [isApproving, setIsApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const PlatformIcon = event?.newDevicePlatform
    ? (PLATFORM_ICONS[event.newDevicePlatform] ?? Monitor)
    : Monitor

  const handleApprove = useCallback(() => {
    if (!event) return

    setIsApproving(true)
    setError(null)

    window.api.syncLinking
      .approveLinking({ sessionId: event.sessionId })
      .then((result) => {
        if (!result.success) {
          setError(result.error ?? 'Approval failed')
          return
        }
        onApprove(event.sessionId)
      })
      .catch((err: unknown) => {
        setError(extractErrorMessage(err, 'Failed to approve device'))
      })
      .finally(() => setIsApproving(false))
  }, [event, onApprove])

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onReject()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl tracking-tight">
            New device wants to link
          </DialogTitle>
          <DialogDescription className="font-serif text-[15px] leading-relaxed">
            A device is requesting access to your encrypted data. Only approve if you initiated this
            request.
          </DialogDescription>
        </DialogHeader>

        {event && (
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500/10 dark:bg-amber-400/10">
              <PlatformIcon className="w-5 h-5 text-amber-700 dark:text-amber-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {event.newDeviceName || 'Unknown device'}
              </p>
              <p className="text-xs text-muted-foreground capitalize">
                {event.newDevicePlatform || 'Unknown platform'}
              </p>
            </div>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onReject} disabled={isApproving}>
            Reject
          </Button>
          <Button onClick={handleApprove} disabled={isApproving}>
            {isApproving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Approving...
              </>
            ) : (
              'Approve'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
