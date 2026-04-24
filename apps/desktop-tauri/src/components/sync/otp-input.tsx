import { useState, useEffect, useCallback, useRef } from 'react'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Loader2, Clock } from '@/lib/icons'
import { subscribeEvent } from '@/lib/ipc/forwarder'

interface OtpInputProps {
  onComplete: (code: string) => void
  onResend: () => void
  onBack: () => void
  isVerifying: boolean
  isResending: boolean
  error: string | null
  expiresIn: number
}

function formatCountdown(s: number): string {
  const mins = Math.floor(s / 60)
  const secs = s % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function useCountdown(
  initialSeconds: number,
  onResend: () => void
): {
  seconds: number
  canResend: boolean
  reset: () => void
} {
  const [seconds, setSeconds] = useState(initialSeconds)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  useEffect(() => {
    if (seconds <= 0 || intervalRef.current) return clearTimer

    intervalRef.current = setInterval(() => {
      setSeconds((prev) => {
        if (prev <= 1) {
          clearTimer()
          return 0
        }

        return prev - 1
      })
    }, 1000)

    return clearTimer
  }, [seconds, clearTimer])

  const reset = useCallback(() => {
    onResend()
    clearTimer()
    setSeconds(60)
  }, [onResend, clearTimer])

  return { seconds, canResend: seconds === 0, reset }
}

function OtpInputSession({
  onComplete,
  onResend,
  onBack,
  isVerifying,
  isResending,
  error,
  expiresIn
}: OtpInputProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const { seconds, canResend, reset } = useCountdown(expiresIn, onResend)

  useEffect(() => {
    const unsubscribe = subscribeEvent<{ code: string }>('otp-detected', (event) => {
      if (event.code && /^\d{6}$/.test(event.code)) {
        setValue(event.code)
        onComplete(event.code)
      }
    })
    return unsubscribe
  }, [onComplete])

  const handleChange = useCallback(
    (newValue: string) => {
      setValue(newValue)
      if (newValue.length === 6) {
        onComplete(newValue)
      }
    },
    [onComplete]
  )

  const slotClassName =
    'h-14 w-12 rounded-lg bg-foreground/[0.03] border border-foreground/10 data-[filled]:border-[var(--tint)]/40 font-mono font-medium text-[22px]/7 shadow-none'

  return (
    <div className="space-y-5">
      <div className="flex justify-center pb-1">
        <InputOTP
          maxLength={6}
          value={value}
          onChange={handleChange}
          disabled={isVerifying}
          autoFocus
          aria-label="6-digit verification code"
        >
          <InputOTPGroup className="gap-1.5">
            {[0, 1, 2].map((i) => (
              <InputOTPSlot
                key={`otp-${i}`}
                index={i}
                className={slotClassName}
                style={{ animationDelay: `${i * 60}ms` }}
              />
            ))}
          </InputOTPGroup>

          <div className="flex items-center justify-center w-5" role="separator" aria-hidden="true">
            <div className="size-1 rounded-xs bg-muted-foreground/50" />
          </div>

          <InputOTPGroup className="gap-1.5">
            {[3, 4, 5].map((i) => (
              <InputOTPSlot
                key={`otp-${i}`}
                index={i}
                className={slotClassName}
                style={{ animationDelay: `${(i + 1) * 60}ms` }}
              />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </div>

      {isVerifying && (
        <div
          className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
          role="status"
          aria-label="Verifying code"
        >
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          Verifying...
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive text-center" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col items-center gap-3">
        {isResending ? (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span className="text-xs">Resending...</span>
          </div>
        ) : canResend ? (
          <button
            type="button"
            onClick={reset}
            disabled={isVerifying}
            className="text-[var(--tint)] text-[13px] hover:underline disabled:opacity-50"
          >
            Resend code
          </button>
        ) : (
          <div className="flex items-center gap-1.5 text-muted-foreground/70">
            <Clock className="w-3 h-3" />
            <span className="text-xs tabular-nums">Resend in {formatCountdown(seconds)}</span>
          </div>
        )}
        <button
          type="button"
          onClick={onBack}
          className="text-[var(--tint)] text-[13px] hover:underline"
        >
          Use a different email
        </button>
      </div>
    </div>
  )
}

export function OtpInput(props: OtpInputProps): React.JSX.Element {
  const sessionKey = `${props.error ?? 'ok'}:${props.expiresIn}`
  return <OtpInputSession key={sessionKey} {...props} />
}
