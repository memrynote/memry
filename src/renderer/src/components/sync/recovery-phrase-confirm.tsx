/**
 * Recovery Phrase Confirmation Component
 *
 * Verifies the user has saved their recovery phrase by asking for random words.
 *
 * @module components/sync/recovery-phrase-confirm
 */

import { useState, useCallback, useMemo, useEffect } from 'react'
import { Loader2, CheckCircle, XCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

// =============================================================================
// Types
// =============================================================================

interface RecoveryPhraseConfirmProps {
  phrase: string
  onConfirm: (confirmationWords: Array<{ index: number; word: string }>) => Promise<void>
  onBack?: () => void
  isLoading?: boolean
  error?: string | null
  className?: string
  wordCount?: number // How many words to verify (default: 3)
}

interface WordCheck {
  index: number // 0-based index
  expectedWord: string
  enteredWord: string
  isCorrect: boolean | null
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Generate random unique indices for word verification.
 */
function generateRandomIndices(totalWords: number, count: number): number[] {
  const indices: number[] = []
  const available = Array.from({ length: totalWords }, (_, i) => i)

  for (let i = 0; i < count && available.length > 0; i++) {
    const randomIdx = Math.floor(Math.random() * available.length)
    indices.push(available[randomIdx])
    available.splice(randomIdx, 1)
  }

  return indices.sort((a, b) => a - b)
}

// =============================================================================
// Component
// =============================================================================

/**
 * Recovery phrase confirmation with random word verification.
 */
export function RecoveryPhraseConfirm({
  phrase,
  onConfirm,
  onBack,
  isLoading = false,
  error,
  className,
  wordCount = 3
}: RecoveryPhraseConfirmProps) {
  const words = useMemo(() => phrase.split(' ').filter(Boolean), [phrase])

  const [wordChecks, setWordChecks] = useState<WordCheck[]>([])
  const [localError, setLocalError] = useState<string | null>(null)
  const [isSuccess, setIsSuccess] = useState(false)

  // Initialize word checks with random indices
  const initializeChecks = useCallback(() => {
    const indices = generateRandomIndices(words.length, wordCount)
    setWordChecks(
      indices.map((idx) => ({
        index: idx,
        expectedWord: words[idx].toLowerCase(),
        enteredWord: '',
        isCorrect: null
      }))
    )
    setLocalError(null)
    setIsSuccess(false)
  }, [words, wordCount])

  // Initialize on mount and when phrase changes
  useEffect(() => {
    initializeChecks()
  }, [initializeChecks])

  // Handle word input change
  const handleWordChange = useCallback((checkIndex: number, value: string) => {
    setWordChecks((prev) =>
      prev.map((check, i) =>
        i === checkIndex
          ? {
              ...check,
              enteredWord: value,
              isCorrect:
                value.trim() === '' ? null : value.trim().toLowerCase() === check.expectedWord
            }
          : check
      )
    )
  }, [])

  // Check if all words are entered and correct
  const allCorrect = useMemo(
    () => wordChecks.every((check) => check.isCorrect === true),
    [wordChecks]
  )

  const allEntered = useMemo(
    () => wordChecks.every((check) => check.enteredWord.trim() !== ''),
    [wordChecks]
  )

  // Handle submit
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      setLocalError(null)

      if (!allEntered) {
        setLocalError('Please enter all words')
        return
      }

      if (!allCorrect) {
        setLocalError('One or more words are incorrect. Please check your recovery phrase.')
        return
      }

      try {
        await onConfirm(
          wordChecks.map((check) => ({
            index: check.index,
            word: check.enteredWord.trim().toLowerCase()
          }))
        )
        setIsSuccess(true)
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : 'An error occurred')
      }
    },
    [wordChecks, allEntered, allCorrect, onConfirm]
  )

  const displayError = error || localError

  // Success state
  if (isSuccess) {
    return (
      <div className={cn('space-y-6 text-center', className)}>
        <div className="flex justify-center">
          <div className="rounded-full bg-green-100 p-3 dark:bg-green-900/30">
            <CheckCircle className="size-8 text-green-600 dark:text-green-400" aria-hidden="true" />
          </div>
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-semibold">Recovery phrase confirmed</h3>
          <p className="text-sm text-muted-foreground">
            Your recovery phrase has been verified. Your account is now set up.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('space-y-6', className)}>
      {/* Header */}
      <div className="space-y-2 text-center">
        <h3 className="text-lg font-semibold">Verify your recovery phrase</h3>
        <p className="text-sm text-muted-foreground">
          Enter the requested words from your recovery phrase to confirm you&apos;ve saved it.
        </p>
      </div>

      {/* Word Inputs */}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-3">
          {wordChecks.map((check, checkIndex) => (
            <div key={check.index} className="space-y-2">
              <Label htmlFor={`word-${check.index}`}>Word #{check.index + 1}</Label>
              <div className="relative">
                <Input
                  id={`word-${check.index}`}
                  type="text"
                  placeholder={`Enter word #${check.index + 1}`}
                  value={check.enteredWord}
                  onChange={(e) => handleWordChange(checkIndex, e.target.value)}
                  className={cn(
                    'pr-10 font-mono',
                    check.isCorrect === true && 'border-green-500 focus-visible:ring-green-500',
                    check.isCorrect === false && 'border-red-500 focus-visible:ring-red-500'
                  )}
                  disabled={isLoading}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                {check.isCorrect !== null && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    {check.isCorrect ? (
                      <CheckCircle className="size-4 text-green-500" aria-hidden="true" />
                    ) : (
                      <XCircle className="size-4 text-red-500" aria-hidden="true" />
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Shuffle Button */}
        <div className="text-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={initializeChecks}
            disabled={isLoading}
          >
            <RefreshCw className="mr-2 size-4" aria-hidden="true" />
            Choose different words
          </Button>
        </div>

        {/* Error Message */}
        {displayError && (
          <div
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3"
            role="alert"
          >
            <p className="text-sm text-destructive">{displayError}</p>
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-3">
          {onBack && (
            <Button
              type="button"
              variant="outline"
              onClick={onBack}
              disabled={isLoading}
              className="flex-1"
            >
              Back
            </Button>
          )}
          <Button type="submit" className="flex-1" disabled={!allEntered || isLoading}>
            {isLoading && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
            Verify
          </Button>
        </div>
      </form>

      {/* Hint */}
      <p className="text-center text-xs text-muted-foreground">
        Can&apos;t remember? Go back and write down your recovery phrase again.
      </p>
    </div>
  )
}
