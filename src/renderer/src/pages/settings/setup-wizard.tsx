import { useReducer, useCallback, useEffect, useRef } from 'react'
import { CheckCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { EmailEntryForm } from '@/components/sync/email-entry-form'
import { OtpVerification } from '@/components/sync/otp-verification'
import { OAuthButtons } from '@/components/sync/oauth-buttons'
import { RecoveryPhraseDisplay } from '@/components/sync/recovery-phrase-display'
import { RecoveryPhraseConfirm } from '@/components/sync/recovery-phrase-confirm'

type WizardStep =
  | 'sign-in'
  | 'otp-verification'
  | 'recovery-display'
  | 'recovery-confirm'
  | 'complete'

interface WizardState {
  step: WizardStep
  email: string
  recoveryPhrase: string | null
  deviceId: string | null
  error: string | null
  isLoading: boolean
  isResending: boolean
  expiresIn: number
}

type WizardAction =
  | { type: 'SET_LOADING'; isLoading: boolean }
  | { type: 'SET_RESENDING'; isResending: boolean }
  | { type: 'OTP_SENT'; email: string; expiresIn: number }
  | { type: 'OTP_RESENT'; expiresIn: number }
  | {
      type: 'OTP_VERIFIED'
      deviceId: string
      recoveryPhrase: string | null
      needsRecovery: boolean
    }
  | { type: 'RECOVERY_DISPLAYED' }
  | { type: 'RECOVERY_CONFIRMED' }
  | { type: 'GO_BACK'; step: WizardStep }
  | { type: 'SET_ERROR'; error: string }
  | { type: 'CLEAR_ERROR' }

const initialState: WizardState = {
  step: 'sign-in',
  email: '',
  recoveryPhrase: null,
  deviceId: null,
  error: null,
  isLoading: false,
  isResending: false,
  expiresIn: 60
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
    case 'OTP_VERIFIED':
      return {
        ...state,
        step: action.needsRecovery ? 'recovery-display' : 'complete',
        deviceId: action.deviceId,
        recoveryPhrase: action.recoveryPhrase,
        isLoading: false,
        error: null
      }
    case 'RECOVERY_DISPLAYED':
      return { ...state, step: 'recovery-confirm' }
    case 'RECOVERY_CONFIRMED':
      return { ...state, step: 'complete', recoveryPhrase: null, isLoading: false }
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

const STEPS = ['Sign In', 'Verify', 'Recovery', 'Done'] as const
const STEP_MAP: Record<WizardStep, number> = {
  'sign-in': 0,
  'otp-verification': 1,
  'recovery-display': 2,
  'recovery-confirm': 2,
  complete: 3
}

export function SetupWizard(): React.JSX.Element {
  const { requestOtp, verifyOtp, resendOtp, initOAuth, setupFirstDevice, confirmRecoveryPhrase } =
    useAuth()
  const [state, dispatch] = useReducer(wizardReducer, initialState)
  const containerRef = useRef<HTMLDivElement>(null)
  const oauthStateRef = useRef<string | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const firstFocusable = el.querySelector<HTMLElement>(
      'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    firstFocusable?.focus()
  }, [state.step])

  useEffect(() => {
    const unsub = window.api.onOAuthCallback(({ code, state: cbState }) => {
      if (cbState !== oauthStateRef.current) return
      oauthStateRef.current = null
      dispatch({ type: 'SET_LOADING', isLoading: true })
      setupFirstDevice({ provider: 'google', oauthToken: code, state: cbState })
        .then((result) => {
          if (!result || result.error) {
            dispatch({
              type: 'SET_ERROR',
              error: result?.error ?? 'Google sign-in failed'
            })
            return
          }
          dispatch({
            type: 'OTP_VERIFIED',
            deviceId: result.deviceId ?? '',
            recoveryPhrase: result.recoveryPhrase ?? null,
            needsRecovery: !!result.recoveryPhrase
          })
        })
        .catch((err: unknown) => {
          dispatch({
            type: 'SET_ERROR',
            error: err instanceof Error ? err.message : 'Google sign-in failed'
          })
        })
    })
    return unsub
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
            error: err instanceof Error ? err.message : 'Failed to send code'
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
            recoveryPhrase: result.recoveryPhrase,
            needsRecovery: result.needsRecoverySetup
          })
        })
        .catch((err: unknown) => {
          dispatch({
            type: 'SET_ERROR',
            error: err instanceof Error ? err.message : 'Verification failed'
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
          error: err instanceof Error ? err.message : 'Failed to resend'
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
          error: err instanceof Error ? err.message : 'Failed to start Google sign-in'
        })
      })
  }, [initOAuth])

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
          error: err instanceof Error ? err.message : 'Confirmation failed'
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

      {state.step === 'recovery-display' && state.recoveryPhrase && (
        <RecoveryPhraseDisplay
          phrase={state.recoveryPhrase}
          onContinue={() => dispatch({ type: 'RECOVERY_DISPLAYED' })}
        />
      )}

      {state.step === 'recovery-confirm' && state.recoveryPhrase && (
        <RecoveryPhraseConfirm
          phrase={state.recoveryPhrase}
          onConfirmed={handleConfirmRecovery}
          onBack={() => dispatch({ type: 'GO_BACK', step: 'recovery-display' })}
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
