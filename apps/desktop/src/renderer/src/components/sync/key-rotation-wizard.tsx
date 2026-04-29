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
import type { KeyRotationProgressEvent } from '@memry/contracts/ipc-events'
import { useT } from '@memry/i18n/renderer'

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
  const { t } = useT('settings')
  const [step, setStep] = useState<WizardStep>('confirm')
  const [progress, setProgress] = useState({ total: 0, processed: 0, phase: '' })
  const [newPhrase, setNewPhrase] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showConfirmClose, setShowConfirmClose] = useState(false)
  const dismissedRef = useRef(false)

  useEffect(() => {
    const unsubscribe = window.api.onKeyRotationProgress((event: KeyRotationProgressEvent) => {
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
    })

    return unsubscribe
  }, [])

  const handleStartRotation = useCallback(async () => {
    setStep('rotating')
    setError(null)
    setProgress({ total: 0, processed: 0, phase: '' })

    try {
      const result = await window.api.crypto.rotateKeys({ confirm: true })

      if (result.success && result.newRecoveryPhrase) {
        setNewPhrase(result.newRecoveryPhrase)
        setStep('phrase')
      } else {
        setError(result.error ?? t('keyRotation.failed'))
        setStep('error')
      }
    } catch (err) {
      setError(extractErrorMessage(err, t('keyRotation.failed')))
      setStep('error')
    }
  }, [t])

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
              {t('keyRotation.title')}
            </DialogTitle>
            <DialogDescription>
              {step === 'confirm' && t('keyRotation.descriptions.confirm')}
              {step === 'rotating' && t('keyRotation.descriptions.rotating')}
              {step === 'phrase' && t('keyRotation.descriptions.phrase')}
              {step === 'complete' && t('keyRotation.descriptions.complete')}
              {step === 'error' && t('keyRotation.descriptions.error')}
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
            <AlertDialogTitle>{t('keyRotation.closeConfirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('keyRotation.closeConfirm.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('keyRotation.closeConfirm.stay')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => handleClose(true)}>
              {t('keyRotation.closeConfirm.closeAnyway')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function ConfirmStep({ onStart }: { onStart: () => void }): React.JSX.Element {
  const { t } = useT('settings')
  const [starting, setStarting] = useState(false)

  return (
    <div className="space-y-5 pt-1">
      <div className="flex items-start gap-3 p-3.5 rounded-md border border-amber-500/20 bg-amber-500/[0.07]">
        <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="text-[13px] leading-relaxed text-amber-800 dark:text-amber-300/90 space-y-1.5">
          <p className="font-medium">{t('keyRotation.warningTitle')}</p>
          <ul className="list-disc ps-4 space-y-0.5">
            <li>{t('keyRotation.warningItems.keyPair')}</li>
            <li>{t('keyRotation.warningItems.rewrap')}</li>
            <li>{t('keyRotation.warningItems.phrase')}</li>
            <li>{t('keyRotation.warningItems.pause')}</li>
          </ul>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{t('keyRotation.explanation')}</p>

      <Button
        onClick={() => {
          setStarting(true)
          onStart()
        }}
        disabled={starting}
        className="w-full h-11"
      >
        {starting ? t('keyRotation.starting') : t('keyRotation.start')}
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
  const { t } = useT('settings')
  const phaseLabel =
    phase === 'preparing'
      ? t('keyRotation.phases.preparing')
      : phase === 're-encrypting'
        ? t('keyRotation.phases.reencrypting', { processed, total })
        : phase === 'finalizing'
          ? t('keyRotation.phases.finalizing')
          : t('keyRotation.phases.working')

  return (
    <div
      className="space-y-5 pt-1"
      role="status"
      aria-live="polite"
      aria-label={t('keyRotation.progressAria', { phaseLabel, pct })}
    >
      <div className="space-y-3">
        <div
          className="h-2 rounded-full bg-muted overflow-hidden"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t('keyRotation.progressLabel')}
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

      <p className="text-xs text-muted-foreground/70 text-center">{t('keyRotation.doNotClose')}</p>
    </div>
  )
}

function CompleteStep({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')

  return (
    <div className="space-y-5 pt-1">
      <div className="flex items-center justify-center py-4">
        <div className="w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center">
          <Check className="w-6 h-6 text-green-600 dark:text-green-400" />
        </div>
      </div>
      <p className="text-sm text-center text-muted-foreground">{t('keyRotation.complete')}</p>
      <Button onClick={onClose} className="w-full h-11">
        {tCommon('button.done')}
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
  const { t } = useT('settings')
  const { t: tCommon } = useT('common')

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
          {error ?? t('keyRotation.unknownError')}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">{t('keyRotation.errorHint')}</p>
      <div className="flex gap-3">
        <Button variant="outline" onClick={onClose} className="flex-1 h-11">
          {tCommon('button.close')}
        </Button>
        <Button onClick={onRetry} className="flex-1 h-11">
          {tCommon('button.retry')}
        </Button>
      </div>
    </div>
  )
}
