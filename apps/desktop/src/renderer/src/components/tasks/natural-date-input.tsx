import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react'
import { Search, Check, AlertCircle } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { parseNaturalDate, type ParsedDateResult } from '@/lib/natural-date-parser'

// ============================================================================
// TYPES
// ============================================================================

interface NaturalDateInputProps {
  onSelect: (result: ParsedDateResult) => void
  onInputChange?: (value: string) => void // Callback to notify parent of input changes
  placeholder?: string
  className?: string
}

export interface NaturalDateInputRef {
  focus: () => void
  getValue: () => string
  setValue: (value: string) => void
  isEmpty: () => boolean
}

// ============================================================================
// NATURAL DATE INPUT COMPONENT
// ============================================================================

export const NaturalDateInput = forwardRef<NaturalDateInputRef, NaturalDateInputProps>(
  (
    { onSelect, onInputChange, placeholder = 'Type a date... "next friday", "dec 25"', className },
    ref
  ): React.JSX.Element => {
    const [value, setValue] = useState('')
    const [parseResult, setParseResult] = useState<ReturnType<typeof parseNaturalDate> | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    // Expose methods to parent via ref
    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      getValue: () => value,
      setValue: (newValue: string) => setValue(newValue),
      isEmpty: () => value.trim() === ''
    }))

    // Parse input as user types (debounced)
    useEffect(() => {
      if (!value.trim()) {
        setParseResult(null)
        return
      }

      const timer = setTimeout(() => {
        const result = parseNaturalDate(value)
        setParseResult(result)
      }, 150) // Small debounce for smoother UX

      return () => clearTimeout(timer)
    }, [value])

    // Notify parent when input changes
    useEffect(() => {
      onInputChange?.(value)
    }, [value, onInputChange])

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
      setValue(e.target.value)
    }

    const handleSelect = useCallback((): void => {
      if (parseResult?.success) {
        onSelect(parseResult.result)
        setValue('')
        setParseResult(null)
      }
    }, [parseResult, onSelect])

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Enter' && parseResult?.success) {
        e.preventDefault()
        e.stopPropagation()
        handleSelect()
      }
      // Let all other keys pass through to allow natural typing
    }

    const isValid = parseResult?.success === true
    const isInvalid = parseResult?.success === false && value.trim().length > 0

    return (
      <div className={cn('flex flex-col gap-2', className)}>
        {/* Input field */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            type="text"
            value={value}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className={cn(
              'pl-9 pr-3',
              isValid && 'border-task-complete focus-visible:ring-task-complete/20',
              isInvalid && 'border-task-due-today focus-visible:ring-task-due-today/20'
            )}
            aria-label="Type a date in natural language"
            autoComplete="off"
          />
        </div>

        {/* Preview/Result */}
        {parseResult && (
          <div
            className={cn(
              'flex items-center justify-between rounded-sm border px-3 py-2 text-sm',
              isValid && 'border-task-complete/20 bg-task-complete/[0.06]',
              isInvalid && 'border-task-due-today/20 bg-task-due-today/[0.06]'
            )}
          >
            {isValid ? (
              <>
                <div className="flex items-center gap-2">
                  <Check className="size-4 text-task-complete" />
                  <span className="text-task-complete">{parseResult.displayText}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleSelect}
                  className="h-7 px-2 text-task-complete hover:bg-task-complete/10"
                >
                  Select
                </Button>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <AlertCircle className="size-4 text-task-due-today" />
                <span className="text-task-due-today">{parseResult.error}</span>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }
)

NaturalDateInput.displayName = 'NaturalDateInput'

export default NaturalDateInput
