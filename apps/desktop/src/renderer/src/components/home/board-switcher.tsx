import type { HomePage } from '@/lib/home/types'
import { useT } from '@memry/i18n/renderer'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Check, Pencil, Plus } from '@/lib/icons/icon-map'
import { cn } from '@/lib/utils'

interface BoardSwitcherProps {
  boards: HomePage[]
  activeBoardId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  editing: boolean
  onToggleEditing: () => void
}

export function BoardSwitcher({
  boards,
  activeBoardId,
  onSelect,
  onCreate,
  editing,
  onToggleEditing
}: BoardSwitcherProps): React.JSX.Element {
  const { t } = useT('common')
  const toggleLabel = editing ? t('home.done') : t('home.edit')
  return (
    <div data-testid="board-switcher" className="flex items-center gap-2 border-b px-6 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        {boards.map((b) => (
          <button
            key={b.id}
            type="button"
            data-testid="board-chip"
            data-board-id={b.id}
            data-active={b.id === activeBoardId}
            onClick={() => onSelect(b.id)}
            className={cn(
              'shrink-0 rounded-md px-2 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--tint-ring)]',
              b.id === activeBoardId
                ? 'bg-[var(--tint-light)] font-semibold text-foreground'
                : 'font-medium text-muted-foreground hover:bg-muted/60'
            )}
          >
            {b.name}
          </button>
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="board-new"
            aria-label={t('home.board.newAria')}
            onClick={onCreate}
            className="shrink-0 text-muted-foreground focus-visible:ring-[var(--tint-ring)]"
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('home.board.newAria')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="board-edit-toggle"
            aria-label={toggleLabel}
            aria-pressed={editing}
            onClick={onToggleEditing}
            className="shrink-0"
          >
            {editing ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Pencil className="size-4" aria-hidden="true" />
            )}
            {toggleLabel}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{toggleLabel}</TooltipContent>
      </Tooltip>
    </div>
  )
}
