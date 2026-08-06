import { useCallback, useEffect, useRef, useState } from 'react'
import { QrCode, KeyRound, AlertTriangle, Lock } from '@/lib/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { useT } from '@memry/i18n/renderer'
import { useAuth, type WizardStep } from '@/contexts/auth-context'
import { EmailEntryForm } from '@/components/sync/email-entry-form'
import { OtpVerification } from '@/components/sync/otp-verification'
import { OAuthButtons } from '@/components/sync/oauth-buttons'
import { RecoveryPhraseDisplay } from '@/components/sync/recovery-phrase-display'
import { RecoveryPhraseConfirm } from '@/components/sync/recovery-phrase-confirm'
import { RecoveryPhraseInput } from '@/components/sync/recovery-phrase-input'
import { LinkingCodeEntry } from '@/components/sync/linking-code-entry'
import { LinkingPending } from '@/components/sync/linking-pending'
import { VaultPickerStep } from '@/components/sync/vault-picker-step'

const MEMRY_ICON_SRC = new URL('../../../../../build/icon.png', import.meta.url).href
const MEMRY_PRICING_URL = 'https://memrynote.com/pricing'

const STEP_KEYS = ['setup.steps.signIn', 'setup.steps.verify', 'setup.steps.link'] as const
const STEP_MAP: Record<WizardStep, number> = {
  idle: 0,
  'sign-in': 0,
  'otp-verification': 1,
  'recovery-display': 1,
  'recovery-confirm': 1,
  'recovery-input': 1,
  'linking-choice': 2,
  'linking-scan': 1,
  'linking-pending': 2,
  'linking-vault-picker': 2
}

export function SetupWizard(): React.JSX.Element {
  const { t } = useT('settings')
  const {
    state: {
      wizardStep,
      wizardLinkingSessionId,
      wizardVerificationCode,
      wizardVaults,
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
    logout,
    setWizardStep,
    setWizardError,
    clearWizardError
  } = useAuth()

  const [isLoading, setIsLoading] = useState(false)
  const [isResending, setIsResending] = useState(false)
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null)
  const [recoveryPhraseError, setRecoveryPhraseError] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const containerRef = useRef<HTMLDivElement>(null)

  const expiresIn = wizardExpiresAt ? Math.max(0, Math.floor((wizardExpiresAt - now) / 1000)) : 60

  useEffect(() => {
    if (!wizardExpiresAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [wizardExpiresAt])

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
        if (phrase) setRecoveryPhrase(phrase)
        else {
          trackRendererError('recovery_phrase_fetch_failed', new Error('empty recovery phrase'))
          setRecoveryPhraseError(true)
        }
      })
      .catch((err: unknown) => {
        // Phrase lives only in main-process memory; it is gone after a restart
        // before confirmation. Surface a recoverable error instead of a blank step.
        trackRendererError('recovery_phrase_fetch_failed', err)
        if (cancelled) return
        setRecoveryPhraseError(true)
      })
    return () => {
      cancelled = true
    }
  }, [wizardStep, recoveryPhrase])

  useEffect(() => {
    const resetLoadingTimer = window.setTimeout(() => setIsLoading(false), 0)
    return () => window.clearTimeout(resetLoadingTimer)
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
          setWizardError(extractErrorMessage(err, t('setup.signIn.errors.sendCode')))
        })
    },
    [requestOtp, setWizardStep, setWizardError, clearWizardError, t]
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
          setWizardError(extractErrorMessage(err, t('setup.otp.error')))
        })
    },
    [verifyOtp, setWizardStep, setWizardError, clearWizardError, t]
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
        setWizardError(extractErrorMessage(err, t('setup.otp.resendError')))
      })
  }, [resendOtp, setWizardStep, setWizardError, clearWizardError, t])

  const handleGoogleClick = useCallback(() => {
    if (isLoading) return
    setIsLoading(true)
    clearWizardError()
    initOAuth()
      .then((result) => {
        if (!result) {
          setIsLoading(false)
          setWizardError(t('setup.signIn.errors.googleStart'))
          return
        }
        setWizardStep('sign-in', { oauthState: result.state })
      })
      .catch((err: unknown) => {
        setIsLoading(false)
        setWizardError(extractErrorMessage(err, t('setup.signIn.errors.googleStart')))
      })
  }, [isLoading, initOAuth, setWizardStep, setWizardError, clearWizardError, t])

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
          setWizardError(extractErrorMessage(err, t('setup.recovery.failed')))
        })
    },
    [linkViaRecovery, setWizardError, clearWizardError, t]
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
        setWizardError(extractErrorMessage(err, t('setup.recovery.confirmationFailed')))
      })
  }, [confirmRecoveryPhrase, setWizardError, clearWizardError, t])

  const handleRecoveryStartOver = useCallback(() => {
    void logout()
  }, [logout])

  const currentStepIndex = STEP_MAP[wizardStep]

  return (
    <div className="flex flex-col" ref={containerRef}>
      <WizardProgress currentStep={currentStepIndex} />

      {wizardStep === 'sign-in' && (
        <div className="wizard-step-enter space-y-6 text-center">
          <div className="flex flex-col items-center pb-7 gap-1.5">
            <img
              src={MEMRY_ICON_SRC}
              alt=""
              aria-hidden="true"
              className="mb-2 size-10 rounded-[10px]"
            />
            <div className="tracking-[-0.02em] font-semibold text-xl/6.5 text-foreground">
              {t('setup.signIn.title')}
            </div>
            <div className="text-[13px]/4.5 text-muted-foreground">
              {t('setup.signIn.description')}
            </div>
          </div>

          <EmailEntryForm onSubmit={handleEmailSubmit} isLoading={isLoading} error={wizardError} />

          <div className="relative py-1">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full h-px bg-gradient-to-r from-transparent via-border to-transparent" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-background px-3 uppercase tracking-[0.05em] font-medium text-[10px]/3.5 text-muted-foreground/50">
                {t('setup.signIn.or')}
              </span>
            </div>
          </div>

          <OAuthButtons
            onGoogleClick={handleGoogleClick}
            isLoading={isLoading}
            error={wizardError}
          />

          <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 pt-1 text-[11px]/4 text-muted-foreground/70">
            <Lock className="size-3 shrink-0" aria-hidden="true" />
            {t('setup.signIn.paidPlan')}
            <a
              href={MEMRY_PRICING_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[var(--tint)] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {t('setup.signIn.seePlans')}
            </a>
          </p>
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

      {isRecoveryStep && !activePhrase && (
        <div className="wizard-step-enter">
          {recoveryPhraseError ? (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <AlertTriangle className="size-8 text-amber-500" />
              <div className="space-y-1.5">
                <h3 className="font-semibold text-base/5 tracking-[-0.01em] text-foreground">
                  {t('setup.recovery.unavailable.title')}
                </h3>
                <p className="text-xs/4 text-muted-foreground">
                  {t('setup.recovery.unavailable.description')}
                </p>
              </div>
              <Button onClick={handleRecoveryStartOver} className="w-full">
                {t('setup.recovery.unavailable.startOver')}
              </Button>
            </div>
          ) : (
            <p className="py-6 text-center text-xs/4 text-muted-foreground">
              {t('setup.recovery.unavailable.loading')}
            </p>
          )}
        </div>
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
          onPickVaults={(vaults) => setWizardStep('linking-vault-picker', { vaults })}
          onError={(error) => setWizardError(error)}
          onCancel={() => setWizardStep('linking-choice')}
        />
      )}

      {wizardStep === 'linking-vault-picker' && wizardLinkingSessionId && (
        <VaultPickerStep
          sessionId={wizardLinkingSessionId}
          vaults={wizardVaults ?? []}
          onError={(error) => setWizardError(error)}
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
  const { t } = useT('settings')

  return (
    <div className="wizard-step-enter space-y-6">
      <div className="space-y-1.5">
        <h3 className="font-semibold text-base/5 tracking-[-0.01em] text-foreground">
          {t('setup.linking.choiceTitle')}
        </h3>
        <p className="text-xs/4 text-muted-foreground">{t('setup.linking.choiceDescription')}</p>
      </div>

      <div className="space-y-3">
        <button
          type="button"
          onClick={onChooseQr}
          className="w-full flex items-center gap-4 p-4 rounded-xl border border-border bg-background hover:bg-muted/50 transition-colors text-start group"
        >
          <div className="w-11 h-11 rounded-xl bg-[var(--tint)]/10 flex items-center justify-center flex-shrink-0">
            <QrCode className="w-5 h-5 text-[var(--tint)]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium group-hover:text-foreground transition-colors">
              {t('setup.linking.qrChoice')}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('setup.linking.qrChoiceDescription')}
            </p>
          </div>
        </button>

        <button
          type="button"
          onClick={onChooseRecovery}
          className="w-full flex items-center gap-4 p-4 rounded-xl border border-border bg-background hover:bg-muted/50 transition-colors text-start group"
        >
          <div className="w-11 h-11 rounded-xl bg-muted flex items-center justify-center flex-shrink-0">
            <KeyRound className="w-5 h-5 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium group-hover:text-foreground transition-colors">
              {t('setup.linking.recoveryChoice')}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('setup.linking.recoveryChoiceDescription')}
            </p>
          </div>
        </button>
      </div>
    </div>
  )
}

function WizardProgress({ currentStep }: { currentStep: number }): React.JSX.Element {
  const { t } = useT('settings')
  const widthPct = STEP_KEYS.length > 1 ? ((currentStep + 1) / STEP_KEYS.length) * 100 : 100
  const currentLabel = t(STEP_KEYS[currentStep] ?? STEP_KEYS[0])

  return (
    <div
      role="group"
      aria-label={t('setup.progress', {
        current: currentStep + 1,
        total: STEP_KEYS.length,
        label: currentLabel
      })}
      className="[font-synthesis:none] flex flex-col pb-8 gap-2 text-xs/4"
    >
      <div className="flex h-0.5 rounded-[1px] overflow-clip bg-foreground/[0.06] shrink-0">
        <div
          className="h-0.5 rounded-[1px] bg-[var(--tint)] transition-all duration-500 ease-out"
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <div className="flex items-center justify-between">
        {STEP_KEYS.map((labelKey, i) => (
          <span
            key={labelKey}
            className={cn(
              'uppercase tracking-[0.05em] font-medium text-[10px]/3.5 transition-colors duration-300',
              i <= currentStep ? 'text-[var(--tint)]' : 'text-muted-foreground/50'
            )}
          >
            {t(labelKey)}
          </span>
        ))}
      </div>
    </div>
  )
}
