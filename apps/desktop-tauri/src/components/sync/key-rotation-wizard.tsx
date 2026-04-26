import { useState, useEffect, useCallback, useRef } from 'react'
import { ShieldAlert, RotateCw, Check, AlertTriangle } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction
} from '@/components/ui/alert-dialog'
import { RecoveryPhraseDisplay } from '@/components/sync/recovery-phrase-display'
import { extractErrorMessage } from '@/lib/ipc-error'
import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'
import type { KeyRotationProgressEvent } from '@memry/contracts/ipc-events'

type WizardStep = 'confirm' | 'rotating' | 'phrase' | 'complete' | 'error'

interface KeyRotationWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface KeyRotationWizardSessionProps {
  onOpenChange: (open: boolean) => void
}

export function KeyRotationWizard({
  open,
  onOpenChange
}: KeyRotationWizardProps): React.JSX.Element | null {
  if (!open) return null

  return <KeyRotationWizardSession onOpenChange={onOpenChange} />
}

function KeyRotationWizardSession({
  onOpenChange
}: KeyRotationWizardSessionProps): React.JSX.Element {
  const [step, setStep] = useState<WizardStep>('confirm')
  const [progress, setProgress] = useState({ total: 0, processed: 0, phase: '' })
  const [newPhrase, setNewPhrase] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showConfirmClose, setShowConfirmClose] = useState(false)
  const dismissedRef = useRef(false)

  useEffect(() => {
    const unsubscribe = subscribeEvent<KeyRotationProgressEvent>(
      'key-rotation-progress',
      (event) => {
        if (dismissedRef.current) return

        setProgress({
          total: event.totalItems,
          processed: event.processedItems,
          phase: event.phase
        })

        if (event.error) {
          setError(event.error)
          setStep('error')
        }
      }
    )

    return unsubscribe
  }, [])

  const handleStartRotation = useCallback(async () => {
    setStep('rotating')
    setError(null)
    setProgress({ total: 0, processed: 0, phase: '' })

    try {
      // M4 returns `{ success: false, reason: 'not-implemented-in-m4' }`;
      // M7 will swap the body in once rotation is implemented. The
      // command itself takes no input — the user-facing confirm gate
      // lives in this wizard, not in the Rust contract.
      const result = await invoke<{
        success: boolean
        reason?: string | null
        newRecoveryPhrase?: string
        error?: string
      }>('crypto_rotate_keys')

      if (result.success && result.newRecoveryPhrase) {
        setNewPhrase(result.newRecoveryPhrase)
        setStep('phrase')
      } else {
        setError(result.error ?? result.reason ?? 'Key rotation failed')
        setStep('error')
      }
    } catch (err) {
      setError(extractErrorMessage(err, 'Key rotation failed'))
      setStep('error')
    }
  }, [])

  const handleClose = useCallback(
    (forceClose = false) => {
      if (step === 'rotating' && !forceClose) {
        setShowConfirmClose(true)
        return
      }

      setShowConfirmClose(false)
      onOpenChange(false)
    },
    [step, onOpenChange]
  )

  const handlePhraseConfirmed = useCallback(() => {
    setNewPhrase(null)
    setStep('complete')
  }, [])

  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0

  return (
    <>
      <Dialog
        open
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            handleClose()
          }
        }}
      >
        <DialogContent
          className="max-w-lg"
          onInteractOutside={(e) => {
            if (step === 'rotating') e.preventDefault()
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCw className="w-5 h-5" />
              Rotate Encryption Keys
            </DialogTitle>
            <DialogDescription>
              {step === 'confirm' && 'Generate new encryption keys for your vault.'}
              {step === 'rotating' && 'Re-encrypting your data with new keys...'}
              {step === 'phrase' && 'Save your new recovery phrase.'}
              {step === 'complete' && 'Key rotation complete.'}
              {step === 'error' && 'Key rotation encountered an error.'}
            </DialogDescription>
          </DialogHeader>

          {step === 'confirm' && <ConfirmStep onStart={() => void handleStartRotation()} />}

          {step === 'rotating' && (
            <RotatingStep
              phase={progress.phase}
              pct={pct}
              processed={progress.processed}
              total={progress.total}
            />
          )}

          {step === 'phrase' && newPhrase && (
            <RecoveryPhraseDisplay phrase={newPhrase} onContinue={handlePhraseConfirmed} />
          )}

          {step === 'complete' && <CompleteStep onClose={() => handleClose(true)} />}

          {step === 'error' && (
            <ErrorStep
              error={error}
              onRetry={() => void handleStartRotation()}
              onClose={() => handleClose(true)}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={showConfirmClose} onOpenChange={setShowConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotation in progress</AlertDialogTitle>
            <AlertDialogDescription>
              Key rotation is still running. Closing this dialog will not stop the process, but you
              won&apos;t see your new recovery phrase until it completes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay</AlertDialogCancel>
            <AlertDialogAction onClick={() => handleClose(true)}>Close anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function ConfirmStep({ onStart }: { onStart: () => void }): React.JSX.Element {
  const [starting, setStarting] = useState(false)

  return (
    <div className="space-y-5 pt-1">
      <div className="flex items-start gap-3 p-3.5 rounded-md border border-amber-500/20 bg-amber-500/[0.07]">
        <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="text-[13px] leading-relaxed text-amber-800 dark:text-amber-300/90 space-y-1.5">
          <p className="font-medium">This action will:</p>
          <ul className="list-disc pl-4 space-y-0.5">
            <li>Generate a new encryption key pair</li>
            <li>Re-wrap all synced items with the new key</li>
            <li>Produce a new recovery phrase (old one becomes invalid)</li>
            <li>Temporarily pause sync during the process</li>
          </ul>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Your data content is never re-encrypted — only the key envelopes change. This is a fast,
        safe operation.
      </p>

      <Button
        onClick={() => {
          setStarting(true)
          onStart()
        }}
        disabled={starting}
        className="w-full h-11"
      >
        {starting ? 'Starting...' : 'Start Key Rotation'}
      </Button>
    </div>
  )
}

function RotatingStep({
  phase,
  pct,
  processed,
  total
}: {
  phase: string
  pct: number
  processed: number
  total: number
}): React.JSX.Element {
  const phaseLabel =
    phase === 'preparing'
      ? 'Preparing...'
      : phase === 're-encrypting'
        ? `Re-wrapping keys (${processed}/${total})`
        : phase === 'finalizing'
          ? 'Finalizing...'
          : 'Working...'

  return (
    <div
      className="space-y-5 pt-1"
      role="status"
      aria-live="polite"
      aria-label={`Key rotation: ${phaseLabel} ${pct}%`}
    >
      <div className="space-y-3">
        <div
          className="h-2 rounded-full bg-muted overflow-hidden"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Key rotation progress"
        >
          <div
            className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
            style={{ width: `${Math.max(pct, 2)}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{phaseLabel}</span>
          <span className="tabular-nums font-medium">{pct}%</span>
        </div>
      </div>

      <p className="text-xs text-muted-foreground/70 text-center">
        Do not close the application during this process.
      </p>
    </div>
  )
}

function CompleteStep({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div className="space-y-5 pt-1">
      <div className="flex items-center justify-center py-4">
        <div className="w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center">
          <Check className="w-6 h-6 text-green-600 dark:text-green-400" />
        </div>
      </div>
      <p className="text-sm text-center text-muted-foreground">
        All encryption keys have been rotated. Your new recovery phrase has been saved. Sync will
        resume automatically.
      </p>
      <Button onClick={onClose} className="w-full h-11">
        Done
      </Button>
    </div>
  )
}

function ErrorStep({
  error,
  onRetry,
  onClose
}: {
  error: string | null
  onRetry: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-5 pt-1">
      <div
        className="flex items-start gap-3 p-3.5 rounded-md border border-red-500/20 bg-red-500/[0.07]"
        role="alert"
      >
        <AlertTriangle
          className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <p className="text-[13px] leading-relaxed text-red-800 dark:text-red-300/90">
          {error ?? 'An unknown error occurred during key rotation.'}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        Your existing keys remain valid. Sync has been resumed. You can retry at any time.
      </p>
      <div className="flex gap-3">
        <Button variant="outline" onClick={onClose} className="flex-1 h-11">
          Close
        </Button>
        <Button onClick={onRetry} className="flex-1 h-11">
          Retry
        </Button>
      </div>
    </div>
  )
}
