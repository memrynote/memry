import { useState, useCallback, useEffect, useRef, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ArrowLeft, KeyRound, Loader2 } from '@/lib/icons'

interface RecoveryPhraseInputProps {
  onSubmit: (phrase: string) => void
  isLoading: boolean
  error: string | null
  onBack: () => void
}

const PROGRESS_STEPS = [
  'Deriving encryption keys...',
  'Validating recovery phrase...',
  'Registering device...'
] as const

const STEP_INTERVAL_MS = 2000

const EXPECTED_WORD_COUNT = 24

export function RecoveryPhraseInput({
  onSubmit,
  isLoading,
  error,
  onBack
}: RecoveryPhraseInputProps): React.JSX.Element {
  const [phrase, setPhrase] = useState('')
  const [progressStep, setProgressStep] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!isLoading) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      return
    }

    intervalRef.current = setInterval(() => {
      setProgressStep((prev) => Math.min(prev + 1, PROGRESS_STEPS.length - 1))
    }, STEP_INTERVAL_MS)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [isLoading])

  const wordCount = phrase.trim() ? phrase.trim().split(/\s+/).length : 0
  const isValidLength = wordCount === EXPECTED_WORD_COUNT

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      setProgressStep(0)
      const normalized = phrase.trim().toLowerCase().replace(/\s+/g, ' ')
      onSubmit(normalized)
    },
    [phrase, onSubmit]
  )

  return (
    <div className="wizard-step-enter space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2.5 mb-1">
          <div className="w-9 h-9 rounded-xl bg-amber-500/10 dark:bg-amber-400/10 flex items-center justify-center">
            <KeyRound className="w-4.5 h-4.5 text-amber-700 dark:text-amber-400" />
          </div>
          <h3 className="font-display text-xl tracking-tight">Enter recovery phrase</h3>
        </div>
        <p className="font-serif text-[15px] text-muted-foreground leading-relaxed">
          This device was previously signed out. Enter your 24-word recovery phrase to restore
          access to your encrypted data.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <Label
              htmlFor="recovery-phrase"
              className="text-[11px] font-semibold tracking-widest uppercase text-muted-foreground"
            >
              Recovery phrase
            </Label>
            <span className="text-[11px] tabular-nums text-muted-foreground/70">
              {wordCount} / {EXPECTED_WORD_COUNT} words
            </span>
          </div>
          <textarea
            id="recovery-phrase"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            disabled={isLoading}
            placeholder="Enter your 24-word recovery phrase separated by spaces..."
            rows={4}
            autoFocus
            aria-describedby={error ? 'recovery-error' : undefined}
            aria-invalid={!!error}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2.5 text-[15px] font-mono leading-relaxed ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-600/15 focus-visible:border-amber-600/50 dark:focus-visible:ring-amber-400/10 dark:focus-visible:border-amber-400/40 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
          />
          {error && (
            <p id="recovery-error" className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onBack}
            disabled={isLoading}
            className="gap-1.5 text-muted-foreground"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back
          </Button>
          <Button type="submit" className="flex-1 h-11" disabled={isLoading || !isValidLength}>
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {PROGRESS_STEPS[progressStep]}
              </>
            ) : (
              'Restore access'
            )}
          </Button>
        </div>
      </form>
    </div>
  )
}
