import { useReducer, useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle, QrCode, KeyRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useAuth } from '@/contexts/auth-context'
import { EmailEntryForm } from '@/components/sync/email-entry-form'
import { OtpVerification } from '@/components/sync/otp-verification'
import { OAuthButtons } from '@/components/sync/oauth-buttons'
import { RecoveryPhraseDisplay } from '@/components/sync/recovery-phrase-display'
import { RecoveryPhraseConfirm } from '@/components/sync/recovery-phrase-confirm'
import { RecoveryPhraseInput } from '@/components/sync/recovery-phrase-input'
import { LinkingCodeEntry } from '@/components/sync/linking-code-entry'
import { LinkingPending } from '@/components/sync/linking-pending'

type WizardStep =
  | 'sign-in'
  | 'otp-verification'
  | 'recovery-display'
  | 'recovery-confirm'
  | 'recovery-input'
  | 'linking-choice'
  | 'linking-scan'
  | 'linking-pending'
  | 'complete'

interface WizardState {
  step: WizardStep
  email: string
  deviceId: string | null
  error: string | null
  isLoading: boolean
  isResending: boolean
  expiresIn: number
  linkingSessionId: string | null
}

type WizardAction =
  | { type: 'SET_LOADING'; isLoading: boolean }
  | { type: 'SET_RESENDING'; isResending: boolean }
  | { type: 'OTP_SENT'; email: string; expiresIn: number }
  | { type: 'OTP_RESENT'; expiresIn: number }
  | {
      type: 'OTP_VERIFIED'
      deviceId: string
      needsRecovery: boolean
      needsRecoveryInput: boolean
    }
  | { type: 'RECOVERY_DISPLAYED' }
  | { type: 'RECOVERY_CONFIRMED' }
  | { type: 'RECOVERY_LINKED'; deviceId: string }
  | { type: 'CHOOSE_QR_LINKING' }
  | { type: 'CHOOSE_RECOVERY' }
  | { type: 'LINKING_SCANNED'; sessionId: string }
  | { type: 'LINKING_COMPLETED'; deviceId: string }
  | { type: 'GO_BACK'; step: WizardStep }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'CLEAR_ERROR' }

const initialState: WizardState = {
  step: 'sign-in',
  email: '',
  deviceId: null,
  error: null,
  isLoading: false,
  isResending: false,
  expiresIn: 60,
  linkingSessionId: null
}

const wizardReducer = (state: WizardState, action: WizardAction): WizardState => {
  switch (action.type) {
    case 'SET_LOADING':
      return { ...state, isLoading: action.isLoading }
    case 'SET_RESENDING':
      return { ...state, isResending: action.isResending }
    case 'OTP_SENT':
      return {
        ...state,
        step: 'otp-verification',
        email: action.email,
        expiresIn: action.expiresIn,
        isLoading: false,
        error: null
      }
    case 'OTP_RESENT':
      return { ...state, expiresIn: action.expiresIn, isResending: false, error: null }
    case 'OTP_VERIFIED': {
      let nextStep: WizardStep = 'complete'
      if (action.needsRecoveryInput) nextStep = 'linking-choice'
      else if (action.needsRecovery) nextStep = 'recovery-display'
      return {
        ...state,
        step: nextStep,
        deviceId: action.deviceId,
        isLoading: false,
        error: null
      }
    }
    case 'RECOVERY_DISPLAYED':
      return { ...state, step: 'recovery-confirm' }
    case 'RECOVERY_CONFIRMED':
      return { ...state, step: 'complete', isLoading: false }
    case 'RECOVERY_LINKED':
      return {
        ...state,
        step: 'complete',
        deviceId: action.deviceId,
        isLoading: false,
        error: null
      }
    case 'CHOOSE_QR_LINKING':
      return { ...state, step: 'linking-scan', error: null }
    case 'CHOOSE_RECOVERY':
      return { ...state, step: 'recovery-input', error: null }
    case 'LINKING_SCANNED':
      return {
        ...state,
        step: 'linking-pending',
        linkingSessionId: action.sessionId,
        error: null
      }
    case 'LINKING_COMPLETED':
      return {
        ...state,
        step: 'complete',
        deviceId: action.deviceId,
        linkingSessionId: null,
        isLoading: false,
        error: null
      }
    case 'GO_BACK':
      return { ...state, step: action.step, error: null }
    case 'SET_ERROR':
      return { ...state, error: action.error, isLoading: false, isResending: false }
    case 'CLEAR_ERROR':
      return { ...state, error: null }
    default:
      return state
  }
}

const STEPS = ['Sign In', 'Verify', 'Link', 'Done'] as const
const STEP_MAP: Record<WizardStep, number> = {
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
    requestOtp,
    verifyOtp,
    resendOtp,
    initOAuth,
    setupFirstDevice,
    confirmRecoveryPhrase,
    linkViaRecovery
  } = useAuth()
  const [state, dispatch] = useReducer(wizardReducer, initialState)
  const containerRef = useRef<HTMLDivElement>(null)
  const oauthStateRef = useRef<string | null>(null)
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const firstFocusable = el.querySelector<HTMLElement>(
      'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    firstFocusable?.focus()
  }, [state.step])

  useEffect(() => {
    if (state.step !== 'recovery-display' && state.step !== 'recovery-confirm') return
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
  }, [state.step, recoveryPhrase])

  const isRecoveryStep = state.step === 'recovery-display' || state.step === 'recovery-confirm'
  const activePhrase = isRecoveryStep ? recoveryPhrase : null

  useEffect(() => {
    const unsubCallback = window.api.onOAuthCallback(({ code, state: cbState }) => {
      if (cbState !== oauthStateRef.current) return
      oauthStateRef.current = null
      dispatch({ type: 'SET_LOADING', isLoading: true })
      setupFirstDevice({ provider: 'google', oauthToken: code, state: cbState })
        .then((result) => {
          if (!result || result.error) {
            dispatch({
              type: 'SET_ERROR',
              error: extractErrorMessage(result?.error, 'Google sign-in failed')
            })
            return
          }
          dispatch({
            type: 'OTP_VERIFIED',
            deviceId: result.deviceId ?? '',
            needsRecovery: !!result.needsRecoverySetup,
            needsRecoveryInput: !!result.needsRecoveryInput
          })
        })
        .catch((err: unknown) => {
          dispatch({
            type: 'SET_ERROR',
            error: extractErrorMessage(err, 'Google sign-in failed')
          })
        })
    })

    const unsubError = window.api.onOAuthError(({ error }) => {
      oauthStateRef.current = null
      dispatch({ type: 'SET_ERROR', error: error || 'Google sign-in failed' })
    })

    return () => {
      unsubCallback()
      unsubError()
    }
  }, [setupFirstDevice])

  const handleEmailSubmit = useCallback(
    (email: string) => {
      dispatch({ type: 'SET_LOADING', isLoading: true })
      requestOtp(email)
        .then((result) => {
          dispatch({ type: 'OTP_SENT', email, expiresIn: result.expiresIn ?? 60 })
        })
        .catch((err: unknown) => {
          dispatch({
            type: 'SET_ERROR',
            error: extractErrorMessage(err, 'Failed to send code')
          })
        })
    },
    [requestOtp]
  )

  const handleOtpVerify = useCallback(
    (code: string) => {
      dispatch({ type: 'SET_LOADING', isLoading: true })
      verifyOtp(code)
        .then((result) => {
          dispatch({
            type: 'OTP_VERIFIED',
            deviceId: result.deviceId,
            needsRecovery: result.needsRecoverySetup,
            needsRecoveryInput: result.needsRecoveryInput ?? false
          })
        })
        .catch((err: unknown) => {
          dispatch({
            type: 'SET_ERROR',
            error: extractErrorMessage(err, 'Verification failed')
          })
        })
    },
    [verifyOtp]
  )

  const handleResendOtp = useCallback(() => {
    dispatch({ type: 'SET_RESENDING', isResending: true })
    resendOtp()
      .then((result) => {
        dispatch({ type: 'OTP_RESENT', expiresIn: result.expiresIn ?? 60 })
      })
      .catch((err: unknown) => {
        dispatch({
          type: 'SET_ERROR',
          error: extractErrorMessage(err, 'Failed to resend')
        })
      })
  }, [resendOtp])

  const handleGoogleClick = useCallback(() => {
    dispatch({ type: 'SET_LOADING', isLoading: true })
    initOAuth()
      .then((result) => {
        if (!result) {
          dispatch({ type: 'SET_ERROR', error: 'Failed to start Google sign-in' })
          return
        }
        oauthStateRef.current = result.state
        dispatch({ type: 'SET_LOADING', isLoading: false })
      })
      .catch((err: unknown) => {
        dispatch({
          type: 'SET_ERROR',
          error: extractErrorMessage(err, 'Failed to start Google sign-in')
        })
      })
  }, [initOAuth])

  const handleRecoverySubmit = useCallback(
    (phrase: string) => {
      dispatch({ type: 'SET_LOADING', isLoading: true })
      dispatch({ type: 'CLEAR_ERROR' })
      linkViaRecovery(phrase)
        .then((result) => {
          dispatch({ type: 'RECOVERY_LINKED', deviceId: result.deviceId ?? '' })
        })
        .catch((err: unknown) => {
          dispatch({
            type: 'SET_ERROR',
            error: extractErrorMessage(err, 'Recovery failed')
          })
        })
    },
    [linkViaRecovery]
  )

  const handleConfirmRecovery = useCallback(() => {
    dispatch({ type: 'SET_LOADING', isLoading: true })
    confirmRecoveryPhrase()
      .then(() => {
        void navigator.clipboard.writeText('')
        dispatch({ type: 'RECOVERY_CONFIRMED' })
      })
      .catch((err: unknown) => {
        dispatch({
          type: 'SET_ERROR',
          error: extractErrorMessage(err, 'Confirmation failed')
        })
      })
  }, [confirmRecoveryPhrase])

  const currentStepIndex = STEP_MAP[state.step]

  return (
    <div className="space-y-8" ref={containerRef}>
      <WizardProgress currentStep={currentStepIndex} />

      {state.step === 'sign-in' && (
        <div className="wizard-step-enter space-y-6">
          <div className="space-y-2">
            <h3 className="font-display text-2xl tracking-tight">Set up Sync</h3>
            <p className="font-serif text-[15px] text-muted-foreground leading-relaxed">
              Create an account to sync your data across devices with end-to-end encryption.
            </p>
          </div>

          <EmailEntryForm
            onSubmit={handleEmailSubmit}
            isLoading={state.isLoading}
            error={state.error}
          />

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
            isLoading={state.isLoading}
            error={state.error}
          />
        </div>
      )}

      {state.step === 'otp-verification' && (
        <div className="wizard-step-enter">
          <OtpVerification
            email={state.email}
            onVerify={handleOtpVerify}
            onResend={handleResendOtp}
            onBack={() => dispatch({ type: 'GO_BACK', step: 'sign-in' })}
            isVerifying={state.isLoading}
            isResending={state.isResending}
            error={state.error}
            expiresIn={state.expiresIn}
          />
        </div>
      )}

      {state.step === 'recovery-display' && activePhrase && (
        <RecoveryPhraseDisplay
          phrase={activePhrase}
          onContinue={() => dispatch({ type: 'RECOVERY_DISPLAYED' })}
        />
      )}

      {state.step === 'recovery-confirm' && activePhrase && (
        <RecoveryPhraseConfirm
          phrase={activePhrase}
          onConfirmed={handleConfirmRecovery}
          onBack={() => dispatch({ type: 'GO_BACK', step: 'recovery-display' })}
        />
      )}

      {state.step === 'linking-choice' && (
        <LinkingChoiceStep
          onChooseQr={() => dispatch({ type: 'CHOOSE_QR_LINKING' })}
          onChooseRecovery={() => dispatch({ type: 'CHOOSE_RECOVERY' })}
        />
      )}

      {state.step === 'linking-scan' && (
        <LinkingCodeEntry
          onLinked={(sessionId) => dispatch({ type: 'LINKING_SCANNED', sessionId })}
          onError={(error) => dispatch({ type: 'SET_ERROR', error })}
          onBack={() => dispatch({ type: 'GO_BACK', step: 'linking-choice' })}
        />
      )}

      {state.step === 'linking-pending' && state.linkingSessionId && (
        <LinkingPending
          sessionId={state.linkingSessionId}
          onComplete={(deviceId) => dispatch({ type: 'LINKING_COMPLETED', deviceId })}
          onError={(error) => dispatch({ type: 'SET_ERROR', error })}
          onCancel={() => dispatch({ type: 'GO_BACK', step: 'linking-choice' })}
        />
      )}

      {state.step === 'recovery-input' && (
        <RecoveryPhraseInput
          onSubmit={handleRecoverySubmit}
          isLoading={state.isLoading}
          error={state.error}
          onBack={() => dispatch({ type: 'GO_BACK', step: 'linking-choice' })}
        />
      )}

      {state.step === 'complete' && (
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
