import { useState, useCallback, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { ShieldAlert, Copy, Check } from '@/lib/icons'

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
      navigator.clipboard.writeText('').catch(() => {})
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
        navigator.clipboard.writeText('').catch(() => {})
      }, CLIPBOARD_CLEAR_DELAY_MS)
    } catch {
      setCopied(false)
    }
  }, [phrase])

  return (
    <div className="space-y-6">
      <div className="wizard-step-enter space-y-2">
        <h3 className="font-display text-xl tracking-tight">Save your recovery phrase</h3>
        <p className="font-serif text-[15px] text-muted-foreground leading-relaxed">
          This is the only way to recover your encrypted data if you lose access to all your
          devices.
        </p>
      </div>

      <div className="wizard-step-enter wiz-delay-2 flex items-start gap-3 p-3.5 rounded-lg border border-amber-500/20 bg-amber-500/[0.07]">
        <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
        <p className="text-[13px] leading-relaxed text-amber-800 dark:text-amber-300/90">
          Write this down and store it somewhere safe. You will not see it again.
        </p>
      </div>

      <div
        className="wizard-card-lift recovery-phrase-card rounded-xl border p-5"
        aria-label="Recovery phrase words"
      >
        <div className="grid grid-cols-4 gap-x-3 gap-y-2" role="list">
          {words.map((word, i) => (
            <div
              key={word}
              role="listitem"
              className="flex items-baseline gap-1.5 px-2.5 py-1.5 rounded-md bg-background/60"
              aria-label={`Word ${i + 1}: ${word}`}
            >
              <span className="text-[10px] tabular-nums text-muted-foreground/50 w-4 text-right select-none">
                {i + 1}
              </span>
              <span className="font-mono text-sm font-medium select-all">{word}</span>
            </div>
          ))}
        </div>

        <div className="mt-4 pt-3 border-t border-border/50 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleCopy()}
            className="gap-1.5 text-muted-foreground h-8"
            aria-label={copied ? 'Recovery phrase copied' : 'Copy recovery phrase to clipboard'}
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
                <span className="text-green-700 dark:text-green-400">Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy
              </>
            )}
          </Button>
        </div>
      </div>

      <Button onClick={onContinue} className="w-full h-11 wizard-step-enter wiz-delay-3">
        I&apos;ve saved my recovery phrase
      </Button>
    </div>
  )
}
