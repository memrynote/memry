import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { FOLD_LEVELS, type FoldLayers, type FoldLevel } from '@memry/contracts/note-fold'
import { Check, Copy } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { isMac } from '@/lib/shortcut-catalog'
import { cn } from '@/lib/utils'
import { levelAvailability } from './fold-display'
import { createWheelStepper } from './fold-wheel'

const log = createLogger('FoldPill')

interface FoldPillProps {
  layers: FoldLayers
  /** The level on screen. */
  level: Exclude<FoldLevel, 'full'>
  openCount: number
  onSelectLevel: (level: FoldLevel) => void
  /** Scrolling the bar: -1 toward Full, 1 toward Topic. */
  onStep: (direction: 1 | -1) => void
  onRetry: () => void
  /** Copies the folded view as Markdown. */
  onCopy: () => Promise<void>
}

const WRITTEN_LEVELS: ReadonlySet<FoldLevel> = new Set(['key', 'takeaway', 'topic'])

/** The one line above the pill that explains the state, most pressing first. */
function useCaption({ layers, level, openCount }: FoldPillProps): string | null {
  const { t } = useT('notes')
  if (layers.status === 'off') return t('fold.chrome.captionOff')
  if (layers.status === 'no_agent') return t('fold.chrome.captionNoAgent')
  if (openCount > 0) return t('fold.pill.opened', { count: openCount })
  if (layers.status === 'writing') return t('fold.chrome.writing')
  if (WRITTEN_LEVELS.has(level)) {
    return t('fold.chrome.writtenBy', { agent: layers.agent ?? t('fold.chrome.unknownAgent') })
  }
  return null
}

/**
 * Bottom pill, the folded view's level control: one segment per level, a click
 * switches. A level the agent cannot write is dimmed, and the line above says why.
 */
export function FoldPill(props: FoldPillProps) {
  const { layers, level, onSelectLevel, onStep, onRetry, onCopy } = props
  const { t } = useT('notes')
  const caption = useCaption(props)
  const failed = layers.status === 'failed'
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  // The active segment's fill is one element that slides to the chosen level.
  const levelRefs = useRef(new Map<FoldLevel, HTMLButtonElement>())
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const active = levelRefs.current.get(level)
    if (active) setThumb({ left: active.offsetLeft, width: active.offsetWidth })
  }, [level])

  // Scrolling over the bar steps levels, so the note underneath does not scroll.
  const barRef = useRef<HTMLDivElement>(null)
  const stepRef = useRef(onStep)
  useEffect(() => {
    stepRef.current = onStep
  })
  useEffect(() => {
    const bar = barRef.current
    if (!bar) return undefined
    const stepper = createWheelStepper(40, 200, true)
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const direction = stepper.push(event.deltaY, performance.now())
      if (direction !== 0) stepRef.current(direction)
    }
    bar.addEventListener('wheel', onWheel, { passive: false })
    return () => bar.removeEventListener('wheel', onWheel)
  }, [])

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
        ref={barRef}
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- ARIA widget pattern; native tag would change styling or behavior
        role="group"
        aria-label={t('fold.pill.aria')}
        className="pointer-events-auto flex items-center gap-0.5 relative rounded-full border border-border bg-background p-[3px] text-xs leading-4 shadow-[0_4px_14px_rgba(29,31,34,0.08)]"
      >
        {thumb && (
          <span
            aria-hidden
            data-testid="note-fold-thumb"
            className="pointer-events-none absolute top-[3px] h-6 rounded-full bg-foreground transition-[transform,width] duration-200 ease-in-out motion-reduce:transition-none"
            style={{ left: 0, width: thumb.width, transform: `translateX(${thumb.left}px)` }}
          />
        )}
        {FOLD_LEVELS.map((entry) => {
          const availability = levelAvailability(layers, entry)
          const active = entry === level
          return (
            <button
              key={entry}
              ref={(node) => {
                if (node) levelRefs.current.set(entry, node)
                else levelRefs.current.delete(entry)
              }}
              type="button"
              aria-pressed={active}
              disabled={availability === 'unavailable'}
              onClick={() => onSelectLevel(entry)}
              data-testid={`note-fold-level-${entry}`}
              className={cn(
                'relative flex h-6 items-center gap-1.5 rounded-full px-2.5 outline-none transition-colors',
                'focus-visible:ring-1 focus-visible:ring-ring motion-reduce:transition-none',
                active
                  ? 'font-medium text-background'
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
              .then(() => setCopied(true))
              .catch((error: unknown) => log.error('Failed to copy the folded view', error))
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
      <span className="text-[11px] leading-4 text-text-tertiary/70">
        {t(isMac ? 'fold.pill.hintMac' : 'fold.pill.hint')}
      </span>
    </div>
  )
}
