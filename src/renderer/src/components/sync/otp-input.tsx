import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator } from '@/components/ui/input-otp'
import { Loader2 } from 'lucide-react'

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
    },
    [clearTimer]
  )

  useEffect(() => {
    if (seconds <= 0) return
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
    <div className="space-y-4">
      <div className="flex justify-center">
        <InputOTP
          maxLength={6}
          value={value}
          onChange={handleChange}
          disabled={isVerifying}
          autoFocus
        >
          <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
            <InputOTPSlot index={2} />
          </InputOTPGroup>
          <InputOTPSeparator />
          <InputOTPGroup>
            <InputOTPSlot index={3} />
            <InputOTPSlot index={4} />
            <InputOTPSlot index={5} />
          </InputOTPGroup>
        </InputOTP>
      </div>

      {isVerifying && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Verifying...
        </div>
      )}

      {error && <p className="text-sm text-destructive text-center">{error}</p>}

      <div className="text-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={reset}
          disabled={!canResend || isResending || isVerifying}
        >
          {isResending ? (
            <>
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
              Resending...
            </>
          ) : canResend ? (
            'Resend code'
          ) : (
            `Resend in ${seconds}s`
          )}
        </Button>
      </div>
    </div>
  )
}
