import { useRef, useEffect, useCallback, useState, KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

interface TitleInputProps {
  value: string
  placeholder?: string
  onChange: (value: string) => void
  autoFocus?: boolean
  disabled?: boolean
}

export function TitleInput({
  value,
  placeholder = 'Untitled',
  onChange,
  autoFocus = false,
  disabled = false
}: TitleInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [draftValue, setDraftValue] = useState<string | null>(null)
  const displayValue = draftValue ?? value

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${textarea.scrollHeight}px`
    }
  }, [])

  useEffect(() => {
    adjustHeight()
  }, [displayValue, adjustHeight])

  // Auto-focus on mount
  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus()
      // Place cursor at end
      const length = textareaRef.current.value.length
      textareaRef.current.setSelectionRange(length, length)
    }
  }, [autoFocus])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraftValue(e.target.value)
    // Don't call onChange on every keystroke - only update local state
    // The actual save happens on blur
  }, [])

  const handleBlur = useCallback(() => {
    // Only trigger onChange if value actually changed
    if (draftValue !== null && draftValue !== value) {
      onChange(draftValue)
    }
    setDraftValue(null)
  }, [draftValue, value, onChange])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter saves and blurs
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        textareaRef.current?.blur()
      }
      // Escape reverts and blurs
      if (e.key === 'Escape') {
        e.preventDefault()
        setDraftValue(null)
        textareaRef.current?.blur()
      }
    },
    []
  )

  return (
    <textarea
      ref={textareaRef}
      value={displayValue}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      placeholder={placeholder}
      disabled={disabled}
      rows={1}
      aria-label="Note title"
      className={cn(
        'w-full resize-none overflow-hidden bg-transparent',
        'text-[42px] tracking-[-0.02em] leading-12 text-text-bright',
        'placeholder:text-text-tertiary placeholder:font-normal',
        'border-none outline-none',
        'focus:outline-none',
        'disabled:pointer-events-none disabled:opacity-50'
      )}
      style={{
        fontFamily: 'var(--font-heading)'
      }}
    />
  )
}
