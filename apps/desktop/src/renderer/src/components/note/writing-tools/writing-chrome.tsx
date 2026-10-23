import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  FoldLevelControl,
  type FoldLevelControlProps
} from '@/components/note/fold/fold-level-control'
import { PenLine } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { WritingRailMode } from './writing-tools-session'

interface WritingChromeProps {
  mode: WritingRailMode | null
  onSelectMode: (mode: WritingRailMode | null) => void
  alternativeCount: number
  overflowCount: number
  /** Present while the note is long enough to fold: the fold control sits beside it. */
  fold?: FoldLevelControlProps
  disabled?: boolean
}

const TRIGGER_CLASS =
  'size-7 hover:bg-surface-active transition-all duration-150 ease-out active:scale-95 active:bg-surface-active/70 disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100'

const NO_MODE = 'none'

/**
 * Every writing tool behind one chrome control: the rail modes.
 */
export function WritingChrome({
  mode,
  onSelectMode,
  alternativeCount,
  overflowCount,
  fold,
  disabled
}: WritingChromeProps) {
  const { t } = useT('notes')
  const modes: Array<{ mode: WritingRailMode; label: string; count?: number }> = [
    { mode: 'alternatives', label: t('writingTools.chrome.alternatives'), count: alternativeCount },
    { mode: 'overflow', label: t('writingTools.chrome.overflow'), count: overflowCount }
  ]
  const label = t('writingTools.chrome.menu')

  return (
    <>
      {fold && <FoldLevelControl {...fold} disabled={disabled} />}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(TRIGGER_CLASS, mode !== null && 'bg-surface-active')}
            disabled={disabled}
            aria-label={label}
            title={label}
            data-testid="note-writing-menu"
          >
            <PenLine
              className={cn(
                'h-3.5 w-3.5',
                mode !== null ? 'text-foreground' : 'text-muted-foreground'
              )}
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          <DropdownMenuRadioGroup
            value={mode ?? NO_MODE}
            onValueChange={(value) => onSelectMode(value as WritingRailMode)}
          >
            {modes.map((entry) => (
              <DropdownMenuRadioItem
                key={entry.mode}
                value={entry.mode}
                // Picking the open mode again closes the rail.
                onSelect={() => {
                  if (entry.mode === mode) onSelectMode(null)
                }}
                data-testid={`note-writing-${entry.mode}-toggle`}
              >
                <span className="flex-1">{entry.label}</span>
                {entry.count ? (
                  <span className="ms-4 text-xs tabular-nums text-text-tertiary">
                    {entry.count}
                  </span>
                ) : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
