import { useCallback, useEffect, useRef, useState } from 'react'
import { QrCode, KeyRound } from '@/lib/icons'
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
import { invoke } from '@/lib/ipc/invoke'

const STEPS = ['Sign In', 'Verify', 'Link'] as const
const STEP_MAP: Record<WizardStep, number> = {
  idle: 0,
  'sign-in': 0,
  'otp-verification': 1,
  // Password collection for new accounts: still part of the
  // verification phase from the user's perspective — they're proving
  // who they are to set up the vault.
  'password-setup': 1,
  'recovery-display': 1,
  'recovery-confirm': 1,
  'recovery-input': 1,
  'linking-choice': 2,
  'linking-scan': 1,
  'linking-pending': 2
}

export function SetupWizard(): React.JSX.Element {
  const {
    state: {
      wizardStep,
      wizardLinkingSessionId,
      wizardVerificationCode,
      wizardExpiresAt,
      wizardError,
      email
    },
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
    void invoke<{ phrase: string }>('sync_setup_get_recovery_phrase')
      .then((result) => {
        if (cancelled) return
        setRecoveryPhrase(result?.phrase ?? null)
      })
      .catch(() => {
        /* recovery phrase fetch failed — user can retry via back navigation */
      })
    return () => {
      cancelled = true
    }
  }, [wizardStep, recoveryPhrase])

  useEffect(() => {
    setIsLoading(false)
  }, [wizardStep])

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
          if (result.needsRecoveryInput) setWizardStep('linking-choice')
          else if (result.needsRecoverySetup) setWizardStep('recovery-display')
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
    if (isLoading) return
    setIsLoading(true)
    clearWizardError()
    initOAuth()
      .then((result) => {
        if (!result) {
          setIsLoading(false)
          setWizardError('Failed to start Google sign-in')
          return
        }
        setWizardStep('sign-in', { oauthState: result.state })
      })
      .catch((err: unknown) => {
        setIsLoading(false)
        setWizardError(extractErrorMessage(err, 'Failed to start Google sign-in'))
      })
  }, [isLoading, initOAuth, setWizardStep, setWizardError, clearWizardError])

  const handleRecoverySubmit = useCallback(
    (phrase: string) => {
      setIsLoading(true)
      clearWizardError()
      linkViaRecovery(phrase)
        .then(() => {
          setIsLoading(false)
        })
        .catch((err: unknown) => {
          setIsLoading(false)
          setWizardError(extractErrorMessage(err, 'Recovery failed'))
        })
    },
    [linkViaRecovery, setWizardError, clearWizardError]
  )

  const handleConfirmRecovery = useCallback(() => {
    setIsLoading(true)
    clearWizardError()
    confirmRecoveryPhrase()
      .then(() => {
        setIsLoading(false)
        void navigator.clipboard.writeText('')
      })
      .catch((err: unknown) => {
        setIsLoading(false)
        setWizardError(extractErrorMessage(err, 'Confirmation failed'))
      })
  }, [confirmRecoveryPhrase, setWizardError, clearWizardError])

  const currentStepIndex = STEP_MAP[wizardStep]

  return (
    <div className="flex flex-col" ref={containerRef}>
      <WizardProgress currentStep={currentStepIndex} />

      {wizardStep === 'sign-in' && (
        <div className="wizard-step-enter space-y-6 text-center">
          <div className="flex flex-col pb-7 gap-1.5">
            <div className="tracking-[-0.02em] font-semibold text-xl/6.5 text-foreground">
              Set up Sync
            </div>
            <div className="text-[13px]/4.5 text-muted-foreground">
              Create an account to sync your data across devices with end-to-end encryption.
            </div>
          </div>

          <EmailEntryForm onSubmit={handleEmailSubmit} isLoading={isLoading} error={wizardError} />

          <div className="relative py-1">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-background px-3 uppercase tracking-[0.05em] font-medium text-[10px]/3.5 text-muted-foreground/50">
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
          onLinked={(sessionId, verificationCode) =>
            setWizardStep('linking-pending', {
              linkingSessionId: sessionId,
              verificationCode
            })
          }
          onError={(error) => setWizardError(error)}
          onBack={() => setWizardStep('linking-choice')}
        />
      )}

      {wizardStep === 'linking-pending' && wizardLinkingSessionId && (
        <LinkingPending
          sessionId={wizardLinkingSessionId}
          verificationCode={wizardVerificationCode ?? undefined}
          onComplete={() => {
            linkingCompleted()
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
      <div className="space-y-1.5">
        <h3 className="font-semibold text-base/5 tracking-[-0.01em] text-foreground">
          Link this device
        </h3>
        <p className="text-xs/4 text-muted-foreground">
          Transfer encryption keys from another device or restore from your recovery phrase.
        </p>
      </div>

      <div className="space-y-3">
        <button
          type="button"
          onClick={onChooseQr}
          className="w-full flex items-center gap-4 p-4 rounded-xl border border-border bg-background hover:bg-muted/50 transition-colors text-left group"
        >
          <div className="w-11 h-11 rounded-xl bg-[var(--tint)]/10 flex items-center justify-center flex-shrink-0">
            <QrCode className="w-5 h-5 text-[var(--tint)]" />
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
  const widthPct = STEPS.length > 1 ? ((currentStep + 1) / STEPS.length) * 100 : 100

  return (
    <div
      role="group"
      aria-label={`Step ${currentStep + 1} of ${STEPS.length}: ${STEPS[currentStep]}`}
      className="[font-synthesis:none] flex flex-col pb-8 gap-2 text-xs/4"
    >
      <div className="flex h-0.5 rounded-[1px] overflow-clip bg-foreground/[0.06] shrink-0">
        <div
          className="h-0.5 rounded-[1px] bg-[var(--tint)] transition-all duration-500 ease-out"
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <div className="flex items-center justify-between">
        {STEPS.map((label, i) => (
          <span
            key={label}
            className={cn(
              'uppercase tracking-[0.05em] font-medium text-[10px]/3.5 transition-colors duration-300',
              i <= currentStep ? 'text-[var(--tint)]' : 'text-muted-foreground/50'
            )}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
