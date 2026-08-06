import { useState, useCallback, useEffect } from 'react'
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
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import type { LinkingRequestEvent } from '@memry/contracts/ipc-events'
import { Monitor, Smartphone, Loader2 } from '@/lib/icons'
import { useT } from '@memry/i18n/renderer'

function formatSasCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

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
  const { t } = useT('settings')
  const [isApproving, setIsApproving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verificationCode, setVerificationCode] = useState<string | null>(null)
  const [sasLoading, setSasLoading] = useState(false)

  useEffect(() => {
    if (!event?.sessionId || !open) return
    let cancelled = false
    // Defer the loading flag so the rule sees an asynchronous setter call —
    // avoids no-adjust-state-on-prop-change while still flipping the spinner
    // before the promise resolves.
    queueMicrotask(() => {
      if (cancelled) return
      setSasLoading(true)
    })
    window.api.syncLinking
      .getLinkingSas({ sessionId: event.sessionId })
      .then((result) => {
        if (cancelled) return
        if (result.verificationCode) {
          setVerificationCode(result.verificationCode)
        }
      })
      .catch((err: unknown) => {
        // Dialog falls back to the "unavailable" copy; ship the failure so
        // linking dead-ends are visible in Error Tracking.
        trackRendererError('linking_sas_fetch_failed', err)
      })
      .finally(() => {
        if (!cancelled) setSasLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [event?.sessionId, open])

  // Derive the verification code so we don't have to reset state in an effect.
  const effectiveVerificationCode = event?.sessionId && open ? verificationCode : null

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
          setError(result.error ?? t('linkingApproval.approvalFailed'))
          return
        }
        onApprove(event.sessionId)
      })
      .catch((err: unknown) => {
        setError(extractErrorMessage(err, t('linkingApproval.failedToApprove')))
      })
      .finally(() => setIsApproving(false))
  }, [event, onApprove, t])

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onReject()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-xl tracking-tight">
            {t('linkingApproval.title')}
          </DialogTitle>
          <DialogDescription className="font-serif text-[15px] leading-relaxed">
            {t('linkingApproval.description')}
          </DialogDescription>
        </DialogHeader>

        {event && (
          <div className="flex items-center gap-3 p-3 rounded-md bg-muted/50">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-amber-500/10 dark:bg-amber-400/10">
              <PlatformIcon className="w-5 h-5 text-amber-700 dark:text-amber-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {event.newDeviceName || t('linkingApproval.unknownDevice')}
              </p>
              <p className="text-xs text-muted-foreground capitalize">
                {event.newDevicePlatform || t('linkingApproval.unknownPlatform')}
              </p>
            </div>
          </div>
        )}

        <div className="rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/20 p-3 space-y-1.5">
          <p className="text-xs font-semibold tracking-widest uppercase text-muted-foreground">
            {t('linkingApproval.verificationCode')}
          </p>
          {sasLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                {t('linkingApproval.computing')}
              </span>
            </div>
          ) : effectiveVerificationCode ? (
            <p className="font-mono text-2xl tracking-[0.3em] font-semibold text-amber-700 dark:text-amber-400">
              {formatSasCode(effectiveVerificationCode)}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('linkingApproval.unavailable')}</p>
          )}
          <p className="text-xs text-muted-foreground">{t('linkingApproval.confirmCode')}</p>
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onReject} disabled={isApproving}>
            {t('linkingApproval.reject')}
          </Button>
          <Button onClick={handleApprove} disabled={isApproving || sasLoading}>
            {isApproving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('linkingApproval.approving')}
              </>
            ) : (
              t('linkingApproval.approve')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
