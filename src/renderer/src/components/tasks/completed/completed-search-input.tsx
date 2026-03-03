import { Search, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

// ============================================================================
// TYPES
// ============================================================================

interface CompletedSearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

// ============================================================================
// COMPLETED SEARCH INPUT
// ============================================================================

export const CompletedSearchInput = ({
  value,
  onChange,
  placeholder = 'Search completed tasks...',
  className
}: CompletedSearchInputProps): React.JSX.Element => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    onChange(e.target.value)
  }

  const handleClear = (): void => {
    onChange('')
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape' && value) {
      e.preventDefault()
      handleClear()
    }
  }

  return (
    <div className={cn('relative', className)}>
      <Search
        className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-text-tertiary"
        aria-hidden="true"
      />
      <Input
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className="pl-9 pr-9 h-9"
        aria-label="Search completed tasks"
      />
      {value && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-1 top-1/2 -translate-y-1/2 size-7"
          onClick={handleClear}
          aria-label="Clear search"
        >
          <X className="size-4 text-text-tertiary" />
        </Button>
      )}
    </div>
  )
}

export default CompletedSearchInput
