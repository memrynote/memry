/**
 * Tag Autocomplete Component
 * Dropdown menu for selecting tags when typing #
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  useCallback,
  type KeyboardEvent
} from 'react'
import type { SuggestionProps } from '@tiptap/suggestion'
import { Hash, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Tag } from '@/hooks/use-tags'

export interface TagAutocompleteProps {
  items: Tag[]
  command: (props: { tag: string }) => void
  query: string
}

export interface TagAutocompleteRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

/**
 * Tag Autocomplete Component
 * Shows suggestions when user types #
 */
export const TagAutocomplete = forwardRef<
  TagAutocompleteRef,
  TagAutocompleteProps & Partial<SuggestionProps>
>(({ items, command, query }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0)
  }, [items])

  // Scroll selected item into view
  useEffect(() => {
    const selectedElement = document.querySelector('.tag-autocomplete-item-selected')
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const selectItem = useCallback(
    (index: number) => {
      if (index === items.length) {
        // Create new tag option (last item)
        if (query && query.trim()) {
          command({ tag: query.trim() })
        }
        return
      }

      const item = items[index]
      if (item) {
        command({ tag: item.name })
      }
    },
    [items, command, query]
  )

  const upHandler = useCallback(() => {
    setSelectedIndex((prev) => (prev === 0 ? items.length : prev - 1))
  }, [items.length])

  const downHandler = useCallback(() => {
    setSelectedIndex((prev) => (prev === items.length ? 0 : prev + 1))
  }, [items.length])

  const enterHandler = useCallback(() => {
    selectItem(selectedIndex)
  }, [selectedIndex, selectItem])

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }: { event: KeyboardEvent }) => {
      if (event.key === 'ArrowUp') {
        upHandler()
        return true
      }

      if (event.key === 'ArrowDown') {
        downHandler()
        return true
      }

      if (event.key === 'Enter' || event.key === 'Tab') {
        enterHandler()
        return true
      }

      // Space key also completes the tag
      if (event.key === ' ') {
        enterHandler()
        return true
      }

      return false
    }
  }))

  return (
    <div
      className={cn(
        'tag-autocomplete',
        'z-50 min-w-[200px] max-w-[300px] max-h-[300px]',
        'overflow-y-auto rounded-md border bg-popover p-1',
        'shadow-md animate-in fade-in-0 zoom-in-95'
      )}
      role="listbox"
      aria-label="Tag suggestions"
    >
      {items.length === 0 && !query ? (
        // Empty state - no tags at all
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
          <Hash className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <p>No tags yet</p>
          <p className="mt-1 text-xs">Type to create a new tag</p>
        </div>
      ) : (
        <>
          {/* Tags List */}
          {items.length > 0 && (
            <div className="mb-1">
              <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">Tags</div>
              {items.map((item, index) => (
                <button
                  key={item.name}
                  className={cn(
                    'tag-autocomplete-item',
                    'relative flex w-full cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
                    'hover:bg-accent hover:text-accent-foreground',
                    selectedIndex === index &&
                      'bg-accent text-accent-foreground tag-autocomplete-item-selected'
                  )}
                  onClick={() => selectItem(index)}
                  role="option"
                  aria-selected={selectedIndex === index}
                >
                  <div className="flex items-center gap-2">
                    <Hash className="h-4 w-4 shrink-0 opacity-70" />
                    <span className="font-medium">{item.name}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">({item.count})</span>
                </button>
              ))}
            </div>
          )}

          {/* Create New Tag Option */}
          {query && query.trim() && (
            <div className={items.length > 0 ? 'border-t pt-1 mt-1' : ''}>
              <button
                className={cn(
                  'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
                  'text-primary hover:bg-accent hover:text-accent-foreground',
                  selectedIndex === items.length &&
                    'bg-accent text-accent-foreground tag-autocomplete-item-selected'
                )}
                onClick={() => selectItem(items.length)}
                role="option"
                aria-selected={selectedIndex === items.length}
              >
                <Plus className="h-4 w-4 shrink-0" />
                <span className="font-medium">
                  Create <span className="text-primary">#{query}</span>
                </span>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
})

TagAutocomplete.displayName = 'TagAutocomplete'
