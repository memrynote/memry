import { useState, useRef, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'

interface NumberEditorProps {
  value: number | null
  onChange: (value: number | null) => void
  onBlur?: () => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
}

export function NumberEditor({
  value,
  onChange,
  onBlur,
  placeholder = 'Empty',
  autoFocus = true,
  className
}: NumberEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [draftValue, setDraftValue] = useState<string | null>(null)
  const inputValue = draftValue ?? (value?.toString() ?? '')

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [autoFocus])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDraftValue(e.target.value)
  }, [])

  const handleBlur = useCallback(() => {
    const num = inputValue ? parseFloat(inputValue) : null
    onChange(num !== null && !isNaN(num) ? num : null)
    setDraftValue(null)
    onBlur?.()
  }, [inputValue, onChange, onBlur])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Handle Enter - save value
      if (e.key === 'Enter') {
        e.preventDefault()
        const num = inputValue ? parseFloat(inputValue) : null
        onChange(num !== null && !isNaN(num) ? num : null)
        setDraftValue(null)
        onBlur?.()
        return
      }

      // Handle Escape - revert value
      if (e.key === 'Escape') {
        e.preventDefault()
        setDraftValue(null)
        onBlur?.()
        return
      }

      // Allow control keys
      const allowedKeys = [
        'Backspace',
        'Delete',
        'Tab',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Home',
        'End'
      ]
      if (allowedKeys.includes(e.key)) return

      // Allow Ctrl/Cmd shortcuts (copy, paste, select all, cut)
      if ((e.ctrlKey || e.metaKey) && ['a', 'c', 'v', 'x'].includes(e.key.toLowerCase())) return

      // Allow decimal point (only one)
      if (e.key === '.' && !inputValue.includes('.')) return

      // Allow minus sign (only at start when cursor is at position 0)
      if (e.key === '-' && e.currentTarget.selectionStart === 0 && !inputValue.includes('-'))
        return

      // Allow digits
      if (/^\d$/.test(e.key)) return

      // Block everything else (letters, special characters, etc.)
      e.preventDefault()
    },
    [inputValue, onChange, onBlur]
  )

  return (
    <input
      ref={inputRef}
      type="number"
      value={inputValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      className={cn(
        'w-24 bg-transparent border-none p-0',
        'text-[13px] text-foreground',
        'placeholder:text-muted-foreground/30',
        'outline-none focus:ring-0 shadow-none',
        '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none',
        className
      )}
    />
  )
}
