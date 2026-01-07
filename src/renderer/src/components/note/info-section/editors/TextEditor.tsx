import { useState, useRef, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'

interface TextEditorProps {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  placeholder?: string
  autoFocus?: boolean
}

export function TextEditor({
  value,
  onChange,
  onBlur,
  placeholder = 'Empty',
  autoFocus = true
}: TextEditorProps) {
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

  return (
    <input
      ref={inputRef}
      type="text"
      value={localValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      className={cn(
        'w-full rounded px-2 py-1',
        'text-[13px] text-stone-900',
        'bg-white border border-stone-300',
        'placeholder:text-stone-400',
        'outline-none',
        'focus:border-stone-400 focus:ring-1 focus:ring-stone-400'
      )}
    />
  )
}
