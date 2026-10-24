import { Button } from '@/components/ui/button'
import { Plus } from '@/lib/icons/icon-map'
import { useT } from '@memry/i18n/renderer'

interface BoardEmptyStateProps {
  onAddFirstWidget: () => void
}

/**
 * Board-level empty state. Shown when the active board has zero widgets so a
 * fresh board teaches "add your first widget" instead of rendering a blank grid.
 * The CTA enters edit mode and opens the Add-widget popover (wired in home.tsx).
 */
export function BoardEmptyState({ onAddFirstWidget }: BoardEmptyStateProps): React.JSX.Element {
  const { t } = useT('common')
  return (
    <div
      data-testid="board-empty-state"
      className="mx-auto flex max-w-sm flex-col items-center gap-3 px-6 py-20 text-center"
    >
      <div
        aria-hidden="true"
        className="flex size-12 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--tint)_12%,transparent)] text-[var(--tint)]"
      >
        <Plus className="size-5" />
      </div>
      <div className="flex flex-col gap-1">
        <h2 className="card-title text-base text-foreground">{t('home.empty.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('home.empty.body')}</p>
      </div>
      <Button
        type="button"
        size="sm"
        data-testid="board-empty-cta"
        onClick={onAddFirstWidget}
        className="mt-1 motion-safe:active:scale-[0.97]"
      >
        <Plus className="size-4" aria-hidden="true" />
        {t('home.empty.cta')}
      </Button>
    </div>
  )
}
