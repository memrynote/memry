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
      <div className="flex flex-col pb-1 gap-1.5">
        <div className="tracking-[-0.02em] font-semibold text-xl/6.5 text-foreground">
          Enter verification code
        </div>
        <div className="text-[13px]/4.5">
          <span className="text-muted-foreground/60">We sent a 6-digit code to </span>
          <span className="text-muted-foreground">{email}</span>
        </div>
      </div>

      <OtpInput
        onComplete={onVerify}
        onResend={onResend}
        onBack={onBack}
        isVerifying={isVerifying}
        isResending={isResending}
        error={error}
        expiresIn={expiresIn}
      />
    </div>
  )
}
