import type { SuggestionMenuProps } from '@blocknote/react'
import { Hash, Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { getTagColors } from '@/components/note/tags-row/tag-colors'

export type HashTagSuggestionItem = {
  name: string
  color: string
  count: number
  type: 'existing' | 'create'
}

export function HashTagMenu({
  items,
  loadingState,
  selectedIndex,
  onItemClick
}: SuggestionMenuProps<HashTagSuggestionItem>) {
  if (items.length === 0 && loadingState !== 'loaded') {
    return (
      <div className="hash-tag-menu min-w-[200px] rounded-md border bg-popover p-2 text-sm text-muted-foreground shadow-md">
        Loading tags...
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="hash-tag-menu min-w-[200px] rounded-md border bg-popover p-3 text-sm text-muted-foreground shadow-md">
        <div className="flex items-center gap-2">
          <Hash className="h-4 w-4 opacity-70" />
          <span>Type to create a new tag</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'hash-tag-menu z-50 min-w-[200px] max-w-[300px] max-h-[300px]',
        'overflow-y-auto rounded-md border bg-popover p-1',
        'shadow-md animate-in fade-in-0 zoom-in-95'
      )}
      role="listbox"
      aria-label="Tag suggestions"
    >
      {items.map((item, index) => {
        const isSelected = selectedIndex === index
        const colors = getTagColors(item.color)

        return (
          <button
            key={`${item.type}-${item.name}`}
            className={cn(
              'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
              'hover:bg-accent hover:text-accent-foreground',
              isSelected && 'bg-accent text-accent-foreground'
            )}
            onClick={() => onItemClick?.(item)}
            role="option"
            aria-selected={isSelected}
          >
            {item.type === 'create' ? (
              <>
                <Plus className="h-4 w-4 shrink-0" />
                <span className="font-medium">
                  Create <span className="text-primary">#{item.name}</span>
                </span>
              </>
            ) : (
              <>
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: colors.text }}
                />
                <span className="flex-1 font-medium text-left">#{item.name}</span>
                <span className="text-xs text-muted-foreground">({item.count})</span>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}
