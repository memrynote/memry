import { useReducer, useCallback, useEffect, useRef } from 'react'
import { CheckCircle, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import { EmailEntryForm } from '@/components/sync/email-entry-form'
import { OtpVerification } from '@/components/sync/otp-verification'
import { OAuthButtons } from '@/components/sync/oauth-buttons'
import { RecoveryPhraseDisplay } from '@/components/sync/recovery-phrase-display'
import { RecoveryPhraseConfirm } from '@/components/sync/recovery-phrase-confirm'

type WizardStep =
  | 'choose-method'
  | 'email-entry'
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
  | { type: 'CHOOSE_EMAIL' }
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
  step: 'choose-method',
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
    case 'CHOOSE_EMAIL':
      return { ...state, step: 'email-entry', error: null }
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
  'choose-method': 0,
  'email-entry': 0,
  'otp-verification': 1,
  'recovery-display': 2,
  'recovery-confirm': 2,
  complete: 3
}

const OAUTH_NOOP = (): void => {}

export function SetupWizard(): React.JSX.Element {
  const { requestOtp, verifyOtp, resendOtp, confirmRecoveryPhrase } = useAuth()
  const [state, dispatch] = useReducer(wizardReducer, initialState)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const firstFocusable = el.querySelector<HTMLElement>(
      'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
    firstFocusable?.focus()
  }, [state.step])

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
      <StepIndicator currentStep={currentStepIndex} />

      {state.step === 'choose-method' && (
        <div className="space-y-4">
          <div className="space-y-2">
            <h3 className="text-lg font-semibold">Set up Sync</h3>
            <p className="text-sm text-muted-foreground">
              Create an account to sync your data across devices with end-to-end encryption.
            </p>
          </div>

          <div className="grid gap-3">
            <button
              type="button"
              onClick={() => dispatch({ type: 'CHOOSE_EMAIL' })}
              className="flex items-center gap-4 p-4 rounded-lg border bg-card hover:bg-accent/30 transition-colors text-left"
            >
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Mail className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="font-medium">Continue with email</p>
                <p className="text-sm text-muted-foreground">Sign in with a verification code</p>
              </div>
            </button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">or</span>
              </div>
            </div>

            <OAuthButtons onGoogleClick={OAUTH_NOOP} isLoading={false} error={null} />
          </div>
        </div>
      )}

      {state.step === 'email-entry' && (
        <div className="space-y-4">
          <div className="space-y-2">
            <h3 className="text-lg font-semibold">Sign in with email</h3>
            <p className="text-sm text-muted-foreground">
              We&apos;ll send you a verification code.
            </p>
          </div>
          <EmailEntryForm
            onSubmit={handleEmailSubmit}
            isLoading={state.isLoading}
            error={state.error}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => dispatch({ type: 'GO_BACK', step: 'choose-method' })}
          >
            Back
          </Button>
        </div>
      )}

      {state.step === 'otp-verification' && (
        <OtpVerification
          email={state.email}
          onVerify={handleOtpVerify}
          onResend={handleResendOtp}
          onBack={() => dispatch({ type: 'GO_BACK', step: 'email-entry' })}
          isVerifying={state.isLoading}
          isResending={state.isResending}
          error={state.error}
          expiresIn={state.expiresIn}
        />
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
        <div className="text-center space-y-4 py-8">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center">
              <CheckCircle className="w-8 h-8 text-green-600" />
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-semibold">Your account is set up</h3>
            <p className="text-sm text-muted-foreground">
              Your data will be synced securely across your devices with end-to-end encryption.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function StepIndicator({ currentStep }: { currentStep: number }): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={`Step ${currentStep + 1} of ${STEPS.length}: ${STEPS[currentStep]}`}
      className="flex items-center gap-2"
    >
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          {i > 0 && (
            <div
              className={cn(
                'h-px w-8 transition-colors',
                i <= currentStep ? 'bg-primary' : 'bg-border'
              )}
            />
          )}
          <div className="flex items-center gap-1.5">
            <div
              className={cn(
                'w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-colors',
                i <= currentStep ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              )}
            >
              {i < currentStep ? <CheckCircle className="w-4 h-4" /> : i + 1}
            </div>
            <span
              className={cn(
                'text-xs',
                i <= currentStep ? 'text-foreground font-medium' : 'text-muted-foreground'
              )}
            >
              {label}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
