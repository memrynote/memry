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
        <h3 className="font-display text-xl tracking-tight">Enter verification code</h3>
        <p className="font-serif text-[15px] text-muted-foreground leading-relaxed">
          We sent a 6-digit code to{' '}
          <span className="font-sans font-medium text-foreground">{email}</span>
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

      <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 text-muted-foreground">
        <ArrowLeft className="w-3.5 h-3.5" />
        Different email
      </Button>
    </div>
  )
}
