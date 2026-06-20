import type { HomePage } from '@/lib/home/types'
import { useT } from '@memry/i18n/renderer'

interface BoardSwitcherProps {
  boards: HomePage[]
  activeBoardId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
}

export function BoardSwitcher({
  boards,
  activeBoardId,
  onSelect,
  onCreate
}: BoardSwitcherProps): React.JSX.Element {
  const { t } = useT('common')
  return (
    <div data-testid="board-switcher" className="flex items-center gap-1 border-b px-3 py-2">
      {boards.map((b) => (
        <button
          key={b.id}
          type="button"
          data-testid="board-chip"
          data-board-id={b.id}
          data-active={b.id === activeBoardId}
          onClick={() => onSelect(b.id)}
          className={
            b.id === activeBoardId ? 'font-semibold text-foreground' : 'text-muted-foreground'
          }
        >
          {b.name}
        </button>
      ))}
      <button
        type="button"
        data-testid="board-new"
        aria-label={t('home.board.newAria')}
        onClick={onCreate}
        className="ms-1"
      >
        +
      </button>
    </div>
  )
}
