import type { NoteTagSuggestion } from '@memry/contracts/notes-api'
import { useT } from '@memry/i18n/renderer'
import { Plus, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface SuggestedTagsRowProps {
  suggestions: NoteTagSuggestion[]
  onAccept: (tag: string) => void
  onDismiss: () => void
  disabled?: boolean
}

/**
 * Tags this note's closest notes share, offered for a note that has none.
 * Shown, never applied: each chip is a one-click add through the normal tag
 * path, and the row can be waved away.
 */
export function SuggestedTagsRow({
  suggestions,
  onAccept,
  onDismiss,
  disabled
}: SuggestedTagsRowProps): React.JSX.Element | null {
  const { t } = useT('notes')
  if (suggestions.length === 0) return null

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 text-xs text-text-tertiary"
      data-testid="suggested-tags"
      data-marquee-ignore
    >
      <span title={t('suggestedTags.hint')}>{t('suggestedTags.label')}</span>
      {suggestions.map((suggestion) => (
        <button
          key={suggestion.tag}
          type="button"
          disabled={disabled}
          onClick={() => onAccept(suggestion.tag)}
          aria-label={t('suggestedTags.acceptAria', { tag: suggestion.tag })}
          title={t('suggestedTags.support', { count: suggestion.support })}
          className={cn(
            'flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5',
            'text-text-secondary transition-colors hover:border-muted-foreground hover:text-foreground',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-border',
            'disabled:pointer-events-none disabled:opacity-50'
          )}
        >
          <Plus className="size-3" aria-hidden="true" />
          {suggestion.tag}
        </button>
      ))}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('suggestedTags.dismiss')}
        title={t('suggestedTags.dismiss')}
        className={cn(
          'flex size-5 items-center justify-center rounded text-text-tertiary',
          'hover:text-foreground transition-colors',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-border'
        )}
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </div>
  )
}
