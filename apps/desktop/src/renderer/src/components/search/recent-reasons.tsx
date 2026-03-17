import { FileText, BookOpen, CheckSquare, Inbox, Trash2 } from '@/lib/icons'
import type { SearchReason } from '@memry/contracts/search-api'

interface RecentReasonsProps {
  reasons: SearchReason[]
  onSelect: (reason: SearchReason) => void
  onClear: () => void
}

const TYPE_ICONS = {
  note: FileText,
  journal: BookOpen,
  task: CheckSquare,
  inbox: Inbox
} as const

export function RecentReasons({
  reasons,
  onSelect,
  onClear
}: RecentReasonsProps): React.JSX.Element {
  if (reasons.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-text-tertiary">
        Search and click items to build your trail
      </div>
    )
  }

  return (
    <div className="py-1">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
          Reasons
        </span>
        <button
          type="button"
          onClick={onClear}
          className="flex items-center gap-1 text-xs text-text-tertiary hover:text-foreground transition-colors"
        >
          <Trash2 className="size-3" />
          Clear
        </button>
      </div>
      {reasons.map((reason) => {
        const Icon = TYPE_ICONS[reason.itemType] ?? FileText
        return (
          <button
            key={reason.id}
            type="button"
            onClick={() => onSelect(reason)}
            className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-left
              hover:bg-muted transition-colors duration-75 group"
          >
            {reason.itemIcon ? (
              <span className="size-3.5 shrink-0 text-sm leading-none flex items-center justify-center">
                {reason.itemIcon}
              </span>
            ) : (
              <Icon className="size-3.5 text-text-tertiary shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              <span className="text-sm text-foreground truncate block">{reason.itemTitle}</span>
              <span className="text-xs text-text-tertiary truncate block">
                {reason.searchQuery}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}
