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

function pickVerificationIndices(wordCount: number): [number, number, number] {
  const third = Math.floor(wordCount / 3)
  return [Math.floor(third * 0.5), Math.floor(third * 1.5), Math.floor(third * 2.5)]
}

export function RecoveryPhraseConfirm({
  phrase,
  onConfirmed,
  onBack
}: RecoveryPhraseConfirmProps): React.JSX.Element {
  const words = useMemo(() => phrase.split(' '), [phrase])
  const indices = useMemo(() => pickVerificationIndices(words.length), [words.length])

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
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Confirm your recovery phrase</h3>
        <p className="text-sm text-muted-foreground">
          Enter the requested words from your recovery phrase to verify you&apos;ve saved it.
        </p>
      </div>

      <div className="space-y-4">
        {indices.map((wordIndex, slotIndex) => {
          const showFeedback = touched[slotIndex] && inputs[slotIndex].trim().length > 0
          const isCorrect = matches[slotIndex]

          return (
            <div key={wordIndex} className="space-y-1.5">
              <Label htmlFor={`word-${wordIndex}`}>Word #{wordIndex + 1}</Label>
              <div className="relative">
                <Input
                  id={`word-${wordIndex}`}
                  value={inputs[slotIndex]}
                  onChange={(e) => handleChange(slotIndex, e.target.value)}
                  onBlur={() => handleBlur(slotIndex)}
                  placeholder={`Enter word #${wordIndex + 1}`}
                  className={cn(
                    'pr-8 font-mono',
                    showFeedback && isCorrect && 'border-green-500 focus-visible:ring-green-500',
                    showFeedback &&
                      !isCorrect &&
                      'border-destructive focus-visible:ring-destructive'
                  )}
                  autoFocus={slotIndex === 0}
                />
                {showFeedback && (
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
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

      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Button>
        <Button onClick={onConfirmed} disabled={!allCorrect} className="flex-1">
          Verify
        </Button>
      </div>
    </div>
  )
}
