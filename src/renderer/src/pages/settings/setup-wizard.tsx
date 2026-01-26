/**
 * Setup Wizard Page (T069, T069c, T119a)
 * Multi-step wizard for first device setup: auth -> recovery display -> recovery confirm -> complete
 * Also supports QR-based linking flow for new devices: auth -> qr-link -> qr-pending -> complete
 */

import { useState, useCallback, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Shield, Check, QrCode, KeyRound } from 'lucide-react'
import { EmailEntryForm } from '@/components/sync/email-entry-form'
import { OtpVerification } from '@/components/sync/otp-verification'
import { OAuthButtons } from '@/components/sync/oauth-buttons'
import { RecoveryPhraseDisplay } from '@/components/sync/recovery-phrase-display'
import { RecoveryPhraseConfirm } from '@/components/sync/recovery-phrase-confirm'
import { RecoveryPhraseEntry } from '@/components/sync/recovery-phrase-entry'
import { QRScanner } from '@/components/sync/qr-scanner'
import { LinkingPending } from '@/components/sync/linking-pending'
import type {
  RegisterExistingDeviceResponse,
  CompleteLinkingResponse
} from '@shared/contracts/ipc-sync'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/auth-context'
import type { SetupFirstDeviceResponse, ScanLinkingQRResponse } from '@shared/contracts/ipc-sync'
import type { Device } from '@shared/contracts/sync-api'

type WizardStep =
  | 'auth'
  | 'otp'
  | 'link-choice'
  | 'qr-link'
  | 'qr-pending'
  | 'recovery-display'
  | 'recovery-confirm'
  | 'recovery-entry'
  | 'complete'

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
  const { verifyOtp, requestOtp, resendOtp, startOAuth, markSetupComplete } = useAuth()
  const [step, setStep] = useState<WizardStep>('auth')
  const [email, setEmail] = useState('')
  const [recoveryPhrase, setRecoveryPhrase] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [setupResponse, setSetupResponse] = useState<SetupFirstDeviceResponse | null>(null)
  const [linkingSessionId, setLinkingSessionId] = useState<string | null>(null)
  const [linkingExpiresAt, setLinkingExpiresAt] = useState<number | null>(null)
  const [linkedDevice, setLinkedDevice] = useState<Device | null>(null)

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
          const isFirstDevice = response.isNewUser ?? false
          if (isFirstDevice) {
            try {
              const deviceInfo = getDeviceInfo()
              const setupResult: SetupFirstDeviceResponse =
                await window.api.sync.setupFirstDevice(deviceInfo)
              setSetupResponse(setupResult)
              setRecoveryPhrase(setupResult.recoveryPhrase)
              setStep('recovery-display')
            } catch (setupErr) {
              console.error('[SetupWizard] Device setup error:', setupErr)
              setError(setupErr instanceof Error ? setupErr.message : 'Device setup failed')
            }
          } else {
            setStep('link-choice')
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
        const isFirstDevice = response.isNewUser ?? false
        if (isFirstDevice) {
          try {
            const deviceInfo = getDeviceInfo()
            const setupResult: SetupFirstDeviceResponse =
              await window.api.sync.setupFirstDevice(deviceInfo)
            setSetupResponse(setupResult)
            setRecoveryPhrase(setupResult.recoveryPhrase)
            setStep('recovery-display')
          } catch (setupErr) {
            console.error('[SetupWizard] Device setup error:', setupErr)
            setError(setupErr instanceof Error ? setupErr.message : 'Device setup failed')
          }
        } else {
          setStep('link-choice')
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

  const handleRecoveryPhraseEntry = useCallback(async (phrase: string[]) => {
    setIsLoading(true)
    setError(undefined)
    try {
      const deviceInfo = getDeviceInfo()
      const response: RegisterExistingDeviceResponse = await window.api.sync.registerExistingDevice(
        {
          recoveryPhrase: phrase,
          ...deviceInfo
        }
      )
      if (response.success) {
        setStep('complete')
        toast.success('Device registered successfully!')
      } else {
        setError(response.error || 'Failed to register device')
      }
    } catch (err) {
      console.error('[SetupWizard] Recovery entry error:', err)
      setError(err instanceof Error ? err.message : 'Failed to register device')
    } finally {
      setIsLoading(false)
    }
  }, [])

  const handleBackToAuth = useCallback(() => {
    setStep('auth')
    setEmail('')
    setError(undefined)
  }, [])

  const handleBackToRecoveryDisplay = useCallback(() => {
    setStep('recovery-display')
    setError(undefined)
  }, [])

  const handleBackToLinkChoice = useCallback(() => {
    setStep('link-choice')
    setError(undefined)
    setLinkingSessionId(null)
    setLinkingExpiresAt(null)
  }, [])

  const handleChooseQRLink = useCallback(() => {
    setStep('qr-link')
    setError(undefined)
  }, [])

  const handleChooseRecoveryPhrase = useCallback(() => {
    setStep('recovery-entry')
    setError(undefined)
  }, [])

  const handleQRScanSuccess = useCallback(async (qrContent: string) => {
    setIsLoading(true)
    setError(undefined)

    try {
      const deviceInfo = getDeviceInfo()
      const response: ScanLinkingQRResponse = await window.api.sync.scanLinkingQR({
        qrContent,
        ...deviceInfo
      })

      if (!response.success) {
        setError(response.error ?? 'Failed to scan QR code')
        setIsLoading(false)
        return
      }

      if (!response.sessionId) {
        setError('Invalid QR code')
        setIsLoading(false)
        return
      }

      setLinkingSessionId(response.sessionId)

      let expiresAt: number
      try {
        const parsedQR = JSON.parse(qrContent) as { expiresAt?: number }
        expiresAt = parsedQR.expiresAt ?? Date.now() + 5 * 60 * 1000
      } catch {
        expiresAt = Date.now() + 5 * 60 * 1000
      }
      setLinkingExpiresAt(expiresAt)

      setStep('qr-pending')
    } catch (err) {
      console.error('[SetupWizard] QR scan error:', err)
      setError(err instanceof Error ? err.message : 'Failed to process QR code')
    } finally {
      setIsLoading(false)
    }
  }, [])

  const handleLinkingApproved = useCallback((response: CompleteLinkingResponse) => {
    if (response.device) {
      setLinkedDevice(response.device)
    }
    setStep('complete')
    toast.success('Device linked successfully!')
  }, [])

  const handleLinkingExpired = useCallback(() => {
    setError('The linking session has expired. Please scan a new QR code.')
    setStep('qr-link')
  }, [])

  const handleComplete = useCallback(() => {
    markSetupComplete()
    onComplete?.()
  }, [markSetupComplete, onComplete])

  const renderStepIndicator = (): React.JSX.Element => {
    const isQRFlow =
      step === 'qr-link' || step === 'qr-pending' || (step === 'link-choice' && linkedDevice)

    const steps = isQRFlow
      ? [
          { key: 'auth', label: 'Sign in' },
          { key: 'link', label: 'Link' },
          { key: 'complete', label: 'Done' }
        ]
      : [
          { key: 'auth', label: 'Sign in' },
          { key: 'recovery', label: 'Recovery' },
          { key: 'complete', label: 'Done' }
        ]

    const currentStepIndex =
      step === 'auth' || step === 'otp'
        ? 0
        : step === 'link-choice' ||
            step === 'qr-link' ||
            step === 'qr-pending' ||
            step === 'recovery-display' ||
            step === 'recovery-confirm' ||
            step === 'recovery-entry'
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
            <EmailEntryForm onSubmit={handleEmailSubmit} isLoading={isLoading} error={error} />
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

        {step === 'link-choice' && (
          <div className="space-y-4">
            <div className="text-center space-y-2">
              <h3 className="text-lg font-semibold">Link this device</h3>
              <p className="text-sm text-muted-foreground">
                Choose how you'd like to link this device to your existing account.
              </p>
            </div>

            <div className="space-y-3">
              <Button
                variant="outline"
                className="w-full justify-start h-auto py-4"
                onClick={handleChooseQRLink}
              >
                <QrCode className="w-5 h-5 mr-3 flex-shrink-0" />
                <div className="text-left">
                  <div className="font-medium">Scan QR code</div>
                  <div className="text-sm text-muted-foreground">
                    Scan a QR code from your existing device
                  </div>
                </div>
              </Button>

              <Button
                variant="outline"
                className="w-full justify-start h-auto py-4"
                onClick={handleChooseRecoveryPhrase}
              >
                <KeyRound className="w-5 h-5 mr-3 flex-shrink-0" />
                <div className="text-left">
                  <div className="font-medium">Enter recovery phrase</div>
                  <div className="text-sm text-muted-foreground">
                    Use your 24-word recovery phrase
                  </div>
                </div>
              </Button>
            </div>

            <Button variant="ghost" onClick={handleBackToAuth} className="w-full">
              Back
            </Button>
          </div>
        )}

        {step === 'qr-link' && (
          <QRScanner
            onScanSuccess={handleQRScanSuccess}
            onCancel={handleBackToLinkChoice}
            isLoading={isLoading}
            error={error}
          />
        )}

        {step === 'qr-pending' && linkingSessionId && linkingExpiresAt && (
          <LinkingPending
            sessionId={linkingSessionId}
            expiresAt={linkingExpiresAt}
            onApproved={handleLinkingApproved}
            onExpired={handleLinkingExpired}
            onCancel={handleBackToLinkChoice}
          />
        )}

        {step === 'recovery-entry' && (
          <RecoveryPhraseEntry
            onSubmit={handleRecoveryPhraseEntry}
            onBack={handleBackToLinkChoice}
            isLoading={isLoading}
            error={error}
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

            {linkedDevice && (
              <div className="p-4 bg-muted rounded-lg text-sm text-left space-y-2">
                <p>
                  <span className="text-muted-foreground">Device:</span>{' '}
                  <span className="font-medium">{linkedDevice.name}</span>
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
