import { useState, useRef, useEffect, useCallback } from 'react'
import { parse, isValid, format } from 'date-fns'
import { cn } from '@/lib/utils'

interface DateEditorProps {
  value: Date | null
  onChange: (value: Date | null) => void
  onBlur?: () => void
  autoFocus?: boolean
}

// Strict date format: dd.mm.yyyy
const DATE_FORMAT = 'dd.MM.yyyy'
const DATE_PATTERN = /^\d{2}\.\d{2}\.\d{4}$/

export function DateEditor({ value, onChange, onBlur, autoFocus = true }: DateEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [draftValue, setDraftValue] = useState<string | null>(null)
  const storedValue = value ? format(value, DATE_FORMAT) : ''

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [autoFocus])

  const validateAndParse = useCallback((input: string): Date | null => {
    if (!input) return null
    if (!DATE_PATTERN.test(input)) return null
    const parsed = parse(input, DATE_FORMAT, new Date())
    if (!isValid(parsed)) return null
    if (format(parsed, DATE_FORMAT) !== input) return null
    return parsed
  }, [])

  const inputValue = draftValue ?? storedValue
  const isValidFormat = !inputValue || validateAndParse(inputValue) !== null

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDraftValue(e.target.value)
  }, [])

  const handleBlur = useCallback(() => {
    const parsed = validateAndParse(inputValue)
    const valid = !inputValue || parsed !== null
    if (!valid) {
      setDraftValue(null)
      onBlur?.()
      return
    }
    if (!inputValue) {
      onChange(null)
    } else if (parsed) {
      onChange(parsed)
    }
    setDraftValue(null)
    onBlur?.()
  }, [inputValue, validateAndParse, onChange, onBlur])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const parsed = validateAndParse(inputValue)
        const valid = !inputValue || parsed !== null
        if (!valid) {
          setDraftValue(null)
          onBlur?.()
          return
        }
        if (!inputValue) {
          onChange(null)
        } else if (parsed) {
          onChange(parsed)
        }
        setDraftValue(null)
        onBlur?.()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDraftValue(null)
        onBlur?.()
      }
    },
    [inputValue, validateAndParse, onChange, onBlur]
  )

  return (
    <input
      ref={inputRef}
      type="text"
      value={inputValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      placeholder="dd.mm.yyyy"
      className={cn(
        'w-full bg-transparent p-0',
        'text-[13px] text-foreground',
        'placeholder:text-muted-foreground/30',
        'outline-none focus:ring-0 shadow-none',
        // Red border + background when format is invalid
        !isValidFormat && 'border border-red-500 bg-red-500/10 rounded px-1 -mx-1'
      )}
    />
  )
}
