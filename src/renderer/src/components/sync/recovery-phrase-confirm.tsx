/**
 * Recovery Phrase Confirmation (T068)
 * Request user to enter specific words to verify they saved the phrase
 */

import { useState, useCallback, useMemo, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ArrowLeft, Loader2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface RecoveryPhraseConfirmProps {
  phrase: string[]
  onConfirmed: () => void
  onBack: () => void
  isLoading?: boolean
  className?: string
}

function getRandomWordIndices(phraseLength: number, count: number): number[] {
  const indices: number[] = []
  const used = new Set<number>()

  while (indices.length < count) {
    const index = Math.floor(Math.random() * phraseLength)
    if (!used.has(index)) {
      used.add(index)
      indices.push(index)
    }
  }

  return indices.sort((a, b) => a - b)
}

export function RecoveryPhraseConfirm({
  phrase,
  onConfirmed,
  onBack,
  isLoading = false,
  className
}: RecoveryPhraseConfirmProps): React.JSX.Element {
  const [wordIndices] = useState(() => getRandomWordIndices(phrase.length, 3))
  const [inputs, setInputs] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)

  const handleInputChange = useCallback((index: number, value: string) => {
    setInputs((prev) => ({ ...prev, [index]: value.toLowerCase().trim() }))
    setError(null)
  }, [])

  const allFilled = useMemo(() => {
    return wordIndices.every((idx) => inputs[idx]?.length > 0)
  }, [wordIndices, inputs])

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()

      const allCorrect = wordIndices.every((idx) => inputs[idx] === phrase[idx].toLowerCase())

      if (!allCorrect) {
        setError(
          'One or more words are incorrect. Please check your recovery phrase and try again.'
        )
        return
      }

      onConfirmed()
    },
    [wordIndices, inputs, phrase, onConfirmed]
  )

  return (
    <div className={cn('space-y-6', className)}>
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={onBack} disabled={isLoading}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <span className="text-sm text-muted-foreground">Back</span>
      </div>

      <div className="text-center space-y-2">
        <h2 className="text-xl font-semibold">Confirm your recovery phrase</h2>
        <p className="text-sm text-muted-foreground">
          Enter the following words from your recovery phrase to verify you've saved it correctly
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {wordIndices.map((wordIndex) => (
          <div key={wordIndex} className="space-y-2">
            <Label htmlFor={`word-${wordIndex}`}>Word #{wordIndex + 1}</Label>
            <Input
              id={`word-${wordIndex}`}
              type="text"
              value={inputs[wordIndex] || ''}
              onChange={(e) => handleInputChange(wordIndex, e.target.value)}
              placeholder={`Enter word #${wordIndex + 1}`}
              disabled={isLoading}
              autoComplete="off"
              spellCheck={false}
              className={cn(error && 'border-destructive')}
            />
          </div>
        ))}

        {error && (
          <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
            <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <Button type="submit" className="w-full" disabled={!allFilled || isLoading}>
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Verifying...
            </>
          ) : (
            'Confirm and continue'
          )}
        </Button>
      </form>
    </div>
  )
}

export default RecoveryPhraseConfirm
