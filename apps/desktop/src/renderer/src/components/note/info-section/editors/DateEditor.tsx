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
  const [localValue, setLocalValue] = useState(value ? format(value, DATE_FORMAT) : '')
  const [isValidFormat, setIsValidFormat] = useState(true)

  useEffect(() => {
    setLocalValue(value ? format(value, DATE_FORMAT) : '')
    setIsValidFormat(true)
  }, [value])

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

  const resetToStoredValue = useCallback(() => {
    setLocalValue(value ? format(value, DATE_FORMAT) : '')
    setIsValidFormat(true)
  }, [value])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value
      setLocalValue(newValue)
      const valid = !newValue || validateAndParse(newValue) !== null
      setIsValidFormat(valid)
    },
    [validateAndParse]
  )

  const handleBlur = useCallback(() => {
    const parsed = validateAndParse(localValue)
    const valid = !localValue || parsed !== null
    setIsValidFormat(valid)
    if (!valid) {
      resetToStoredValue()
      onBlur?.()
      return
    }
    if (!localValue) {
      onChange(null)
    } else if (parsed) {
      onChange(parsed)
    }
    onBlur?.()
  }, [localValue, validateAndParse, onChange, onBlur])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const parsed = validateAndParse(localValue)
        const valid = !localValue || parsed !== null
        setIsValidFormat(valid)
        if (!valid) {
          resetToStoredValue()
          onBlur?.()
          return
        }
        if (!localValue) {
          onChange(null)
        } else if (parsed) {
          onChange(parsed)
        }
        onBlur?.()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setLocalValue(value ? format(value, DATE_FORMAT) : '')
        setIsValidFormat(true)
        onBlur?.()
      }
    },
    [localValue, value, validateAndParse, onChange, onBlur, resetToStoredValue]
  )

  return (
    <input
      ref={inputRef}
      type="text"
      value={localValue}
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
