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
          className="text-[11px] font-semibold tracking-widest uppercase text-muted-foreground"
        >
          Email address
        </Label>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setValidationError(null)
          }}
          disabled={isLoading}
          aria-describedby={displayError ? 'email-error' : undefined}
          aria-invalid={!!displayError}
          autoFocus
          className="h-11 text-[15px] focus-visible:ring-amber-600/15 focus-visible:border-amber-600/50 dark:focus-visible:ring-amber-400/10 dark:focus-visible:border-amber-400/40"
        />
        {displayError && (
          <p id="email-error" className="text-sm text-destructive" role="alert">
            {displayError}
          </p>
        )}
      </div>
      <Button type="submit" className="w-full h-11" disabled={isLoading || !email.trim()}>
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
