import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle, QrCode, KeyRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useAuth, type WizardStep } from '@/contexts/auth-context'
import { EmailEntryForm } from '@/components/sync/email-entry-form'
import { OtpVerification } from '@/components/sync/otp-verification'
import { OAuthButtons } from '@/components/sync/oauth-buttons'
import { RecoveryPhraseDisplay } from '@/components/sync/recovery-phrase-display'
import { RecoveryPhraseConfirm } from '@/components/sync/recovery-phrase-confirm'
import { RecoveryPhraseInput } from '@/components/sync/recovery-phrase-input'
import { LinkingCodeEntry } from '@/components/sync/linking-code-entry'
import { LinkingPending } from '@/components/sync/linking-pending'

const STEPS = ['Sign In', 'Verify', 'Link', 'Done'] as const
const STEP_MAP: Record<WizardStep, number> = {
  idle: 0,
  'sign-in': 0,
  'otp-verification': 1,
  'recovery-display': 2,
  'recovery-confirm': 2,
  'recovery-input': 2,
  'linking-choice': 2,
  'linking-scan': 2,
  'linking-pending': 2,
  complete: 3
}

export function SetupWizard(): React.JSX.Element {
  const {
    state: { wizardStep, wizardLinkingSessionId, wizardExpiresAt, wizardError, email },
    requestOtp,
    verifyOtp,
    resendOtp,
    initOAuth,
    confirmRecoveryPhrase,
    linkViaRecovery,
    linkingCompleted,
    setWizardStep,
    setWizardError,
    clearWizardError
  } = useAuth()

  const [isLoading, setIsLoading] = useState(false)
  const [isResending, setIsResending] = useState(false)
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const expiresIn = wizardExpiresAt
    ? Math.max(0, Math.floor((wizardExpiresAt - Date.now()) / 1000))
    : 60

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const firstFocusable = el.querySelector<HTMLElement>(
      'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    firstFocusable?.focus()
  }, [wizardStep])

  useEffect(() => {
    if (wizardStep !== 'recovery-display' && wizardStep !== 'recovery-confirm') return
    if (recoveryPhrase) return
    let cancelled = false
    void window.api.syncSetup
      .getRecoveryPhrase()
      .then((phrase) => {
        if (cancelled) return
        setRecoveryPhrase(phrase)
      })
      .catch(() => {
        /* recovery phrase fetch failed — user can retry via back navigation */
      })
    return () => {
      cancelled = true
    }
  }, [wizardStep, recoveryPhrase])

  const isRecoveryStep = wizardStep === 'recovery-display' || wizardStep === 'recovery-confirm'
  const activePhrase = isRecoveryStep ? recoveryPhrase : null

  const handleEmailSubmit = useCallback(
    (submittedEmail: string) => {
      setIsLoading(true)
      clearWizardError()
      requestOtp(submittedEmail)
        .then((result) => {
          setIsLoading(false)
          setWizardStep('otp-verification', {
            expiresAt: Date.now() + (result.expiresIn ?? 60) * 1000
          })
        })
        .catch((err: unknown) => {
          setIsLoading(false)
          setWizardError(extractErrorMessage(err, 'Failed to send code'))
        })
    },
    [requestOtp, setWizardStep, setWizardError, clearWizardError]
  )

  const handleOtpVerify = useCallback(
    (code: string) => {
      setIsLoading(true)
      clearWizardError()
      verifyOtp(code)
        .then((result) => {
          setIsLoading(false)
          let nextStep: WizardStep = 'complete'
          if (result.needsRecoveryInput) nextStep = 'linking-choice'
          else if (result.needsRecoverySetup) nextStep = 'recovery-display'
          setWizardStep(nextStep)
        })
        .catch((err: unknown) => {
          setIsLoading(false)
          setWizardError(extractErrorMessage(err, 'Verification failed'))
        })
    },
    [verifyOtp, setWizardStep, setWizardError, clearWizardError]
  )

  const handleResendOtp = useCallback(() => {
    setIsResending(true)
    clearWizardError()
    resendOtp()
      .then((result) => {
        setIsResending(false)
        setWizardStep('otp-verification', {
          expiresAt: Date.now() + (result.expiresIn ?? 60) * 1000
        })
      })
      .catch((err: unknown) => {
        setIsResending(false)
        setWizardError(extractErrorMessage(err, 'Failed to resend'))
      })
  }, [resendOtp, setWizardStep, setWizardError, clearWizardError])

  const handleGoogleClick = useCallback(() => {
    setIsLoading(true)
    clearWizardError()
    initOAuth()
      .then((result) => {
        setIsLoading(false)
        if (!result) {
          setWizardError('Failed to start Google sign-in')
          return
        }
        setWizardStep('sign-in', { oauthState: result.state })
      })
      .catch((err: unknown) => {
        setIsLoading(false)
        setWizardError(extractErrorMessage(err, 'Failed to start Google sign-in'))
      })
  }, [initOAuth, setWizardStep, setWizardError, clearWizardError])

  const handleRecoverySubmit = useCallback(
    (phrase: string) => {
      setIsLoading(true)
      clearWizardError()
      linkViaRecovery(phrase)
        .then(() => {
          setIsLoading(false)
          setWizardStep('complete')
        })
        .catch((err: unknown) => {
          setIsLoading(false)
          setWizardError(extractErrorMessage(err, 'Recovery failed'))
        })
    },
    [linkViaRecovery, setWizardStep, setWizardError, clearWizardError]
  )

  const handleConfirmRecovery = useCallback(() => {
    setIsLoading(true)
    clearWizardError()
    confirmRecoveryPhrase()
      .then(() => {
        setIsLoading(false)
        void navigator.clipboard.writeText('')
        setWizardStep('complete')
      })
      .catch((err: unknown) => {
        setIsLoading(false)
        setWizardError(extractErrorMessage(err, 'Confirmation failed'))
      })
  }, [confirmRecoveryPhrase, setWizardStep, setWizardError, clearWizardError])

  const currentStepIndex = STEP_MAP[wizardStep]

  return (
    <div className="space-y-8" ref={containerRef}>
      <WizardProgress currentStep={currentStepIndex} />

      {wizardStep === 'sign-in' && (
        <div className="wizard-step-enter space-y-6">
          <div className="space-y-2">
            <h3 className="font-display text-2xl tracking-tight">Set up Sync</h3>
            <p className="font-serif text-[15px] text-muted-foreground leading-relaxed">
              Create an account to sync your data across devices with end-to-end encryption.
            </p>
          </div>

          <EmailEntryForm onSubmit={handleEmailSubmit} isLoading={isLoading} error={wizardError} />

          <div className="relative py-1">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-background px-3 text-[10px] font-semibold tracking-widest uppercase text-muted-foreground/60">
                or
              </span>
            </div>
          </div>

          <OAuthButtons
            onGoogleClick={handleGoogleClick}
            isLoading={isLoading}
            error={wizardError}
          />
        </div>
      )}

      {wizardStep === 'otp-verification' && (
        <div className="wizard-step-enter">
          <OtpVerification
            email={email ?? ''}
            onVerify={handleOtpVerify}
            onResend={handleResendOtp}
            onBack={() => setWizardStep('sign-in')}
            isVerifying={isLoading}
            isResending={isResending}
            error={wizardError}
            expiresIn={expiresIn}
          />
        </div>
      )}

      {wizardStep === 'recovery-display' && activePhrase && (
        <RecoveryPhraseDisplay
          phrase={activePhrase}
          onContinue={() => setWizardStep('recovery-confirm')}
        />
      )}

      {wizardStep === 'recovery-confirm' && activePhrase && (
        <RecoveryPhraseConfirm
          phrase={activePhrase}
          onConfirmed={handleConfirmRecovery}
          onBack={() => setWizardStep('recovery-display')}
        />
      )}

      {wizardStep === 'linking-choice' && (
        <LinkingChoiceStep
          onChooseQr={() => setWizardStep('linking-scan')}
          onChooseRecovery={() => setWizardStep('recovery-input')}
        />
      )}

      {wizardStep === 'linking-scan' && (
        <LinkingCodeEntry
          onLinked={(sessionId) =>
            setWizardStep('linking-pending', { linkingSessionId: sessionId })
          }
          onError={(error) => setWizardError(error)}
          onBack={() => setWizardStep('linking-choice')}
        />
      )}

      {wizardStep === 'linking-pending' && wizardLinkingSessionId && (
        <LinkingPending
          sessionId={wizardLinkingSessionId}
          onComplete={(deviceId) => {
            linkingCompleted(deviceId)
            setWizardStep('complete', { linkingSessionId: null })
          }}
          onError={(error) => setWizardError(error)}
          onCancel={() => setWizardStep('linking-choice')}
        />
      )}

      {wizardStep === 'recovery-input' && (
        <RecoveryPhraseInput
          onSubmit={handleRecoverySubmit}
          isLoading={isLoading}
          error={wizardError}
          onBack={() => setWizardStep('linking-choice')}
        />
      )}

      {wizardStep === 'complete' && (
        <div className="wizard-step-enter text-center space-y-5 py-10">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-2xl bg-green-500/10 dark:bg-green-400/10 flex items-center justify-center wizard-check-ring">
              <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="font-display text-2xl tracking-tight">You&apos;re all set</h3>
            <p className="font-serif text-[15px] text-muted-foreground leading-relaxed max-w-xs mx-auto">
              Your data will sync securely across devices with end-to-end encryption.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function LinkingChoiceStep({
  onChooseQr,
  onChooseRecovery
}: {
  onChooseQr: () => void
  onChooseRecovery: () => void
}): React.JSX.Element {
  return (
    <div className="wizard-step-enter space-y-6">
      <div className="space-y-2">
        <h3 className="font-display text-2xl tracking-tight">Link this device</h3>
        <p className="font-serif text-[15px] text-muted-foreground leading-relaxed">
          This account already exists. Transfer your encryption keys from another device or restore
          from your recovery phrase.
        </p>
      </div>

      <div className="space-y-3">
        <button
          type="button"
          onClick={onChooseQr}
          className="w-full flex items-center gap-4 p-4 rounded-xl border border-border bg-background hover:bg-muted/50 transition-colors text-left group"
        >
          <div className="w-11 h-11 rounded-xl bg-amber-500/10 dark:bg-amber-400/10 flex items-center justify-center flex-shrink-0">
            <QrCode className="w-5 h-5 text-amber-700 dark:text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium group-hover:text-foreground transition-colors">
              Link via QR code
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Scan the code shown on your other device
            </p>
          </div>
        </button>

        <button
          type="button"
          onClick={onChooseRecovery}
          className="w-full flex items-center gap-4 p-4 rounded-xl border border-border bg-background hover:bg-muted/50 transition-colors text-left group"
        >
          <div className="w-11 h-11 rounded-xl bg-muted flex items-center justify-center flex-shrink-0">
            <KeyRound className="w-5 h-5 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium group-hover:text-foreground transition-colors">
              Recovery phrase
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Enter your 24-word recovery phrase
            </p>
          </div>
        </button>
      </div>
    </div>
  )
}

function WizardProgress({ currentStep }: { currentStep: number }): React.JSX.Element {
  const progress = (currentStep / (STEPS.length - 1)) * 100

  return (
    <div
      role="group"
      aria-label={`Step ${currentStep + 1} of ${STEPS.length}: ${STEPS[currentStep]}`}
      className="space-y-3"
    >
      <div className="relative h-1 bg-border/50 rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${progress}%`,
            background: 'linear-gradient(90deg, rgb(180, 83, 9), rgb(245, 158, 11))'
          }}
        />
      </div>
      <div className="flex justify-between">
        {STEPS.map((label, i) => (
          <span
            key={label}
            className={cn(
              'text-[10px] tracking-widest uppercase transition-colors duration-300',
              i <= currentStep
                ? 'text-amber-700 dark:text-amber-400 font-semibold'
                : 'text-muted-foreground/50'
            )}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
