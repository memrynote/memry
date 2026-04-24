/**
 * WikiLink suggestion menu for BlockNote.
 */

import type { SuggestionMenuProps } from '@blocknote/react'
import { FileText, Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/wiki-link-utils'

export type WikiLinkSuggestionItem = {
  id: string
  title: string
  target: string
  alias?: string
  exists: boolean
  type: 'note' | 'create'
  lastEdited?: string
}

export function WikiLinkMenu({
  items,
  loadingState,
  selectedIndex,
  onItemClick
}: SuggestionMenuProps<WikiLinkSuggestionItem>) {
  if (items.length === 0 && loadingState !== 'loaded') {
    return (
      <div className="wiki-link-menu min-w-[220px] rounded-md border bg-popover p-2 text-sm text-muted-foreground shadow-md">
        Loading notes...
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="wiki-link-menu min-w-[220px] rounded-md border bg-popover p-3 text-sm text-muted-foreground shadow-md">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 opacity-70" />
          <span>No notes found</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'wiki-link-menu z-50 min-w-[220px] max-w-[360px] max-h-[300px]',
        'overflow-y-auto rounded-md border bg-popover p-1',
        'shadow-md animate-in fade-in-0 zoom-in-95'
      )}
      role="listbox"
      aria-label="Note suggestions"
    >
      {items.map((item, index) => {
        const isSelected = selectedIndex === index
        return (
          <button
            key={`${item.type}-${item.id}-${item.target}`}
            className={cn(
              'wiki-link-menu-item',
              'relative flex w-full cursor-pointer select-none items-start gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
              'hover:bg-accent hover:text-accent-foreground',
              isSelected && 'bg-accent text-accent-foreground'
            )}
            onClick={() => onItemClick?.(item)}
            role="option"
            aria-selected={isSelected}
          >
            {item.type === 'create' ? (
              <Plus className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <FileText className="mt-0.5 h-4 w-4 shrink-0 opacity-70" />
            )}
            <div className="flex flex-1 flex-col gap-0.5 text-left">
              {item.type === 'create' ? (
                <>
                  <div className="font-medium">Create new note</div>
                  <div className="text-xs text-muted-foreground">{item.target}</div>
                </>
              ) : (
                <>
                  <div className="font-medium">{item.title}</div>
                  {item.lastEdited && (
                    <div className="text-xs text-muted-foreground">
                      {formatRelativeTime(item.lastEdited)}
                    </div>
                  )}
                </>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
