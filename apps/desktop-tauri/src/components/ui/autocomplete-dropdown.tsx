/**
 * Autocomplete Dropdown Component
 *
 * Displays a list of autocomplete suggestions with keyboard navigation support.
 * Used with the useAutocomplete hook.
 *
 * @module components/ui/autocomplete-dropdown
 */

import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { AutocompleteSuggestion } from '@/hooks/use-autocomplete'

// ============================================================================
// Types
// ============================================================================

interface AutocompleteDropdownProps {
  /** List of suggestions to display */
  suggestions: AutocompleteSuggestion[]
  /** Currently selected index */
  selectedIndex: number
  /** Called when a suggestion is clicked */
  onSelect: (index: number) => void
  /** Whether the dropdown is visible */
  visible: boolean
  /** Additional CSS classes */
  className?: string
}

// ============================================================================
// Component
// ============================================================================

/**
 * Dropdown component for displaying autocomplete suggestions.
 *
 * Features:
 * - Keyboard navigation support (managed by parent via useAutocomplete)
 * - Auto-scroll selected item into view
 * - Function signature display in muted color
 * - Visual distinction between functions and variables
 */
export function AutocompleteDropdown({
  suggestions,
  selectedIndex,
  onSelect,
  visible,
  className
}: AutocompleteDropdownProps): React.JSX.Element | null {
  const listRef = useRef<HTMLUListElement>(null)
  const selectedRef = useRef<HTMLLIElement>(null)

  // Auto-scroll selected item into view
  useEffect(() => {
    if (visible && selectedRef.current) {
      selectedRef.current.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth'
      })
    }
  }, [selectedIndex, visible])

  if (!visible || suggestions.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        'absolute z-50 w-full mt-1',
        'bg-popover border rounded-md shadow-md',
        'overflow-hidden',
        className
      )}
    >
      <ul
        ref={listRef}
        className="max-h-48 overflow-y-auto py-1"
        role="listbox"
        aria-label="Suggestions"
      >
        {suggestions.map((suggestion, index) => {
          const isSelected = index === selectedIndex
          const isFunction = suggestion.type === 'function'

          return (
            <li
              key={suggestion.label}
              ref={isSelected ? selectedRef : null}
              role="option"
              aria-selected={isSelected}
              className={cn(
                'px-3 py-1.5 cursor-pointer',
                'flex items-center gap-1',
                'text-sm font-mono',
                'transition-colors',
                isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'
              )}
              onClick={() => onSelect(index)}
              onMouseEnter={() => {
                // Optional: could update selectedIndex on hover
              }}
            >
              {/* Type indicator */}
              <span
                className={cn(
                  'flex-shrink-0 w-4 h-4 rounded text-[10px] font-bold',
                  'flex items-center justify-center',
                  isFunction
                    ? 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                    : 'bg-green-500/20 text-green-600 dark:text-green-400'
                )}
              >
                {isFunction ? 'ƒ' : 'x'}
              </span>

              {/* Label */}
              <span className="font-semibold">{suggestion.label}</span>

              {/* Signature (for functions) */}
              {suggestion.signature && (
                <span className="text-muted-foreground">{suggestion.signature}</span>
              )}
            </li>
          )
        })}
      </ul>

      {/* Hint footer */}
      <div className="px-3 py-1 text-[10px] text-muted-foreground border-t bg-muted/30">
        <kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">Tab</kbd> or{' '}
        <kbd className="px-1 py-0.5 bg-muted rounded text-[9px]">Enter</kbd> to insert
      </div>
    </div>
  )
}

export default AutocompleteDropdown
