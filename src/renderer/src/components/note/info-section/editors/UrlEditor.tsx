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

export function UrlEditor({
  value,
  onChange,
  onBlur,
  placeholder = 'https://',
  autoFocus = true
}: UrlEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [localValue, setLocalValue] = useState(value)

  useEffect(() => {
    setLocalValue(value)
  }, [value])

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [autoFocus])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalValue(e.target.value)
  }, [])

  const handleBlur = useCallback(() => {
    onChange(localValue)
    onBlur?.()
  }, [localValue, onChange, onBlur])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        onChange(localValue)
        onBlur?.()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setLocalValue(value)
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
        type="url"
        value={localValue}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={cn(
          'flex-1 bg-transparent border-none p-0',
          'text-[13px] text-foreground leading-tight',
          'placeholder:text-muted-foreground/30',
          'outline-none focus:ring-0 shadow-none'
        )}
      />
      {value && (
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
