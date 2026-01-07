/**
 * WikiLink Autocomplete Component
 * Dropdown menu for selecting pages when typing [[
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
import { FileText, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/lib/wiki-link-utils'
import type { Page } from '@/hooks/use-pages'

export interface WikiLinkAutocompleteProps {
  items: Page[]
  command: (props: { href: string; title: string; exists: boolean }) => void
}

export interface WikiLinkAutocompleteRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

/**
 * WikiLink Autocomplete Component
 * Shows suggestions when user types [[
 */
export const WikiLinkAutocomplete = forwardRef<
  WikiLinkAutocompleteRef,
  WikiLinkAutocompleteProps & Partial<SuggestionProps>
>(({ items, command }, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0)

  // Reset selection when items change
  useEffect(() => {
    setSelectedIndex(0)
  }, [items])

  // Scroll selected item into view
  useEffect(() => {
    const selectedElement = document.querySelector('.wiki-link-autocomplete-item-selected')
    if (selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  const selectItem = useCallback(
    (index: number) => {
      if (index === items.length) {
        // Create new page option (last item)
        // For now, we'll allow creation - the page will be marked as not existing
        // In a real app, this would trigger a page creation dialog
        return
      }

      const item = items[index]
      if (item) {
        command({
          href: item.id,
          title: item.title,
          exists: item.exists
        })
      }
    },
    [items, command]
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

      return false
    }
  }))

  // Separate recent and all pages
  const recentPages = items.slice(0, 3)
  const hasMorePages = items.length > 3

  return (
    <div
      className={cn(
        'wiki-link-autocomplete',
        'z-50 min-w-[200px] max-w-[350px] max-h-[300px]',
        'overflow-y-auto rounded-md border bg-popover p-1',
        'shadow-md animate-in fade-in-0 zoom-in-95'
      )}
      role="listbox"
      aria-label="Page suggestions"
    >
      {items.length === 0 ? (
        // Empty state
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
          <FileText className="mx-auto mb-2 h-8 w-8 opacity-50" />
          <p>No pages found</p>
        </div>
      ) : (
        <>
          {/* Recent Pages Section */}
          {recentPages.length > 0 && (
            <div className="mb-1">
              <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">Recent</div>
              {recentPages.map((item, index) => (
                <button
                  key={item.id}
                  className={cn(
                    'wiki-link-autocomplete-item',
                    'relative flex w-full cursor-pointer select-none items-start gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
                    'hover:bg-accent hover:text-accent-foreground',
                    selectedIndex === index &&
                      'bg-accent text-accent-foreground wiki-link-autocomplete-item-selected'
                  )}
                  onClick={() => selectItem(index)}
                  role="option"
                  aria-selected={selectedIndex === index}
                >
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 opacity-70" />
                  <div className="flex flex-1 flex-col gap-0.5">
                    <div className="font-medium">{item.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatRelativeTime(item.lastEdited)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* All Pages Section (if more than recent) */}
          {hasMorePages && (
            <div>
              <div className="px-2 py-1 text-xs font-semibold text-muted-foreground">All Pages</div>
              {items.slice(3).map((item, index) => {
                const actualIndex = index + 3
                return (
                  <button
                    key={item.id}
                    className={cn(
                      'wiki-link-autocomplete-item',
                      'relative flex w-full cursor-pointer select-none items-start gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
                      'hover:bg-accent hover:text-accent-foreground',
                      selectedIndex === actualIndex &&
                        'bg-accent text-accent-foreground wiki-link-autocomplete-item-selected'
                    )}
                    onClick={() => selectItem(actualIndex)}
                    role="option"
                    aria-selected={selectedIndex === actualIndex}
                  >
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 opacity-70" />
                    <div className="flex flex-1 flex-col gap-0.5">
                      <div className="font-medium">{item.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatRelativeTime(item.lastEdited)}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* Create New Page Option - always shown */}
      <div className="border-t pt-1 mt-1">
        <button
          className={cn(
            'relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none',
            'text-primary hover:bg-accent hover:text-accent-foreground',
            selectedIndex === items.length &&
              'bg-accent text-accent-foreground wiki-link-autocomplete-item-selected'
          )}
          onClick={() => selectItem(items.length)}
          role="option"
          aria-selected={selectedIndex === items.length}
        >
          <Plus className="h-4 w-4 shrink-0" />
          <span className="font-medium">Create new page</span>
        </button>
      </div>
    </div>
  )
})

WikiLinkAutocomplete.displayName = 'WikiLinkAutocomplete'
