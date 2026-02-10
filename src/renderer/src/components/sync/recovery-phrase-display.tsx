import { useState, useCallback, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Copy, Check } from 'lucide-react'

interface RecoveryPhraseDisplayProps {
  phrase: string
  onContinue: () => void
}

const CLIPBOARD_CLEAR_DELAY_MS = 30_000
const COPIED_FEEDBACK_MS = 2000

export function RecoveryPhraseDisplay({
  phrase,
  onContinue
}: RecoveryPhraseDisplayProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const words = phrase.split(' ')
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clipboardClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      if (clipboardClearTimerRef.current) clearTimeout(clipboardClearTimerRef.current)
      void navigator.clipboard.writeText('')
    }
  }, [])

  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(phrase)
      setCopied(true)

      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)

      if (clipboardClearTimerRef.current) clearTimeout(clipboardClearTimerRef.current)
      clipboardClearTimerRef.current = setTimeout(() => {
        void navigator.clipboard.writeText('')
      }, CLIPBOARD_CLEAR_DELAY_MS)
    } catch {
      setCopied(false)
    }
  }, [phrase])

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Save your recovery phrase</h3>
        <p className="text-sm text-muted-foreground">
          This phrase is the only way to recover your encrypted data if you lose access to all your
          devices.
        </p>
      </div>

      <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
        <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-amber-700 dark:text-amber-400">
          Write this phrase down and store it somewhere safe. Do not share it with anyone. You will
          not be able to see it again.
        </p>
      </div>

      <div className="grid grid-cols-4 gap-2 p-4 rounded-lg border bg-muted/30">
        {words.map((word, i) => (
          <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded bg-background">
            <span className="text-xs text-muted-foreground w-5 text-right">{i + 1}.</span>
            <span className="font-mono text-sm">{word}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={handleCopy} className="gap-2">
          {copied ? (
            <>
              <Check className="w-4 h-4" />
              Copied!
            </>
          ) : (
            <>
              <Copy className="w-4 h-4" />
              Copy to clipboard
            </>
          )}
        </Button>
      </div>

      <Button onClick={onContinue} className="w-full">
        I&apos;ve saved my recovery phrase
      </Button>
    </div>
  )
}
