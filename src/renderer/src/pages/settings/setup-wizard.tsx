/**
 * Setup Wizard Page
 *
 * Multi-step wizard for first device setup including account creation,
 * email verification, and recovery phrase confirmation.
 *
 * @module pages/settings/setup-wizard
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import { Shield, ChevronLeft, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  SignupForm,
  LoginForm,
  OAuthButtons,
  OAuthDivider,
  RecoveryPhraseDisplay,
  RecoveryPhraseConfirm,
  RecoveryPhraseInput,
  VerificationPending,
  ForgotPasswordForm,
  QRScanner,
  LinkingPending
} from '@/components/sync'
import { useLinkingEvents, useLinkViaQR } from '@/hooks/use-device-linking'
import { useAuth } from '@/contexts/auth-context'
import { authKeys } from '@/hooks/use-auth'
import { useQueryClient } from '@tanstack/react-query'
import type { OAuthSuccessEvent } from '../../../../preload/index.d'

// =============================================================================
// Types
// =============================================================================

type WizardStep =
  | 'welcome'
  | 'signup'
  | 'login'
  | 'forgot-password'
  | 'verification'
  | 'recovery-phrase'
  | 'enter-phrase'
  | 'confirm-phrase'
  | 'link-device'
  | 'link-pending'
  | 'complete'

type AuthMode = 'signup' | 'login'

interface SetupWizardProps {
  onComplete?: () => void
  className?: string
}

// =============================================================================
// Step Indicator Component
// =============================================================================

interface StepIndicatorProps {
  steps: string[]
  currentStep: number
  className?: string
}

function StepIndicator({ steps, currentStep, className }: StepIndicatorProps) {
  return (
    <div className={cn('flex items-center justify-center gap-2', className)}>
      {steps.map((step, index) => (
        <div key={step} className="flex items-center">
          <div
            className={cn(
              'flex size-8 items-center justify-center rounded-full text-sm font-medium transition-colors',
              index < currentStep
                ? 'bg-primary text-primary-foreground'
                : index === currentStep
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground'
            )}
          >
            {index + 1}
          </div>
          {index < steps.length - 1 && (
            <div
              className={cn(
                'mx-2 h-0.5 w-8 transition-colors',
                index < currentStep ? 'bg-primary' : 'bg-muted'
              )}
            />
          )}
        </div>
      ))}
    </div>
  )
}

// =============================================================================
// Welcome Step
// =============================================================================

interface WelcomeStepProps {
  onSignup: () => void
  onLogin: () => void
  onLinkDevice: () => void
}

function WelcomeStep({ onSignup, onLogin, onLinkDevice }: WelcomeStepProps) {
  return (
    <div className="space-y-8">
      {/* Logo/Icon */}
      <div className="flex justify-center">
        <div className="rounded-full bg-primary/10 p-4">
          <Shield className="size-12 text-primary" aria-hidden="true" />
        </div>
      </div>

      {/* Title */}
      <div className="space-y-2 text-center">
        <h1 className="text-2xl font-bold">Set Up Sync</h1>
        <p className="text-muted-foreground">
          Sync your notes, tasks, and settings across all your devices with end-to-end encryption.
        </p>
      </div>

      {/* Features */}
      <div className="space-y-3">
        <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="rounded bg-green-500/10 p-1.5">
            <Shield className="size-4 text-green-500" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-medium">End-to-End Encrypted</p>
            <p className="text-xs text-muted-foreground">
              Your data is encrypted before leaving your device
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="rounded bg-blue-500/10 p-1.5">
            <Shield className="size-4 text-blue-500" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-medium">Zero-Knowledge</p>
            <p className="text-xs text-muted-foreground">
              We can&apos;t read your data, even if we wanted to
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="rounded bg-purple-500/10 p-1.5">
            <Shield className="size-4 text-purple-500" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-medium">Recovery Phrase</p>
            <p className="text-xs text-muted-foreground">
              A 24-word phrase lets you recover your data on any device
            </p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="space-y-3">
        <Button onClick={onSignup} className="w-full" size="lg">
          Create Account
        </Button>
        <Button onClick={onLogin} variant="outline" className="w-full" size="lg">
          Sign In
        </Button>
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">or</span>
          </div>
        </div>
        <Button onClick={onLinkDevice} variant="ghost" className="w-full" size="lg">
          Link to Existing Account
        </Button>
      </div>
    </div>
  )
}

// =============================================================================
// Main Wizard Component
// =============================================================================

/**
 * First device setup wizard.
 */
export function SetupWizard({ onComplete, className }: SetupWizardProps) {
  const {
    signup,
    login,
    verifyEmail,
    resendVerification,
    forgotPassword,
    startOAuth,
    recoveryPhrase,
    isGeneratingPhrase,
    confirmRecoveryPhrase,
    setupFirstDevice,
    linkViaRecovery,
    refreshStatus,
    isSigningUp,
    isLoggingIn,
    isVerifying,
    isResending,
    isForgotPassword,
    isStartingOAuth,
    isConfirmingPhrase,
    isSettingUpDevice,
    isLinkingViaRecovery
  } = useAuth()

  const [step, setStep] = useState<WizardStep>('welcome')
  const [authMode, setAuthMode] = useState<AuthMode>('signup')
  const [email, setEmail] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [oauthProvider, setOauthProvider] = useState<'google' | null>(null)
  const [oauthResult, setOauthResult] = useState<OAuthSuccessEvent | null>(null)
  const [linkingSessionId, setLinkingSessionId] = useState<string | null>(null)

  // QR device linking hook
  const linkViaQR = useLinkViaQR()

  // Get query client to invalidate auth queries on OAuth success
  const queryClient = useQueryClient()

  // Get default device name
  const defaultDeviceName = useMemo(() => {
    const platform = navigator.platform.toLowerCase()
    if (platform.includes('mac')) return 'My Mac'
    if (platform.includes('win')) return 'My PC'
    if (platform.includes('linux')) return 'My Linux Machine'
    return 'My Device'
  }, [])

  // Step numbers for indicator - different for signup vs login flow
  const stepNames = useMemo(() => {
    if (authMode === 'login') {
      return ['Account', 'Recovery', 'Complete']
    }
    return ['Account', 'Verify', 'Phrase', 'Confirm']
  }, [authMode])

  const currentStepIndex = useMemo(() => {
    switch (step) {
      case 'welcome':
      case 'signup':
      case 'login':
      case 'forgot-password':
        return 0
      case 'verification':
        return 1
      case 'recovery-phrase':
        return 2
      case 'enter-phrase':
        return 1 // Login flow: Account -> Recovery (enter) -> Complete
      case 'confirm-phrase':
        return 3
      case 'complete':
        return authMode === 'login' ? 2 : 4
      default:
        return 0
    }
  }, [step, authMode])

  // Recovery phrase is generated during signup in the main process
  useEffect(() => {
    if (
      step === 'recovery-phrase' &&
      !recoveryPhrase &&
      !oauthResult?.recoveryPhrase &&
      authMode === 'signup'
    ) {
      setError('Missing recovery phrase. Please restart signup.')
    }
  }, [step, recoveryPhrase, oauthResult, authMode])

  // Listen for loopback OAuth success/error events
  useEffect(() => {
    const unsubSuccess = window.api.onAuthSuccess((event) => {
      setOauthProvider(null)
      setOauthResult(event)

      // Store email and device name from OAuth result
      if (event.user?.email) {
        setEmail(event.user.email)
      }
      if (event.deviceName) {
        setDeviceName(event.deviceName)
      }

      // Invalidate auth queries so context refreshes
      queryClient.invalidateQueries({ queryKey: authKeys.all })

      if (event.isNewUser && event.recoveryPhrase) {
        // New OAuth user - show recovery phrase
        setStep('recovery-phrase')
      } else if (event.needsRecoveryPhrase) {
        // Existing user - need to enter recovery phrase
        setStep('enter-phrase')
      }
    })

    const unsubError = window.api.onAuthError((event) => {
      setOauthProvider(null)
      setError(event.error)
    })

    return () => {
      unsubSuccess()
      unsubError()
    }
  }, [queryClient])

  // Handle signup
  const handleSignup = useCallback(
    async (data: { email: string; password: string; deviceName: string }) => {
      setError(null)
      try {
        const result = await signup(data)
        if (result.success) {
          setEmail(data.email)
          setStep('verification')
        } else {
          setError(result.error || 'Signup failed')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Signup failed')
      }
    },
    [signup]
  )

  // Handle login
  const handleLogin = useCallback(
    async (data: { email: string; password: string; deviceName: string }) => {
      setError(null)
      try {
        const result = (await login(data)) as {
          success: boolean
          error?: string
          needsRecoveryPhrase?: boolean
        }

        if (result.success) {
          setEmail(data.email)
          setDeviceName(data.deviceName)

          // Check if this device needs recovery phrase (new device setup)
          if (result.needsRecoveryPhrase) {
            // User needs to enter their existing recovery phrase
            setStep('enter-phrase')
          } else {
            // Device already set up or no recovery phrase needed
            setStep('complete')
            onComplete?.()
          }
        } else {
          setError(result.error || 'Login failed')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Login failed')
      }
    },
    [login, onComplete]
  )

  // Handle OAuth
  const handleOAuthStart = useCallback(
    async (provider: 'google') => {
      setError(null)
      setOauthProvider(provider)
      try {
        const result = await startOAuth({ provider, deviceName: defaultDeviceName })
        // Open auth URL in system browser
        window.open(result.authUrl, '_blank')
        // Note: OAuth callback will be handled by the main process
        // and will trigger a status refresh
      } catch (err) {
        setError(err instanceof Error ? err.message : 'OAuth failed')
        setOauthProvider(null)
      }
    },
    [startOAuth, defaultDeviceName]
  )

  // Handle forgot password
  const handleForgotPassword = useCallback(
    async (forgotEmail: string) => {
      setError(null)
      try {
        const result = await forgotPassword(forgotEmail)
        if (!result.success) {
          setError(result.error || 'Failed to send reset email')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to send reset email')
      }
    },
    [forgotPassword]
  )

  // Handle resend verification
  const handleResendVerification = useCallback(async () => {
    setError(null)
    try {
      const result = await resendVerification()
      if (!result.success) {
        setError(result.error || 'Failed to resend verification email')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend')
    }
  }, [resendVerification])

  // Handle manual token verification
  const handleVerifyToken = useCallback(
    async (token: string) => {
      setError(null)
      try {
        const result = await verifyEmail(token)
        if (result.success) {
          // Move to recovery phrase step after verification
          setStep('recovery-phrase')
        } else {
          setError(result.error || 'Verification failed')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Verification failed')
      }
    },
    [verifyEmail]
  )

  // Handle recovery phrase confirmation
  const handleConfirmPhrase = useCallback(
    async (confirmationWords: Array<{ index: number; word: string }>) => {
      // Use OAuth result phrase if available (loopback flow), otherwise use hook
      const phraseToConfirm = oauthResult?.recoveryPhrase || recoveryPhrase
      if (!phraseToConfirm) return
      setError(null)
      try {
        // Step 1: Confirm recovery phrase words
        const confirmResult = await confirmRecoveryPhrase({
          phrase: phraseToConfirm,
          confirmationWords
        })
        if (!confirmResult.success) {
          setError(confirmResult.error || 'Failed to confirm recovery phrase')
          return
        }

        // Step 2: Complete device setup (derive keys, register device, save to keychain)
        const setupResult = await setupFirstDevice()
        if (!setupResult.success) {
          setError(setupResult.error || 'Failed to complete device setup')
          return
        }

        // Success - move to complete step
        setStep('complete')
        onComplete?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Setup failed')
      }
    },
    [
      oauthResult?.recoveryPhrase,
      recoveryPhrase,
      confirmRecoveryPhrase,
      setupFirstDevice,
      onComplete
    ]
  )

  // Handle entering existing recovery phrase (login on new device)
  const handleEnterPhrase = useCallback(
    async (enteredPhrase: string) => {
      setError(null)
      try {
        const result = await linkViaRecovery({
          recoveryPhrase: enteredPhrase,
          email,
          deviceName: deviceName || defaultDeviceName
        })

        if (result.success) {
          setStep('complete')
          onComplete?.()
        } else {
          setError(result.error || 'Failed to verify recovery phrase')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to verify recovery phrase')
      }
    },
    [linkViaRecovery, email, deviceName, defaultDeviceName, onComplete]
  )

  // QR Linking handlers
  const handleLinkViaQR = useCallback(
    async (data: { qrData: string; deviceName: string }) => {
      setError(null)
      setDeviceName(data.deviceName)
      try {
        const result = await linkViaQR.mutateAsync(data)
        if (result.success && result.sessionId) {
          setLinkingSessionId(result.sessionId)
          setStep('link-pending')
        } else {
          setError(result.error || 'Failed to initiate device linking')
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to initiate device linking')
      }
    },
    [linkViaQR]
  )

  // Listen for linking approval/rejection/expiry events
  // Note: Main process now owns completion - it auto-completes and emits this event with result
  useLinkingEvents({
    onLinkingApproved: useCallback(
      (event) => {
        // Verify this event is for our session
        if (event.sessionId !== linkingSessionId) {
          return
        }

        // Main process already completed linking; refresh setup status before updating UI
        refreshStatus()
        setStep('complete')
        onComplete?.()
      },
      [linkingSessionId, onComplete, refreshStatus]
    ),
    onLinkingRejected: useCallback(
      (event) => {
        // Verify this event is for our session
        if (event.sessionId !== linkingSessionId) {
          return
        }

        setError(event.reason || 'Linking request was rejected')
        setStep('link-device')
        setLinkingSessionId(null)
      },
      [linkingSessionId]
    ),
    onLinkingExpired: useCallback(
      (event) => {
        // Verify this event is for our session
        if (event.sessionId !== linkingSessionId) {
          return
        }

        setError('Session expired. Please try again.')
        setStep('link-device')
        setLinkingSessionId(null)
      },
      [linkingSessionId]
    )
  })

  // Navigation helpers
  const goToSignup = useCallback(() => {
    setAuthMode('signup')
    setStep('signup')
    setError(null)
  }, [])

  const goToLogin = useCallback(() => {
    setAuthMode('login')
    setStep('login')
    setError(null)
  }, [])

  const goToForgotPassword = useCallback(() => {
    setStep('forgot-password')
    setError(null)
  }, [])

  const goToLinkDevice = useCallback(() => {
    setStep('link-device')
    setError(null)
  }, [])

  const goBack = useCallback(() => {
    setError(null)
    switch (step) {
      case 'signup':
      case 'login':
      case 'link-device':
        setStep('welcome')
        break
      case 'forgot-password':
        setStep('login')
        break
      case 'verification':
        setStep(authMode)
        break
      case 'recovery-phrase':
        setStep('verification')
        break
      case 'enter-phrase':
        setStep('login')
        break
      case 'confirm-phrase':
        setStep('recovery-phrase')
        break
      case 'link-pending':
        setStep('link-device')
        setLinkingSessionId(null)
        break
      default:
        setStep('welcome')
    }
  }, [step, authMode])

  // Render step content
  const renderStep = () => {
    switch (step) {
      case 'welcome':
        return (
          <WelcomeStep onSignup={goToSignup} onLogin={goToLogin} onLinkDevice={goToLinkDevice} />
        )

      case 'signup':
        return (
          <div className="space-y-6">
            <div className="space-y-2 text-center">
              <h2 className="text-xl font-semibold">Create your account</h2>
              <p className="text-sm text-muted-foreground">
                Sign up to enable sync across your devices
              </p>
            </div>

            <OAuthButtons
              onOAuthStart={handleOAuthStart}
              isLoading={isStartingOAuth}
              loadingProvider={oauthProvider}
              variant="stacked"
            />

            <OAuthDivider />

            <SignupForm
              onSubmit={handleSignup}
              isLoading={isSigningUp}
              error={error}
              defaultDeviceName={defaultDeviceName}
            />

            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{' '}
              <button onClick={goToLogin} className="text-primary hover:underline">
                Sign in
              </button>
            </p>
          </div>
        )

      case 'login':
        return (
          <div className="space-y-6">
            <div className="space-y-2 text-center">
              <h2 className="text-xl font-semibold">Welcome back</h2>
              <p className="text-sm text-muted-foreground">Sign in to your account</p>
            </div>

            <OAuthButtons
              onOAuthStart={handleOAuthStart}
              isLoading={isStartingOAuth}
              loadingProvider={oauthProvider}
              variant="stacked"
            />

            <OAuthDivider />

            <LoginForm
              onSubmit={handleLogin}
              onForgotPassword={goToForgotPassword}
              isLoading={isLoggingIn}
              error={error}
              defaultDeviceName={defaultDeviceName}
            />

            <p className="text-center text-sm text-muted-foreground">
              Don&apos;t have an account?{' '}
              <button onClick={goToSignup} className="text-primary hover:underline">
                Create one
              </button>
            </p>
          </div>
        )

      case 'forgot-password':
        return (
          <ForgotPasswordForm
            onSubmit={handleForgotPassword}
            onBack={() => setStep('login')}
            isLoading={isForgotPassword}
            error={error}
          />
        )

      case 'verification':
        return (
          <VerificationPending
            email={email}
            onResend={handleResendVerification}
            onVerifyToken={handleVerifyToken}
            onChangeEmail={goBack}
            isResending={isResending}
            isVerifying={isVerifying}
            error={error}
          />
        )

      case 'enter-phrase':
        return (
          <RecoveryPhraseInput
            onSubmit={handleEnterPhrase}
            isLoading={isLinkingViaRecovery}
            error={error}
          />
        )

      case 'recovery-phrase': {
        // Use OAuth result phrase if available (loopback flow), otherwise use hook
        const phraseToDisplay = oauthResult?.recoveryPhrase || recoveryPhrase
        if (isGeneratingPhrase || !phraseToDisplay) {
          return (
            <div className="flex flex-col items-center justify-center space-y-4 py-12">
              <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">Generating your recovery phrase...</p>
            </div>
          )
        }
        return (
          <RecoveryPhraseDisplay
            phrase={phraseToDisplay}
            onContinue={() => setStep('confirm-phrase')}
          />
        )
      }

      case 'confirm-phrase': {
        // Use OAuth result phrase if available (loopback flow), otherwise use hook
        const phraseToConfirm = oauthResult?.recoveryPhrase || recoveryPhrase
        if (!phraseToConfirm) {
          setStep('recovery-phrase')
          return null
        }
        return (
          <RecoveryPhraseConfirm
            phrase={phraseToConfirm}
            onConfirm={handleConfirmPhrase}
            onBack={goBack}
            isLoading={isConfirmingPhrase || isSettingUpDevice}
            error={error}
          />
        )
      }

      case 'link-device':
        return (
          <QRScanner
            onSubmit={handleLinkViaQR}
            onCancel={goBack}
            isLoading={linkViaQR.isPending}
            error={error}
          />
        )

      case 'link-pending':
        return linkingSessionId ? (
          <LinkingPending
            sessionId={linkingSessionId}
            onCancel={goBack}
            onApproved={() => {
              // Empty - let the wizard's useLinkingEvents handler manage navigation.
              // It properly waits for completeLinking() to succeed before showing 'complete'.
              // LinkingPending still shows the "Approved!" visual feedback.
            }}
            onRejected={(reason) => {
              setError(reason)
              setStep('link-device')
              setLinkingSessionId(null)
            }}
          />
        ) : null

      case 'complete':
        return (
          <div className="space-y-6 text-center">
            <div className="flex justify-center">
              <div className="rounded-full bg-green-100 p-4 dark:bg-green-900/30">
                <Shield className="size-12 text-green-600 dark:text-green-400" aria-hidden="true" />
              </div>
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">Setup Complete!</h2>
              <p className="text-muted-foreground">
                Your account is now set up with end-to-end encryption. Your data will sync securely
                across all your devices.
              </p>
            </div>
            {onComplete && (
              <Button onClick={onComplete} className="w-full" size="lg">
                Get Started
              </Button>
            )}
          </div>
        )

      default:
        return null
    }
  }

  const showBackButton = step !== 'welcome' && step !== 'complete'
  const showStepIndicator =
    step !== 'welcome' &&
    step !== 'complete' &&
    step !== 'forgot-password' &&
    step !== 'enter-phrase' &&
    step !== 'link-device' &&
    step !== 'link-pending'

  return (
    <div className={cn('mx-auto max-w-md space-y-6 p-6', className)}>
      {/* Back Button */}
      {showBackButton && (
        <Button variant="ghost" size="sm" onClick={goBack} className="-ml-2">
          <ChevronLeft className="mr-1 size-4" aria-hidden="true" />
          Back
        </Button>
      )}

      {/* Step Indicator */}
      {showStepIndicator && (
        <StepIndicator steps={stepNames} currentStep={currentStepIndex} className="mb-6" />
      )}

      {/* Step Content */}
      {renderStep()}
    </div>
  )
}

export default SetupWizard
