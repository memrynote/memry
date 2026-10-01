import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Archive, Layers, Lightbulb } from '@/lib/icons'
import type { AppIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { WritingRailMode } from './writing-tools-session'

interface WritingChromeProps {
  mode: WritingRailMode | null
  onToggleMode: (mode: WritingRailMode) => void
  /** Lab needs AI; the toggle is not rendered without it. */
  aiEnabled: boolean
  wordCountVisible: boolean
  wordCount: number
  onToggleWordCount: () => void
  disabled?: boolean
}

const TOGGLE_CLASS =
  'size-7 hover:bg-surface-active transition-all duration-150 ease-out active:scale-95 active:bg-surface-active/70 disabled:active:scale-100 motion-reduce:transition-none motion-reduce:active:scale-100'

/** Word count chip plus the Alternatives / Overflow / Lab rail toggles. */
export function WritingChrome({
  mode,
  onToggleMode,
  aiEnabled,
  wordCountVisible,
  wordCount,
  onToggleWordCount,
  disabled
}: WritingChromeProps) {
  const { t } = useT('notes')
  const toggles: Array<{ mode: WritingRailMode; label: string; icon: AppIcon }> = [
    { mode: 'alternatives', label: t('writingTools.chrome.alternatives'), icon: Layers },
    { mode: 'overflow', label: t('writingTools.chrome.overflow'), icon: Archive },
    ...(aiEnabled
      ? [{ mode: 'lab' as const, label: t('writingTools.chrome.lab'), icon: Lightbulb }]
      : [])
  ]

  return (
    <>
      <button
        type="button"
        onClick={onToggleWordCount}
        aria-pressed={wordCountVisible}
        title={wordCountVisible ? t('writingTools.chrome.hideWordCount') : undefined}
        data-testid="note-word-count"
        className={cn(
          'me-1 h-6 rounded-md px-2 text-xs tabular-nums transition-colors motion-reduce:transition-none',
          wordCountVisible
            ? 'bg-surface text-text-secondary hover:bg-surface-active'
            : 'text-text-tertiary hover:bg-surface-active hover:text-text-secondary'
        )}
      >
        {wordCountVisible
          ? t('writingTools.chrome.words', { count: wordCount })
          : t('writingTools.chrome.wordCount')}
      </button>
      {toggles.map(({ mode: toggleMode, label, icon: Icon }) => (
        <Button
          key={toggleMode}
          variant="ghost"
          size="icon"
          className={cn(TOGGLE_CLASS, mode === toggleMode && 'bg-surface-active')}
          onClick={() => onToggleMode(toggleMode)}
          disabled={disabled}
          aria-pressed={mode === toggleMode}
          aria-label={label}
          title={label}
          data-testid={`note-writing-${toggleMode}-toggle`}
        >
          <Icon
            className={cn(
              'h-3.5 w-3.5',
              mode === toggleMode ? 'text-foreground' : 'text-muted-foreground'
            )}
          />
        </Button>
      ))}
    </>
  )
}
