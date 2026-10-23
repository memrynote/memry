import { useEffect, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { FOLD_LEVELS, type FoldLayers, type FoldLevel } from '@memry/contracts/note-fold'
import { Check, Copy } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { cn } from '@/lib/utils'
import { levelAvailability } from './fold-display'

const log = createLogger('FoldPill')

interface FoldPillProps {
  layers: FoldLayers
  /** The level on screen. */
  level: Exclude<FoldLevel, 'full'>
  openCount: number
  onSelectLevel: (level: FoldLevel) => void
  onRetry: () => void
  /** Copies the folded view as Markdown. */
  onCopy: () => Promise<void>
}

const WRITTEN_LEVELS: readonly FoldLevel[] = ['key', 'takeaway', 'topic']

/** The one line above the pill that explains the state, most pressing first. */
function useCaption({ layers, level, openCount }: FoldPillProps): string | null {
  const { t } = useT('notes')
  if (layers.status === 'off') return t('fold.chrome.captionOff')
  if (layers.status === 'no_agent') return t('fold.chrome.captionNoAgent')
  if (openCount > 0) return t('fold.pill.opened', { count: openCount })
  if (layers.status === 'writing') return t('fold.chrome.writing')
  if (WRITTEN_LEVELS.includes(level)) {
    return t('fold.chrome.writtenBy', { agent: layers.agent ?? t('fold.chrome.unknownAgent') })
  }
  return null
}

/**
 * Bottom pill, the folded view's level control: one segment per level, a click
 * switches. A level the agent cannot write is dimmed, and the line above says why.
 */
export function FoldPill(props: FoldPillProps) {
  const { layers, level, onSelectLevel, onRetry, onCopy } = props
  const { t } = useT('notes')
  const caption = useCaption(props)
  const failed = layers.status === 'failed'
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => {
      setCopied(false)
    }, 1500)
    return () => {
      clearTimeout(timer)
    }
  }, [copied])

  return (
    <div className="pointer-events-none sticky bottom-7 z-30 mt-auto flex flex-col items-center gap-2 pt-6">
      {failed ? (
        <button
          type="button"
          onClick={onRetry}
          className="pointer-events-auto rounded-sm text-[11.5px] text-text-secondary outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          {t('fold.chrome.retry')}
        </button>
      ) : (
        caption && <span className="text-[11.5px] text-text-tertiary">{caption}</span>
      )}
      <div
        role="group"
        aria-label={t('fold.pill.aria')}
        className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border bg-background p-[3px] text-xs leading-4 shadow-[0_4px_14px_rgba(29,31,34,0.08)]"
      >
        {FOLD_LEVELS.map((entry) => {
          const availability = levelAvailability(layers, entry)
          const active = entry === level
          return (
            <button
              key={entry}
              type="button"
              aria-pressed={active}
              disabled={availability === 'unavailable'}
              onClick={() => {
                onSelectLevel(entry)
              }}
              data-testid={`note-fold-level-${entry}`}
              className={cn(
                'flex h-6 items-center gap-1.5 rounded-full px-2.5 outline-none transition-colors',
                'focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none',
                active
                  ? 'bg-foreground font-medium text-background'
                  : 'text-text-secondary hover:text-foreground disabled:pointer-events-none disabled:text-text-tertiary/70'
              )}
            >
              {availability === 'writing' && (
                <span aria-hidden className="size-[5px] rounded-full bg-tint" />
              )}
              {t(`fold.level.${entry}`)}
            </button>
          )
        })}
        <span aria-hidden className="mx-1.5 ms-1 h-3.5 w-px bg-border" />
        <button
          type="button"
          aria-label={copied ? t('fold.pill.copied') : t('fold.pill.copy')}
          title={copied ? t('fold.pill.copied') : t('fold.pill.copy')}
          onClick={() =>
            void onCopy()
              .then(() => {
                setCopied(true)
              })
              .catch((error: unknown) => {
                log.error('Failed to copy the folded view', error)
              })
          }
          data-testid="note-fold-copy"
          className="flex size-6 items-center justify-center rounded-full text-text-secondary outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
        <span aria-hidden className="mx-1.5 h-3.5 w-px bg-border" />
        <kbd className="me-1.5 rounded-sm border border-border px-1.5 py-px font-mono text-[11px] leading-3.5 text-text-secondary">
          {t('fold.pill.escape')}
        </kbd>
      </div>
    </div>
  )
}
