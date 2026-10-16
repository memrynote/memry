import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { trackLandingEvent } from '@/lib/analytics'
import { useDetectedOS } from '@/lib/download'
import { cn } from '@/lib/utils'

// Same cask the install guide documents (apps/docs/src/guide/install.md).
const BREW_COMMAND = 'brew install --cask memrynote/tap/memry'

/** Homebrew one-liner, click to copy. Only surfaces for visitors on macOS. */
export function BrewInstall({ location, className }: { location: string; className?: string }) {
  const os = useDetectedOS()
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    },
    []
  )

  if (os !== 'mac') return null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(BREW_COMMAND)
    } catch {
      return // clipboard blocked (insecure context / denied): leave the text selectable
    }
    trackLandingEvent('landing_download_click', `download:brew:${location}`)
    setCopied(true)
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className={cn('flex justify-center', className)}>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={`Copy the Homebrew command: ${BREW_COMMAND}`}
        className="inline-flex max-w-full items-center gap-2.5 rounded-xl border border-ink/10 bg-card py-2 ps-3.5 pe-2.5 text-start transition-colors duration-200 hover:bg-paper-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-terracotta/60"
      >
        {/* Wraps at spaces rather than truncating: a half-shown shell command is unreadable,
            and a break inside a word (`memr`/`y`) misreads as two arguments. */}
        <code className="break-words font-mono text-[12px] leading-4 text-muted">
          <span aria-hidden className="select-none text-muted/60">
            ${' '}
          </span>
          {BREW_COMMAND}
        </code>
        {copied ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-terracotta" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5 shrink-0 text-muted/70" aria-hidden />
        )}
      </button>
      <span aria-live="polite" className="sr-only">
        {copied ? 'Homebrew command copied' : ''}
      </span>
    </div>
  )
}
