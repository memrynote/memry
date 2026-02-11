import { useState, useCallback, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowLeft, Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface RecoveryPhraseConfirmProps {
  phrase: string
  onConfirmed: () => void
  onBack: () => void
}

const MIN_GAP = 2

function pickRandomIndices(wordCount: number): [number, number, number] {
  const arr = new Uint32Array(3)
  for (;;) {
    crypto.getRandomValues(arr)
    const indices = Array.from(arr).map((v) => v % wordCount)
    indices.sort((a, b) => a - b)
    const [a, b, c] = indices
    if (a !== b && b !== c && b - a >= MIN_GAP && c - b >= MIN_GAP) {
      return [a, b, c] as [number, number, number]
    }
  }
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
    <div className="space-y-6">
      <div className="wizard-step-enter space-y-2">
        <h3 className="font-display text-xl tracking-tight">Confirm your recovery phrase</h3>
        <p className="font-serif text-[15px] text-muted-foreground leading-relaxed">
          Enter the requested words to verify you&apos;ve saved it.
        </p>
      </div>

      <div className="space-y-4 wizard-step-enter wiz-delay-2">
        {indices.map((wordIndex, slotIndex) => {
          const showFeedback = touched[slotIndex] && inputs[slotIndex].trim().length > 0
          const isCorrect = matches[slotIndex]

          return (
            <div key={wordIndex} className="space-y-1.5">
              <Label
                htmlFor={`word-${wordIndex}`}
                className="text-[11px] font-semibold tracking-widest uppercase text-muted-foreground"
              >
                Word #{wordIndex + 1}
              </Label>
              <div className="relative">
                <Input
                  id={`word-${wordIndex}`}
                  value={inputs[slotIndex]}
                  onChange={(e) => handleChange(slotIndex, e.target.value)}
                  onBlur={() => handleBlur(slotIndex)}
                  placeholder={`Enter word #${wordIndex + 1}`}
                  className={cn(
                    'h-11 pr-9 font-mono text-[15px]',
                    'focus-visible:ring-amber-600/15 focus-visible:border-amber-600/50',
                    'dark:focus-visible:ring-amber-400/10 dark:focus-visible:border-amber-400/40',
                    showFeedback && isCorrect && 'border-green-500 focus-visible:ring-green-500/20',
                    showFeedback &&
                      !isCorrect &&
                      'border-destructive focus-visible:ring-destructive/20'
                  )}
                  autoFocus={slotIndex === 0}
                />
                {showFeedback && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2">
                    {isCorrect ? (
                      <Check className="w-4 h-4 text-green-500" />
                    ) : (
                      <X className="w-4 h-4 text-destructive" />
                    )}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-3 wizard-step-enter wiz-delay-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="gap-1.5 text-muted-foreground"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </Button>
        <Button onClick={onConfirmed} disabled={!allCorrect} className="flex-1 h-11">
          Verify
        </Button>
      </div>
    </div>
  )
}
