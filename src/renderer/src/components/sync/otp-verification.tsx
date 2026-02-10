import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import { OtpInput } from './otp-input'

interface OtpVerificationProps {
  email: string
  onVerify: (code: string) => void
  onResend: () => void
  onBack: () => void
  isVerifying: boolean
  isResending: boolean
  error: string | null
  expiresIn: number
}

export function OtpVerification({
  email,
  onVerify,
  onResend,
  onBack,
  isVerifying,
  isResending,
  error,
  expiresIn
}: OtpVerificationProps): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Enter verification code</h3>
        <p className="text-sm text-muted-foreground">
          We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>
        </p>
      </div>

      <OtpInput
        onComplete={onVerify}
        onResend={onResend}
        isVerifying={isVerifying}
        isResending={isResending}
        error={error}
        expiresIn={expiresIn}
      />

      <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
        <ArrowLeft className="w-4 h-4" />
        Use a different email
      </Button>
    </div>
  )
}
