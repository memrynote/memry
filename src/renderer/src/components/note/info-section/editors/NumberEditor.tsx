import { useState, useRef, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'

interface NumberEditorProps {
  value: number | null
  onChange: (value: number | null) => void
  onBlur?: () => void
  placeholder?: string
  autoFocus?: boolean
}

export function NumberEditor({
  value,
  onChange,
  onBlur,
  placeholder = 'Empty',
  autoFocus = true
}: NumberEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [localValue, setLocalValue] = useState(value?.toString() ?? '')

  useEffect(() => {
    setLocalValue(value?.toString() ?? '')
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
    const num = localValue ? parseFloat(localValue) : null
    onChange(num !== null && !isNaN(num) ? num : null)
    onBlur?.()
  }, [localValue, onChange, onBlur])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const num = localValue ? parseFloat(localValue) : null
        onChange(num !== null && !isNaN(num) ? num : null)
        onBlur?.()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setLocalValue(value?.toString() ?? '')
        onBlur?.()
      }
    },
    [localValue, value, onChange, onBlur]
  )

  return (
    <input
      ref={inputRef}
      type="number"
      value={localValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      className={cn(
        'w-24 rounded px-2 py-1',
        'text-[13px] text-stone-900',
        'bg-white border border-stone-300',
        'placeholder:text-stone-400',
        'outline-none',
        'focus:border-stone-400 focus:ring-1 focus:ring-stone-400',
        '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none'
      )}
    />
  )
}
