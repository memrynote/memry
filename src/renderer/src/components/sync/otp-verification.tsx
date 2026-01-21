/**
 * OTP Verification Screen (T065b)
 * Full screen composition with back button, email display, OTP input, and clipboard detection
 */

import { useState, useCallback, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import { OtpInput } from './otp-input'
import { cn } from '@/lib/utils'

interface OtpVerificationProps {
  email: string
  onVerify: (code: string) => Promise<void>
  onResend: () => Promise<void>
  onBack: () => void
  isLoading: boolean
  error?: string
  className?: string
}

export function OtpVerification({
  email,
  onVerify,
  onResend,
  onBack,
  isLoading,
  error,
  className
}: OtpVerificationProps): React.JSX.Element {
  const [detectedCode, setDetectedCode] = useState<string | null>(null)

  useEffect(() => {
    const checkClipboard = async (): Promise<void> => {
      try {
        const result = await window.api.auth.detectOtpClipboard()
        if (result.code) {
          setDetectedCode(result.code)
        }
      } catch (err) {
        console.error('[OtpVerification] Failed to detect clipboard:', err)
      }
    }

    checkClipboard()

    const interval = setInterval(checkClipboard, 2000)
    return () => clearInterval(interval)
  }, [])

  const handleComplete = useCallback(
    async (code: string) => {
      await onVerify(code)
    },
    [onVerify]
  )

  const handleUseDetectedCode = useCallback(async () => {
    if (detectedCode) {
      await onVerify(detectedCode)
      setDetectedCode(null)
    }
  }, [detectedCode, onVerify])

  return (
    <div className={cn('space-y-6', className)}>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onBack} disabled={isLoading}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <span className="text-sm text-muted-foreground">Back</span>
      </div>

      <div className="text-center space-y-2">
        <h2 className="text-xl font-semibold">Enter verification code</h2>
        <p className="text-sm text-muted-foreground">
          We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>
        </p>
      </div>

      {detectedCode && !isLoading && (
        <div className="p-3 bg-muted rounded-lg text-center space-y-2">
          <p className="text-sm text-muted-foreground">Code detected in clipboard</p>
          <Button variant="secondary" size="sm" onClick={handleUseDetectedCode}>
            Use code: {detectedCode}
          </Button>
        </div>
      )}

      <OtpInput
        onComplete={handleComplete}
        onResend={onResend}
        isLoading={isLoading}
        error={error}
      />
    </div>
  )
}

export default OtpVerification
