import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { PenLine } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { WritingRailMode } from './writing-tools-session'

interface WritingChromeProps {
  mode: WritingRailMode | null
  onSelectMode: (mode: WritingRailMode | null) => void
  /** Lab needs AI; its entry is not rendered without it. */
  aiEnabled: boolean
  alternativeCount: number
  overflowCount: number
  wordCountVisible: boolean
  wordCount: number
  onToggleWordCount: () => void
  disabled?: boolean
}

const TRIGGER_CLASS =
  'size-7 hover:bg-surface-active transition-all duration-150 ease-out active:scale-95 active:bg-surface-active/70 disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100'

const NO_MODE = 'none'

/**
 * Every writing tool behind one chrome control: the rail modes and the word
 * count toggle. The live count, when turned on, is plain text beside it.
 */
export function WritingChrome({
  mode,
  onSelectMode,
  aiEnabled,
  alternativeCount,
  overflowCount,
  wordCountVisible,
  wordCount,
  onToggleWordCount,
  disabled
}: WritingChromeProps) {
  const { t } = useT('notes')
  const modes: Array<{ mode: WritingRailMode; label: string; count?: number }> = [
    { mode: 'alternatives', label: t('writingTools.chrome.alternatives'), count: alternativeCount },
    { mode: 'overflow', label: t('writingTools.chrome.overflow'), count: overflowCount },
    ...(aiEnabled ? [{ mode: 'lab' as const, label: t('writingTools.chrome.lab') }] : [])
  ]
  const label = t('writingTools.chrome.menu')

  return (
    <>
      {wordCountVisible && (
        <span
          data-testid="note-word-count"
          className="me-1 px-1 text-xs tabular-nums text-text-secondary"
        >
          {t('writingTools.chrome.words', { count: wordCount })}
        </span>
      )}
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
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={wordCountVisible}
            onCheckedChange={onToggleWordCount}
            data-testid="note-word-count-toggle"
          >
            {t('writingTools.chrome.showWordCount')}
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
