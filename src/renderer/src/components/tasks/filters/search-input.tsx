import { useRef, useEffect, forwardRef } from 'react'
import { Search, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

// ============================================================================
// TYPES
// ============================================================================

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
  expandOnFocus?: boolean
}

// ============================================================================
// SEARCH INPUT COMPONENT
// ============================================================================

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  (
    {
      value,
      onChange,
      placeholder = 'Search tasks...',
      className,
      autoFocus = false,
      expandOnFocus = true
    },
    ref
  ) => {
    const internalRef = useRef<HTMLInputElement>(null)
    const inputRef = (ref as React.RefObject<HTMLInputElement>) || internalRef

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
      onChange(e.target.value)
    }

    const handleClear = (): void => {
      onChange('')
      inputRef.current?.focus()
    }

    const handleKeyDown = (e: React.KeyboardEvent): void => {
      if (e.key === 'Escape' && value) {
        e.preventDefault()
        e.stopPropagation()
        handleClear()
      }
    }

    // Auto-focus if requested
    useEffect(() => {
      if (autoFocus && inputRef.current) {
        inputRef.current.focus()
      }
    }, [autoFocus])

    return (
      <div className={cn('relative group', className)}>
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-text-tertiary pointer-events-none"
          aria-hidden="true"
        />
        <Input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={cn(
            'pl-9 pr-8 h-9 text-sm',
            expandOnFocus && 'w-48 focus:w-64 transition-all duration-200'
          )}
          aria-label="Search tasks"
        />
        {value && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 size-7 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
            onClick={handleClear}
            aria-label="Clear search"
            tabIndex={0}
          >
            <X className="size-4 text-text-tertiary" />
          </Button>
        )}
      </div>
    )
  }
)

SearchInput.displayName = 'SearchInput'

export default SearchInput
