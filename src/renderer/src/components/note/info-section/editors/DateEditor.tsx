import { useState, useRef, useEffect, useCallback } from 'react'
import { Calendar } from 'lucide-react'
import { format, parse, isValid } from 'date-fns'
import { cn } from '@/lib/utils'

interface DateEditorProps {
  value: Date | null
  onChange: (value: Date | null) => void
  onBlur?: () => void
  autoFocus?: boolean
}

export function DateEditor({ value, onChange, onBlur, autoFocus = true }: DateEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [localValue, setLocalValue] = useState(value ? format(value, 'yyyy-MM-dd') : '')

  useEffect(() => {
    setLocalValue(value ? format(value, 'yyyy-MM-dd') : '')
  }, [value])

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus()
    }
  }, [autoFocus])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalValue(e.target.value)
  }, [])

  const handleBlur = useCallback(() => {
    if (localValue) {
      const parsed = parse(localValue, 'yyyy-MM-dd', new Date())
      onChange(isValid(parsed) ? parsed : null)
    } else {
      onChange(null)
    }
    onBlur?.()
  }, [localValue, onChange, onBlur])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (localValue) {
          const parsed = parse(localValue, 'yyyy-MM-dd', new Date())
          onChange(isValid(parsed) ? parsed : null)
        } else {
          onChange(null)
        }
        onBlur?.()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setLocalValue(value ? format(value, 'yyyy-MM-dd') : '')
        onBlur?.()
      }
    },
    [localValue, value, onChange, onBlur]
  )

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="date"
        value={localValue}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        className={cn(
          'w-full rounded px-2 py-1 pr-8',
          'text-[13px] text-stone-900',
          'bg-white border border-stone-300',
          'placeholder:text-stone-400',
          'outline-none',
          'focus:border-stone-400 focus:ring-1 focus:ring-stone-400',
          '[&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:right-0 [&::-webkit-calendar-picker-indicator]:w-8 [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:cursor-pointer'
        )}
      />
      <Calendar className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400" />
    </div>
  )
}
