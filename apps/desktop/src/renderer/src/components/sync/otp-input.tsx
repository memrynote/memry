import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Loader2 } from '@/lib/icons'

interface OtpInputProps {
  onComplete: (code: string) => void
  onResend: () => void
  isVerifying: boolean
  isResending: boolean
  error: string | null
  expiresIn: number
}

function useCountdown(onResend: () => void): {
  seconds: number
  canResend: boolean
  reset: () => void
  start: (s: number) => void
} {
  const [seconds, setSeconds] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const start = useCallback(
    (s: number) => {
      clearTimer()
      setSeconds(s)
      intervalRef.current = setInterval(() => {
        setSeconds((prev) => {
          if (prev <= 1) {
            if (intervalRef.current) {
              clearInterval(intervalRef.current)
              intervalRef.current = null
            }
            return 0
          }
          return prev - 1
        })
      }, 1000)
    },
    [clearTimer]
  )

  useEffect(() => {
    return clearTimer
  }, [clearTimer])

  const reset = useCallback(() => {
    onResend()
    start(60)
  }, [onResend, start])

  return { seconds, canResend: seconds === 0, reset, start }
}

export function OtpInput({
  onComplete,
  onResend,
  isVerifying,
  isResending,
  error,
  expiresIn
}: OtpInputProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const { seconds, canResend, reset, start } = useCountdown(onResend)
  const startedRef = useRef(false)
  const prevErrorRef = useRef<string | null>(null)

  if (error && error !== prevErrorRef.current) {
    setValue('')
  }
  prevErrorRef.current = error

  useEffect(() => {
    if (!startedRef.current && expiresIn > 0) {
      start(expiresIn)
      startedRef.current = true
    }
  }, [expiresIn, start])

  useEffect(() => {
    const unsubscribe = window.api.onOtpDetected((event) => {
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

  return (
    <div className="space-y-5">
      <div className="flex justify-center">
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
                className="h-12 w-11 text-lg font-semibold border rounded-lg"
                style={{ animationDelay: `${i * 60}ms` }}
              />
            ))}
          </InputOTPGroup>

          <div className="flex items-center px-2" role="separator" aria-hidden="true">
            <div className="w-1.5 h-1.5 rounded-full bg-border" />
          </div>

          <InputOTPGroup className="gap-1.5">
            {[3, 4, 5].map((i) => (
              <InputOTPSlot
                key={`otp-${i}`}
                index={i}
                className="h-12 w-11 text-lg font-semibold border rounded-lg"
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

      <div className="text-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={reset}
          disabled={!canResend || isResending || isVerifying}
          className="text-muted-foreground"
        >
          {isResending ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              Resending...
            </>
          ) : canResend ? (
            'Resend code'
          ) : (
            <span className="tabular-nums">Resend in {seconds}s</span>
          )}
        </Button>
      </div>
    </div>
  )
}
