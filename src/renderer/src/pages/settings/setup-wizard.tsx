/**
 * Setup Wizard Page (T069, T069c)
 * Multi-step wizard for first device setup: auth -> recovery display -> recovery confirm -> complete
 */

import { useState, useCallback, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Shield, Check } from 'lucide-react'
import { EmailEntryForm } from '@/components/sync/email-entry-form'
import { OtpVerification } from '@/components/sync/otp-verification'
import { OAuthButtons } from '@/components/sync/oauth-buttons'
import { RecoveryPhraseDisplay } from '@/components/sync/recovery-phrase-display'
import { RecoveryPhraseConfirm } from '@/components/sync/recovery-phrase-confirm'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import type { SetupFirstDeviceResponse } from '@shared/contracts/ipc-sync'

type WizardStep = 'auth' | 'otp' | 'recovery-display' | 'recovery-confirm' | 'complete'

interface SetupWizardProps {
  onComplete?: () => void
  className?: string
}

function getDeviceInfo(): {
  deviceName: string
  platform: 'macos' | 'windows' | 'linux'
  osVersion: string
  appVersion: string
} {
  const platform = navigator.platform.toLowerCase()
  let devicePlatform: 'macos' | 'windows' | 'linux' = 'macos'

  if (platform.includes('win')) {
    devicePlatform = 'windows'
  } else if (platform.includes('linux')) {
    devicePlatform = 'linux'
  }

  return {
    deviceName: `${devicePlatform === 'macos' ? 'Mac' : devicePlatform === 'windows' ? 'Windows PC' : 'Linux PC'}`,
    platform: devicePlatform,
    osVersion: navigator.userAgent,
    appVersion: '1.0.0'
  }
}

export function SetupWizard({ onComplete, className }: SetupWizardProps): React.JSX.Element {
  const { verifyOtp, requestOtp, resendOtp, startOAuth } = useAuth()
  const [step, setStep] = useState<WizardStep>('auth')
  const [email, setEmail] = useState('')
  const [recoveryPhrase, setRecoveryPhrase] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [setupResponse, setSetupResponse] = useState<SetupFirstDeviceResponse | null>(null)

  useEffect(() => {
    setError(undefined)
  }, [step])

  const handleEmailSubmit = useCallback(
    async (submittedEmail: string) => {
      setIsLoading(true)
      setError(undefined)
      try {
        const response = await requestOtp(submittedEmail)
        if (response.success) {
          setEmail(submittedEmail)
          setStep('otp')
        } else {
          setError(response.error || 'Failed to send verification code')
        }
      } catch (err) {
        console.error('[SetupWizard] Email submit error:', err)
        setError('Failed to send verification code')
      } finally {
        setIsLoading(false)
      }
    },
    [requestOtp]
  )

  const handleOtpVerify = useCallback(
    async (code: string) => {
      setIsLoading(true)
      setError(undefined)
      try {
        const response = await verifyOtp(email, code)
        if (response.success) {
          if (response.needsSetup) {
            const deviceInfo = getDeviceInfo()
            const setupResult: SetupFirstDeviceResponse =
              await window.api.sync.setupFirstDevice(deviceInfo)
            setSetupResponse(setupResult)
            setRecoveryPhrase(setupResult.recoveryPhrase)
            setStep('recovery-display')
          } else {
            setStep('complete')
          }
        } else {
          setError(response.error || 'Invalid verification code')
        }
      } catch (err) {
        console.error('[SetupWizard] OTP verify error:', err)
        setError('Failed to verify code')
      } finally {
        setIsLoading(false)
      }
    },
    [email, verifyOtp]
  )

  const handleResendOtp = useCallback(async () => {
    setError(undefined)
    try {
      const response = await resendOtp(email)
      if (response.success) {
        toast.success('Verification code sent')
      } else {
        setError(response.error || 'Failed to resend code')
      }
    } catch (err) {
      console.error('[SetupWizard] Resend OTP error:', err)
      setError('Failed to resend code')
    }
  }, [email, resendOtp])

  const handleOAuthGoogle = useCallback(async () => {
    setIsLoading(true)
    setError(undefined)
    try {
      const response = await startOAuth('google')
      if (response.success) {
        if (response.isNewUser) {
          const deviceInfo = getDeviceInfo()
          const setupResult: SetupFirstDeviceResponse =
            await window.api.sync.setupFirstDevice(deviceInfo)
          setSetupResponse(setupResult)
          setRecoveryPhrase(setupResult.recoveryPhrase)
          setStep('recovery-display')
        } else {
          setStep('complete')
        }
      } else {
        setError(response.error || 'Google sign-in failed')
      }
    } catch (err) {
      console.error('[SetupWizard] OAuth error:', err)
      setError('Google sign-in failed')
    } finally {
      setIsLoading(false)
    }
  }, [startOAuth])

  const handleRecoveryDisplayContinue = useCallback(() => {
    setStep('recovery-confirm')
  }, [])

  const handleRecoveryConfirmed = useCallback(async () => {
    setIsLoading(true)
    setError(undefined)
    try {
      const response = await window.api.sync.verifyRecoveryPhrase({ phrase: recoveryPhrase })
      if (response.valid) {
        setStep('complete')
        toast.success('Device setup complete!')
      } else {
        setError(response.error || 'Recovery phrase verification failed')
      }
    } catch (err) {
      console.error('[SetupWizard] Recovery verify error:', err)
      setError('Failed to verify recovery phrase')
    } finally {
      setIsLoading(false)
    }
  }, [recoveryPhrase])

  const handleBackToAuth = useCallback(() => {
    setStep('auth')
    setEmail('')
    setError(undefined)
  }, [])

  const handleBackToRecoveryDisplay = useCallback(() => {
    setStep('recovery-display')
    setError(undefined)
  }, [])

  const handleComplete = useCallback(() => {
    onComplete?.()
  }, [onComplete])

  const renderStepIndicator = (): React.JSX.Element => {
    const steps = [
      { key: 'auth', label: 'Sign in' },
      { key: 'recovery', label: 'Recovery' },
      { key: 'complete', label: 'Done' }
    ]

    const currentStepIndex =
      step === 'auth' || step === 'otp'
        ? 0
        : step === 'recovery-display' || step === 'recovery-confirm'
          ? 1
          : 2

    return (
      <div className="flex items-center justify-center gap-2 mb-6">
        {steps.map((s, index) => (
          <div key={s.key} className="flex items-center gap-2">
            <div
              className={cn(
                'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium border-2 transition-colors',
                index < currentStepIndex
                  ? 'bg-primary text-primary-foreground border-primary'
                  : index === currentStepIndex
                    ? 'border-primary text-primary'
                    : 'border-muted text-muted-foreground'
              )}
            >
              {index < currentStepIndex ? <Check className="w-4 h-4" /> : index + 1}
            </div>
            <span
              className={cn(
                'text-sm hidden sm:inline',
                index <= currentStepIndex ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {s.label}
            </span>
            {index < steps.length - 1 && (
              <div
                className={cn(
                  'w-8 h-0.5 mx-2',
                  index < currentStepIndex ? 'bg-primary' : 'bg-muted'
                )}
              />
            )}
          </div>
        ))}
      </div>
    )
  }

  return (
    <Card className={cn('w-full max-w-md mx-auto', className)}>
      <CardHeader className="text-center">
        <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
          <Shield className="w-6 h-6 text-primary" />
        </div>
        <CardTitle>Set up secure sync</CardTitle>
        <CardDescription>
          End-to-end encrypted sync keeps your data safe across all your devices
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {renderStepIndicator()}

        {step === 'auth' && (
          <div className="space-y-4">
            <OAuthButtons onGoogleClick={handleOAuthGoogle} isLoading={isLoading} error={error} />
            <EmailEntryForm
              onSubmit={handleEmailSubmit}
              isLoading={isLoading}
              error={error ? undefined : undefined}
            />
          </div>
        )}

        {step === 'otp' && (
          <OtpVerification
            email={email}
            onVerify={handleOtpVerify}
            onResend={handleResendOtp}
            onBack={handleBackToAuth}
            isLoading={isLoading}
            error={error}
          />
        )}

        {step === 'recovery-display' && (
          <RecoveryPhraseDisplay
            phrase={recoveryPhrase}
            onContinue={handleRecoveryDisplayContinue}
          />
        )}

        {step === 'recovery-confirm' && (
          <RecoveryPhraseConfirm
            phrase={recoveryPhrase}
            onConfirmed={handleRecoveryConfirmed}
            onBack={handleBackToRecoveryDisplay}
            isLoading={isLoading}
          />
        )}

        {step === 'complete' && (
          <div className="text-center space-y-6">
            <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center mx-auto">
              <Check className="w-8 h-8 text-green-500" />
            </div>

            <div className="space-y-2">
              <h3 className="text-lg font-semibold">You're all set!</h3>
              <p className="text-sm text-muted-foreground">
                Your device is now set up with end-to-end encrypted sync. Your data will be securely
                synced across all your devices.
              </p>
            </div>

            {setupResponse && (
              <div className="p-4 bg-muted rounded-lg text-sm text-left space-y-2">
                <p>
                  <span className="text-muted-foreground">Device:</span>{' '}
                  <span className="font-medium">{setupResponse.device.name}</span>
                </p>
                <p>
                  <span className="text-muted-foreground">Account:</span>{' '}
                  <span className="font-medium">{setupResponse.user.email}</span>
                </p>
              </div>
            )}

            <Button className="w-full" onClick={handleComplete}>
              Continue to app
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export default SetupWizard
