import { useState, useRef, useEffect, useCallback } from 'react'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'

interface UrlEditorProps {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  placeholder?: string
  autoFocus?: boolean
}

// URL validation: must have a dot and be parseable as URL
const isValidUrl = (input: string): boolean => {
  if (!input) return true // Empty is valid
  try {
    if (!input.includes('.')) return false // Must have at least one dot
    new URL(input)
    return true
  } catch {
    try {
      new URL(`https://${input}`)
      return true
    } catch {
      return false
    }
  }
}

export function UrlEditor({
  value,
  onChange,
  onBlur,
  placeholder = 'https://',
  autoFocus = true
}: UrlEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [localValue, setLocalValue] = useState(value)
  const [isValid, setIsValid] = useState(true)
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    setLocalValue(value)
    setIsValid(true)
  }

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [autoFocus])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    setLocalValue(newValue)
    const valid = isValidUrl(newValue)
    setIsValid(valid)
  }, [])

  const handleBlur = useCallback(() => {
    const valid = isValidUrl(localValue)
    setIsValid(valid)
    if (!valid) {
      setLocalValue(value)
      setIsValid(true)
      onBlur?.()
      return
    }
    onChange(localValue)
    onBlur?.()
  }, [localValue, onChange, onBlur, value])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const valid = isValidUrl(localValue)
        setIsValid(valid)
        if (!valid) {
          setLocalValue(value)
          setIsValid(true)
          onBlur?.()
          return
        }
        onChange(localValue)
        onBlur?.()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setLocalValue(value)
        setIsValid(true)
        onBlur?.()
      }
    },
    [localValue, value, onChange, onBlur]
  )

  const handleOpenUrl = useCallback(() => {
    if (value) {
      window.open(value, '_blank', 'noopener,noreferrer')
    }
  }, [value])

  return (
    <div className="flex items-center gap-1 min-h-[20px]">
      <input
        ref={inputRef}
        type="text"
        value={localValue}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={cn(
          'flex-1 bg-transparent p-0',
          'text-[13px] text-foreground leading-tight',
          'placeholder:text-muted-foreground/30',
          'outline-none focus:ring-0 shadow-none',
          // Red border + background when URL is invalid (matching DateEditor)
          !isValid && 'border border-red-500 bg-red-500/10 rounded px-1 -mx-1'
        )}
      />
      {value && isValid && (
        <button
          type="button"
          onClick={handleOpenUrl}
          aria-label="Open URL"
          className={cn(
            'flex h-4 w-4 items-center justify-center shrink-0',
            'rounded text-muted-foreground/40',
            'transition-colors duration-150',
            'hover:bg-muted hover:text-muted-foreground'
          )}
        >
          <ExternalLink className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
