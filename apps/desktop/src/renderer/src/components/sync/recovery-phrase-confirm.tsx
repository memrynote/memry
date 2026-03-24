import { useState, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Check, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface RecoveryPhraseConfirmProps {
  phrase: string
  onConfirmed: () => void
  onBack: () => void
}

const MIN_GAP = 2

function pickRandomIndices(wordCount: number): [number, number, number] {
  const arr = new Uint32Array(3)
  const maxAttempts = 1000
  for (let i = 0; i < maxAttempts; i++) {
    crypto.getRandomValues(arr)
    const indices = Array.from(arr).map((v) => v % wordCount)
    indices.sort((a, b) => a - b)
    const [a, b, c] = indices
    if (a !== b && b !== c && b - a >= MIN_GAP && c - b >= MIN_GAP) {
      return [a, b, c] as [number, number, number]
    }
  }
  return [0, Math.floor(wordCount / 2), wordCount - 1]
}

export function RecoveryPhraseConfirm({
  phrase,
  onConfirmed,
  onBack
}: RecoveryPhraseConfirmProps): React.JSX.Element {
  const words = useMemo(() => phrase.split(' '), [phrase])
  const indices = useMemo(() => pickRandomIndices(words.length), [words.length])

  const [inputs, setInputs] = useState<[string, string, string]>(['', '', ''])
  const [touched, setTouched] = useState<[boolean, boolean, boolean]>([false, false, false])

  const matches = useMemo(
    () =>
      indices.map((idx, i) => inputs[i].trim().toLowerCase() === words[idx].toLowerCase()) as [
        boolean,
        boolean,
        boolean
      ],
    [indices, inputs, words]
  )

  const allCorrect = matches.every(Boolean)

  const handleChange = useCallback((slotIndex: number, value: string) => {
    setInputs((prev) => {
      const next = [...prev] as [string, string, string]
      next[slotIndex] = value
      return next
    })
  }, [])

  const handleBlur = useCallback((slotIndex: number) => {
    setTouched((prev) => {
      const next = [...prev] as [boolean, boolean, boolean]
      next[slotIndex] = true
      return next
    })
  }, [])

  return (
    <div className="[font-synthesis:none] flex flex-col antialiased text-xs/4">
      <div className="wizard-step-enter flex flex-col pb-7 gap-1.5">
        <div className="tracking-[-0.02em] font-semibold text-xl/6.5 text-foreground">
          Confirm your recovery phrase
        </div>
        <div className="text-[13px]/4.5 text-muted-foreground">
          Enter the requested words to verify you&apos;ve saved it correctly.
        </div>
      </div>

      <div className="flex flex-col pb-7 gap-3 wizard-step-enter wiz-delay-2">
        {indices.map((wordIndex, slotIndex) => {
          const showFeedback = touched[slotIndex] && inputs[slotIndex].trim().length > 0
          const isCorrect = matches[slotIndex]

          return (
            <div key={wordIndex} className="flex items-center gap-2.5">
              <input
                type="text"
                value={inputs[slotIndex]}
                onChange={(e) => handleChange(slotIndex, e.target.value)}
                onBlur={() => handleBlur(slotIndex)}
                placeholder={`Enter word #${wordIndex + 1}`}
                autoFocus={slotIndex === 0}
                className={cn(
                  'flex-1 h-9 rounded-lg px-3.5 font-mono text-sm/4.5 bg-foreground/[0.03] border outline-none transition-colors',
                  'placeholder:text-muted-foreground/50',
                  'focus-visible:border-[var(--tint)]/50',
                  showFeedback && isCorrect && 'border-green-500/40',
                  showFeedback && !isCorrect && 'border-destructive/40',
                  !showFeedback && 'border-foreground/10'
                )}
              />
              {showFeedback ? (
                isCorrect ? (
                  <Check className="w-4 h-4 text-green-500 shrink-0" />
                ) : (
                  <X className="w-4 h-4 text-destructive shrink-0" />
                )
              ) : (
                <div className="shrink-0 size-4" />
              )}
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-2.5 wizard-step-enter wiz-delay-3">
        <Button variant="outline" onClick={onBack} className="h-9 px-5">
          Back
        </Button>
        <Button
          onClick={onConfirmed}
          disabled={!allCorrect}
          className="flex-1 h-9 bg-[var(--tint)] text-tint-foreground hover:bg-[var(--tint)]/90"
        >
          Verify
        </Button>
      </div>
      <p className="pt-2.5 text-[13px] text-muted-foreground/70">
        All 3 words must match to continue
      </p>
    </div>
  )
}
