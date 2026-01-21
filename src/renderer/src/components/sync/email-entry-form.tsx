/**
 * Email Entry Form (T064)
 * Email input with validation for OTP authentication
 */

import { useState, useCallback, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, Mail } from 'lucide-react'
import { cn } from '@/lib/utils'

interface EmailEntryFormProps {
  onSubmit: (email: string) => Promise<void>
  isLoading: boolean
  error?: string
  className?: string
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function EmailEntryForm({
  onSubmit,
  isLoading,
  error,
  className
}: EmailEntryFormProps): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()

      const trimmedEmail = email.trim().toLowerCase()

      if (!trimmedEmail) {
        setValidationError('Email is required')
        return
      }

      if (!EMAIL_REGEX.test(trimmedEmail)) {
        setValidationError('Please enter a valid email address')
        return
      }

      setValidationError(null)
      await onSubmit(trimmedEmail)
    },
    [email, onSubmit]
  )

  const displayError = validationError || error

  return (
    <form onSubmit={handleSubmit} className={cn('space-y-4', className)}>
      <div className="space-y-2">
        <Label htmlFor="email">Email address</Label>
        <div className="relative">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              if (validationError) setValidationError(null)
            }}
            disabled={isLoading}
            className={cn('pl-10', displayError && 'border-destructive')}
            autoComplete="email"
            autoFocus
          />
        </div>
        {displayError && <p className="text-sm text-destructive">{displayError}</p>}
      </div>

      <Button type="submit" className="w-full" disabled={isLoading || !email.trim()}>
        {isLoading ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Sending code...
          </>
        ) : (
          'Send verification code'
        )}
      </Button>
    </form>
  )
}

export default EmailEntryForm
