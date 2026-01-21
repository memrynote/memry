/**
 * OTP Input Component (T065, T065a)
 * 6-digit OTP input with auto-focus, paste support, and countdown timer
 */

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type KeyboardEvent,
  type ClipboardEvent
} from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

const OTP_LENGTH = 6
const RESEND_COOLDOWN_SECONDS = 60

interface OtpInputProps {
  onComplete: (code: string) => void
  onResend?: () => Promise<void>
  isLoading: boolean
  error?: string
  className?: string
}

export function OtpInput({
  onComplete,
  onResend,
  isLoading,
  error,
  className
}: OtpInputProps): React.JSX.Element {
  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(''))
  const [countdown, setCountdown] = useState(0)
  const [isResending, setIsResending] = useState(false)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    inputRefs.current[0]?.focus()
  }, [])

  useEffect(() => {
    if (countdown <= 0) return

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer)
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [countdown])

  const handleChange = useCallback(
    (index: number, value: string) => {
      if (!/^\d*$/.test(value)) return

      const digit = value.slice(-1)
      const newDigits = [...digits]
      newDigits[index] = digit
      setDigits(newDigits)

      if (digit && index < OTP_LENGTH - 1) {
        inputRefs.current[index + 1]?.focus()
      }

      const code = newDigits.join('')
      if (code.length === OTP_LENGTH && newDigits.every((d) => d !== '')) {
        onComplete(code)
      }
    },
    [digits, onComplete]
  )

  const handleKeyDown = useCallback(
    (index: number, e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Backspace') {
        if (!digits[index] && index > 0) {
          inputRefs.current[index - 1]?.focus()
          const newDigits = [...digits]
          newDigits[index - 1] = ''
          setDigits(newDigits)
        } else {
          const newDigits = [...digits]
          newDigits[index] = ''
          setDigits(newDigits)
        }
      } else if (e.key === 'ArrowLeft' && index > 0) {
        inputRefs.current[index - 1]?.focus()
      } else if (e.key === 'ArrowRight' && index < OTP_LENGTH - 1) {
        inputRefs.current[index + 1]?.focus()
      }
    },
    [digits]
  )

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault()
      const pastedData = e.clipboardData.getData('text').trim()
      const pastedDigits = pastedData.replace(/\D/g, '').slice(0, OTP_LENGTH)

      if (pastedDigits.length > 0) {
        const newDigits = [...digits]
        for (let i = 0; i < pastedDigits.length; i++) {
          newDigits[i] = pastedDigits[i]
        }
        setDigits(newDigits)

        const focusIndex = Math.min(pastedDigits.length, OTP_LENGTH - 1)
        inputRefs.current[focusIndex]?.focus()

        if (pastedDigits.length === OTP_LENGTH) {
          onComplete(pastedDigits)
        }
      }
    },
    [digits, onComplete]
  )

  const handleResend = useCallback(async () => {
    if (!onResend || countdown > 0 || isResending) return

    setIsResending(true)
    try {
      await onResend()
      setCountdown(RESEND_COOLDOWN_SECONDS)
      setDigits(Array(OTP_LENGTH).fill(''))
      inputRefs.current[0]?.focus()
    } finally {
      setIsResending(false)
    }
  }, [onResend, countdown, isResending])

  const formatCountdown = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex justify-center gap-2">
        {digits.map((digit, index) => (
          <Input
            key={index}
            ref={(el) => {
              inputRefs.current[index] = el
            }}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={digit}
            onChange={(e) => handleChange(index, e.target.value)}
            onKeyDown={(e) => handleKeyDown(index, e)}
            onPaste={handlePaste}
            disabled={isLoading}
            className={cn(
              'w-12 h-14 text-center text-xl font-semibold',
              error && 'border-destructive'
            )}
            autoComplete="one-time-code"
          />
        ))}
      </div>

      {error && <p className="text-sm text-destructive text-center">{error}</p>}

      {isLoading && (
        <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Verifying...
        </div>
      )}

      {onResend && (
        <div className="flex items-center justify-center">
          {countdown > 0 ? (
            <p className="text-sm text-muted-foreground">
              Resend code in {formatCountdown(countdown)}
            </p>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResend}
              disabled={isResending || isLoading}
            >
              {isResending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-2" />
              )}
              Resend code
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export default OtpInput
