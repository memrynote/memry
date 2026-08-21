import { Command } from 'cmdk'
import { FileText, BookOpen, CheckSquare, Inbox, Trash2 } from '@/lib/icons'
import type { SearchReason } from '@memry/contracts/search-api'
import { useT } from '@memry/i18n/renderer'

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
  const { t: tPhaseF } = useT('common')
  if (reasons.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-text-tertiary">
        {tPhaseF('phaseF.componentsSearchRecentReasons.searchAndClickItemsToBuildYourTrail')}
      </div>
    )
  }

  return (
    <div className="py-1">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
          {tPhaseF('phaseF.componentsSearchRecentReasons.reasons')}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="flex items-center gap-1 text-xs text-text-tertiary hover:text-foreground transition-colors"
        >
          <Trash2 className="size-3" />

          {tPhaseF('phaseF.componentsSearchRecentReasons.clear')}
        </button>
      </div>
      {/* cmdk items, not buttons: the trail has to answer to the arrow keys and
          Enter the same way search results do. */}
      <Command.Group>
        {reasons.map((reason) => {
          const Icon = TYPE_ICONS[reason.itemType] ?? FileText
          return (
            <Command.Item
              key={reason.id}
              value={`reason-${reason.id}`}
              onSelect={() => onSelect(reason)}
              className="flex items-center gap-3 w-full px-3 py-2 rounded-md text-start
                cursor-pointer data-[selected=true]:bg-muted transition-colors duration-75"
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
            </Command.Item>
          )
        })}
      </Command.Group>
    </div>
  )
}
