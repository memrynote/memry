import { useState, useCallback, type FormEvent } from 'react'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2 } from '@/lib/icons'

const emailSchema = z.string().email('Please enter a valid email address')

interface EmailEntryFormProps {
  onSubmit: (email: string) => void
  isLoading: boolean
  error: string | null
  defaultEmail?: string
}

export function EmailEntryForm({
  onSubmit,
  isLoading,
  error,
  defaultEmail
}: EmailEntryFormProps): React.JSX.Element {
  const [email, setEmail] = useState(defaultEmail ?? '')
  const [validationError, setValidationError] = useState<string | null>(null)

  const displayError = error ?? validationError

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      setValidationError(null)
      const result = emailSchema.safeParse(email.trim())
      if (!result.success) {
        setValidationError(result.error.issues[0].message)
        return
      }
      onSubmit(result.data)
    },
    [email, onSubmit]
  )

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="space-y-2.5">
        <Label
          htmlFor="email"
          className="uppercase tracking-[0.05em] text-[11px]/3.5 font-medium text-muted-foreground"
        >
          Email address
        </Label>
        <Input
          id="email"
          type="email"
          placeholder="Enter your email address..."
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setValidationError(null)
          }}
          disabled={isLoading}
          aria-describedby={displayError ? 'email-error' : undefined}
          aria-invalid={!!displayError}
          autoFocus
          className="h-9 text-sm focus-visible:border-[var(--tint)]/50"
        />
        {displayError && (
          <p id="email-error" className="text-sm text-destructive" role="alert">
            {displayError}
          </p>
        )}
      </div>
      <Button
        type="submit"
        className="w-full h-9 bg-background text-foreground border border-border hover:bg-accent"
        disabled={isLoading || !email.trim()}
      >
        {isLoading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Sending code...
          </>
        ) : (
          'Continue'
        )}
      </Button>
    </form>
  )
}
