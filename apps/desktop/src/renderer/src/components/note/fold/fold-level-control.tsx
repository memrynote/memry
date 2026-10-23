import { useT } from '@memry/i18n/renderer'
import type { FoldLayers, FoldLevel } from '@memry/contracts/note-fold'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { bindingParts, isMac } from '@/lib/shortcut-catalog'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import { cn } from '@/lib/utils'
import { levelWordCount } from './fold-display'
import { useFoldHint } from './use-fold-hint'

export interface FoldLevelControlProps {
  layers: FoldLayers
  /** The level the reader chose. */
  requested: FoldLevel
  /** The level on screen: Brief while the requested one is still being written. */
  level: FoldLevel
  onSelectLevel: (level: FoldLevel) => void
  disabled?: boolean
}

function FoldGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className="shrink-0 text-current"
    >
      <path
        d="M2 3.5H12M2 7H9M2 10.5H6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

function Keys({ parts, className }: { parts: string[]; className?: string }) {
  return (
    <kbd
      className={cn(
        'rounded-sm border px-1.5 py-px font-mono text-[11px] leading-3.5 tabular-nums',
        className
      )}
    >
      {parts.join(isMac ? '' : '+')}
    </kbd>
  )
}

/**
 * The note chrome's fold control, only on notes long enough to fold. At Full it
 * is an icon: a click folds to Brief, and the tooltip carries the word count and
 * shortcut. Folded it reads "icon + level" and a click returns to Full. The
 * other levels are the pill's job. The first reader to open a long note gets a
 * one-time hint, since an icon alone does not say a note can fold.
 */
export function FoldLevelControl({
  layers,
  requested,
  level,
  onSelectLevel,
  disabled
}: FoldLevelControlProps) {
  const { t } = useT('notes')
  const briefBinding = useShortcutBinding('fold.brief')
  const [hintDue, dismissHint] = useFoldHint()
  const folded = level !== 'full'
  const levelName = t(`fold.level.${level}`)
  const words = t('fold.chrome.words', { count: levelWordCount(layers, level) })
  const label = folded ? t('fold.chrome.unfold', { level: levelName }) : t('fold.chrome.fold')

  return (
    <TooltipProvider delayDuration={300}>
      <Popover
        open={hintDue && !folded && !disabled}
        onOpenChange={(open) => !open && dismissHint()}
      >
        <Tooltip>
          <PopoverAnchor asChild>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label={label}
                aria-pressed={folded}
                data-testid="note-fold-control"
                onClick={() => {
                  dismissHint()
                  onSelectLevel(requested === 'full' ? 'brief' : 'full')
                }}
                className={cn(
                  'me-1 flex h-6.5 items-center gap-1.5 rounded-md px-1.5 text-xs outline-none transition-colors',
                  'hover:bg-surface-active focus-visible:ring-1 focus-visible:ring-ring',
                  'disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none',
                  folded ? 'font-medium text-foreground' : 'text-text-secondary'
                )}
              >
                <FoldGlyph />
                {folded && <span data-testid="note-fold-level">{levelName}</span>}
              </button>
            </TooltipTrigger>
          </PopoverAnchor>
          <TooltipContent side="bottom" align="end" className="flex items-center gap-2">
            {folded ? `${levelName} · ${words}` : `${t('fold.chrome.fold')} · ${words}`}
            {!folded && <Keys parts={bindingParts(briefBinding)} className="border-white/30" />}
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          className="flex w-60 flex-col gap-2.5 p-3"
          onOpenAutoFocus={(event) => event.preventDefault()}
          data-testid="note-fold-hint"
        >
          <div className="flex flex-col gap-0.5">
            <p className="text-[13px] font-semibold leading-4">{t('fold.hint.title')}</p>
            <p className="text-xs leading-4 text-text-secondary">{t('fold.hint.body')}</p>
          </div>
          <div className="flex items-center justify-between">
            <Keys
              parts={bindingParts(briefBinding)}
              className="border-border text-text-secondary"
            />
            <button
              type="button"
              onClick={dismissHint}
              className="rounded-sm text-xs font-medium text-text-secondary outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
            >
              {t('fold.hint.dismiss')}
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}
