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
    <div className="[font-synthesis:none] flex flex-col antialiased text-xs/4">
      <div className="wizard-step-enter flex flex-col pb-5 gap-1.5">
        <div className="tracking-[-0.02em] font-semibold text-xl/6.5 text-foreground">
          Save your recovery phrase
        </div>
        <div className="text-[13px]/4.5 text-muted-foreground">
          This is the only way to recover your encrypted data if you lose access to all your
          devices.
        </div>
      </div>

      <div className="wizard-step-enter wiz-delay-2 flex items-center mb-5 rounded-lg py-2.5 px-3.5 gap-2.5 bg-amber-500/[0.08] border border-amber-500/15">
        <ShieldAlert className="w-4 h-4 text-amber-500 dark:text-amber-400 shrink-0" />
        <p className="text-xs/4 text-amber-500 dark:text-amber-400">
          Write this down and store it somewhere safe. You will not see it again.
        </p>
      </div>

      <div
        className="mb-5 rounded-lg bg-foreground/[0.02] border border-foreground/[0.06]"
        aria-label="Recovery phrase words"
      >
        <div className="flex flex-wrap gap-1.5 p-4" role="list">
          {words.map((word, i) => (
            <div
              key={`${i}-${word}`}
              role="listitem"
              className="flex items-center w-27.5 py-1 gap-1.5 shrink-0"
              aria-label={`Word ${i + 1}: ${word}`}
            >
              <span className="w-4 shrink-0 font-mono text-muted-foreground/50 text-[10px]/3 select-none">
                {i + 1}
              </span>
              <span className="font-mono text-[13px]/4 text-foreground select-all">{word}</span>
            </div>
          ))}
        </div>
        <div className="border-t border-foreground/[0.06] px-4 py-2.5 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void handleCopy()}
            className="gap-1.5 text-muted-foreground h-7"
            aria-label={copied ? 'Recovery phrase copied' : 'Copy recovery phrase to clipboard'}
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 text-green-600 dark:text-green-400" />
                <span className="text-green-700 dark:text-green-400">Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                Copy
              </>
            )}
          </Button>
        </div>
      </div>

      <Button
        onClick={onContinue}
        className="w-full h-9 bg-[var(--tint)] text-tint-foreground hover:bg-[var(--tint)]/90 wizard-step-enter wiz-delay-3"
      >
        I&apos;ve saved my recovery phrase
      </Button>
    </div>
  )
}
