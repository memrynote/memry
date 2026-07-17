import { useRef, useEffect, useCallback, useState, KeyboardEvent, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface TitleInputProps {
  value: string
  placeholder?: string
  onChange: (value: string) => void
  autoFocus?: boolean
  disabled?: boolean
  /** Optional external ref to the underlying textarea (e.g. to focus from a menu) */
  inputRef?: RefObject<HTMLTextAreaElement | null>
}

export function TitleInput({
  value,
  placeholder,
  onChange,
  autoFocus = false,
  disabled = false,
  inputRef
}: TitleInputProps) {
  const { t } = useT('notes')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [draftValue, setDraftValue] = useState<string | null>(null)
  const displayValue = draftValue ?? value

  // Merge the internal auto-resize ref with an optional external ref.
  const setTextareaRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node
      if (inputRef) inputRef.current = node
    },
    [inputRef]
  )

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

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
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
  }, [])

  return (
    <textarea
      ref={setTextareaRef}
      value={displayValue}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      placeholder={placeholder ?? t('editor.title.untitled')}
      disabled={disabled}
      rows={1}
      aria-label={t('editor.title.aria')}
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
