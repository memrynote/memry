import { useState, useRef, useEffect, useCallback } from 'react'

import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface TaskDescriptionProps {
  value: string
  onChange: (value: string) => void
  className?: string
}

// ============================================================================
// DEBOUNCE HOOK
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const useDebounce = <T extends (...args: any[]) => void>(callback: T, delay: number): T => {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const debouncedCallback = useCallback(
    (...args: Parameters<T>) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      timeoutRef.current = setTimeout(() => {
        callback(...args)
      }, delay)
    },
    [callback, delay]
  ) as T

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  return debouncedCallback
}

// ============================================================================
// TASK DESCRIPTION COMPONENT
// ============================================================================

export const TaskDescription = ({
  value,
  onChange,
  className
}: TaskDescriptionProps): React.JSX.Element => {
  const [localValue, setLocalValue] = useState(value)
  const [isSaving, setIsSaving] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Sync local value when external value changes
  useEffect(() => {
    setLocalValue(value)
  }, [value])

  // Debounced save function
  const debouncedSave = useDebounce((newValue: string) => {
    onChange(newValue)
    setIsSaving(false)
  }, 1000)

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const newValue = e.target.value
    setLocalValue(newValue)
    setIsSaving(true)
    debouncedSave(newValue)
  }

  const handleBlur = (): void => {
    // Save immediately on blur
    if (localValue !== value) {
      onChange(localValue)
      setIsSaving(false)
    }
  }

  // Auto-resize textarea
  const adjustHeight = (): void => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.max(80, textarea.scrollHeight)}px`
    }
  }

  useEffect(() => {
    adjustHeight()
  }, [localValue])

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/* Section label with saving indicator */}
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Description
        </h3>
        {isSaving && <span className="text-xs text-muted-foreground animate-pulse">Saving...</span>}
      </div>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={localValue}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder="Add a description..."
        className={cn(
          'min-h-[80px] w-full resize-none rounded-md border border-border bg-transparent px-3 py-2 text-sm',
          'placeholder:text-muted-foreground',
          'focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent',
          'transition-colors duration-150'
        )}
        aria-label="Task description"
      />
    </div>
  )
}

export default TaskDescription
