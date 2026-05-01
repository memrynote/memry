import { useRef, forwardRef } from 'react'
import { Search, X } from '@/lib/icons'

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useT } from '@memry/i18n/renderer'

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
    const { t: tPhaseF } = useT('tasks')
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

    return (
      <div className={cn('relative group', className)}>
        <Search
          className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground/60 pointer-events-none"
          aria-hidden="true"
        />
        <Input
          ref={inputRef}
          type="text"
          autoFocus={autoFocus}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={cn(
            'pl-9 pr-8 h-9 text-[13px]',
            expandOnFocus && 'w-48 focus:w-64 transition-all duration-200'
          )}
          aria-label={tPhaseF('phaseF.componentsTasksFiltersSearchInput.searchTasks')}
        />
        {value && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1/2 -translate-y-1/2 size-7 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
            onClick={handleClear}
            aria-label={tPhaseF('phaseF.componentsTasksFiltersSearchInput.clearSearch')}
            tabIndex={0}
          >
            <X className="size-4 text-muted-foreground/60" />
          </Button>
        )}
      </div>
    )
  }
)

SearchInput.displayName = 'SearchInput'

export default SearchInput
