import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { FoldLayers, FoldLevel } from '@memry/contracts/note-fold'
import type { CommandId } from '@memry/contracts/commands'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ChevronDown } from '@/lib/icons'
import { bindingParts, isMac } from '@/lib/shortcut-catalog'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import { cn } from '@/lib/utils'
import { FOLD_ORDER, levelAvailability, levelWordCount } from './fold-display'

export interface FoldLevelControlProps {
  layers: FoldLayers
  /** The level the reader chose. */
  requested: FoldLevel
  /** The level on screen: Brief while the requested one is still being written. */
  level: FoldLevel
  onSelectLevel: (level: FoldLevel) => void
  onRetry: () => void
  disabled?: boolean
}

const LEVEL_COMMAND = {
  full: 'fold.full',
  brief: 'fold.brief',
  key: 'fold.key',
  takeaway: 'fold.takeaway',
  topic: 'fold.topic'
} as const satisfies Record<FoldLevel, CommandId>

const WRITTEN_LEVELS: readonly FoldLevel[] = ['key', 'takeaway', 'topic']

function ShortcutKeys({ level }: { level: FoldLevel }) {
  const binding = useShortcutBinding(LEVEL_COMMAND[level])
  return (
    <kbd className="rounded-sm border border-border px-1.5 py-px font-mono text-[11px] leading-3.5 text-text-secondary">
      {bindingParts(binding).join(isMac ? '' : '+')}
    </kbd>
  )
}

function LevelRow({
  layers,
  level,
  className
}: {
  layers: FoldLayers
  level: FoldLevel
  className?: string
}) {
  const { t } = useT('notes')
  const writing = levelAvailability(layers, level) === 'writing'
  return (
    <DropdownMenuRadioItem
      value={level}
      className={cn('h-10 gap-2.5 py-0', className)}
      data-testid={`note-fold-level-${level}`}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn('text-[13px] font-medium leading-4', writing && 'text-text-tertiary')}>
          {t(`fold.level.${level}`)}
        </span>
        <span className="text-[11px] leading-3.5 text-text-tertiary">
          {t(`fold.menuDescription.${level}`)}
        </span>
      </span>
      <span className="w-14 text-end font-mono text-[11px] leading-3.5 tabular-nums text-text-secondary">
        {writing ? (
          <span className="text-text-tertiary">{t('fold.chrome.writing')}</span>
        ) : (
          levelWordCount(layers, level).toLocaleString()
        )}
      </span>
      <ShortcutKeys level={level} />
    </DropdownMenuRadioItem>
  )
}

/**
 * The note's word count, which is also its fold level menu. At Full it reads
 * "1,104 words"; folded it reads "Brief · 212 words". Notes too short to fold
 * never render this.
 */
export function FoldLevelControl({
  layers,
  requested,
  level,
  onSelectLevel,
  onRetry,
  disabled
}: FoldLevelControlProps) {
  const { t } = useT('notes')
  const [open, setOpen] = useState(false)
  // A level chosen by shortcut or wheel must not leave the menu covering the note.
  const [seenLevel, setSeenLevel] = useState(requested)
  if (seenLevel !== requested) {
    setSeenLevel(requested)
    setOpen(false)
  }
  const words = t('fold.chrome.words', { count: levelWordCount(layers, level) })
  const label =
    level === 'full' ? words : t('fold.chrome.folded', { level: t(`fold.level.${level}`), words })
  // With no agent there is nothing to write: the menu offers Full and Brief only.
  const showWritten =
    layers.status === 'writing' || layers.status === 'ready' || layers.status === 'failed'

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('fold.chrome.menu')}
          title={t('fold.chrome.menu')}
          data-testid="note-fold-control"
          className={cn(
            'me-1 flex h-6.5 items-center gap-1.5 rounded-md px-2 text-xs tabular-nums outline-none transition-colors',
            'hover:bg-surface-active focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-surface-active',
            'disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none',
            level === 'full' ? 'text-text-secondary' : 'font-medium text-foreground'
          )}
        >
          <span data-testid="note-word-count">{label}</span>
          <ChevronDown className="size-2.5 text-text-secondary" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-75">
        <DropdownMenuRadioGroup
          value={requested}
          onValueChange={(value) => onSelectLevel(value as FoldLevel)}
        >
          {FOLD_ORDER.filter((entry) => !WRITTEN_LEVELS.includes(entry)).map((entry) => (
            <LevelRow key={entry} layers={layers} level={entry} />
          ))}
          {showWritten && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="pb-0.5 pt-1 text-[11px] font-medium text-text-tertiary">
                {t('fold.chrome.writtenBy', {
                  agent: layers.agent ?? t('fold.chrome.unknownAgent')
                })}
              </DropdownMenuLabel>
              {WRITTEN_LEVELS.map((entry) => (
                <LevelRow key={entry} layers={layers} level={entry} />
              ))}
            </>
          )}
        </DropdownMenuRadioGroup>
        {(layers.status === 'off' || layers.status === 'no_agent') && (
          <>
            <DropdownMenuSeparator />
            <p className="px-2 py-1.5 text-[11px] leading-4 text-text-tertiary">
              {t(layers.status === 'off' ? 'fold.chrome.hintOff' : 'fold.chrome.hintNoAgent')}
            </p>
          </>
        )}
        {layers.status === 'failed' && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onRetry} className="text-[12px] text-text-secondary">
              {t('fold.chrome.retry')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
