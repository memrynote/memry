import { useState, useRef, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface LongTextEditorProps {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  placeholder?: string
  autoFocus?: boolean
}

export function LongTextEditor({
  value,
  onChange,
  onBlur,
  placeholder,
  autoFocus = true
}: LongTextEditorProps) {
  const { t } = useT('notes')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [localValue, setLocalValue] = useState(value)
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    setLocalValue(value)
  }

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.select()
    }
  }, [autoFocus])

  // Auto-resize
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
    }
  }, [localValue])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLocalValue(e.target.value)
  }, [])

  const handleBlur = useCallback(() => {
    onChange(localValue)
    onBlur?.()
  }, [localValue, onChange, onBlur])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Cmd/Ctrl + Enter to save
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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
    <textarea
      ref={textareaRef}
      value={localValue}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      placeholder={placeholder ?? t('properties.empty')}
      rows={2}
      className={cn(
        'w-full min-h-[60px] resize-y bg-transparent border-none p-0',
        'text-[13px] text-foreground',
        'placeholder:text-muted-foreground/30',
        'outline-none focus:ring-0 shadow-none'
      )}
    />
  )
}
