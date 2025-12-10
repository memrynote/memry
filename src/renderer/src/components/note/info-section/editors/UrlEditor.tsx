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
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="url"
        value={localValue}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={cn(
          'flex-1 rounded px-2 py-1',
          'text-[13px] text-stone-900',
          'bg-white border border-stone-300',
          'placeholder:text-stone-400',
          'outline-none',
          'focus:border-stone-400 focus:ring-1 focus:ring-stone-400'
        )}
      />
      {value && (
        <button
          type="button"
          onClick={handleOpenUrl}
          aria-label="Open URL"
          className={cn(
            'flex h-7 w-7 items-center justify-center',
            'rounded text-stone-400',
            'transition-colors duration-150',
            'hover:bg-stone-100 hover:text-stone-600'
          )}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
