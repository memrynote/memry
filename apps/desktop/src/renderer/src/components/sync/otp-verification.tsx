import { OtpInput } from './otp-input'
import { useT } from '@memry/i18n/renderer'

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
  const { t } = useT('settings')

  return (
    <div className="space-y-6">
      <div className="flex flex-col pb-1 gap-1.5">
        <div className="tracking-[-0.02em] font-semibold text-xl/6.5 text-foreground">
          {t('setup.otp.title')}
        </div>
        <div className="text-[13px]/4.5">
          <span className="text-muted-foreground/60">{t('setup.otp.sentTo')}</span>
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
