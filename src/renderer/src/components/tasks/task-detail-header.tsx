import { useState, useRef, useEffect } from 'react'
import { X, Check, Circle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface TaskDetailHeaderProps {
  title: string
  isCompleted: boolean
  onTitleChange: (title: string) => void
  onToggleComplete: () => void
  onClose: () => void
  className?: string
}

// ============================================================================
// TASK DETAIL HEADER COMPONENT
// ============================================================================

export const TaskDetailHeader = ({
  title,
  isCompleted,
  onTitleChange,
  onToggleComplete,
  onClose,
  className
}: TaskDetailHeaderProps): React.JSX.Element => {
  const [isEditing, setIsEditing] = useState(false)
  const [localTitle, setLocalTitle] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync local title when external title changes
  useEffect(() => {
    setLocalTitle(title)
  }, [title])

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  const handleTitleClick = (): void => {
    setIsEditing(true)
  }

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setLocalTitle(e.target.value)
  }

  const handleTitleBlur = (): void => {
    setIsEditing(false)
    if (localTitle.trim() !== title && localTitle.trim() !== '') {
      onTitleChange(localTitle.trim())
    } else if (localTitle.trim() === '') {
      setLocalTitle(title) // Revert to original if empty
    }
  }

  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      inputRef.current?.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setLocalTitle(title) // Revert
      setIsEditing(false)
    }
  }

  const handleCheckboxClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onToggleComplete()
  }

  return (
    <header className={cn('flex items-start gap-3 border-b border-border px-4 py-4', className)}>
      {/* Checkbox */}
      <button
        type="button"
        onClick={handleCheckboxClick}
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-150',
          isCompleted
            ? 'border-green-500 bg-green-500 text-white'
            : 'border-muted-foreground/50 hover:border-primary'
        )}
        aria-label={isCompleted ? 'Mark as incomplete' : 'Mark as complete'}
      >
        {isCompleted && <Check className="size-4" />}
      </button>

      {/* Title (editable) */}
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={localTitle}
            onChange={handleTitleChange}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            className={cn(
              'w-full bg-transparent text-lg font-medium outline-none',
              'ring-2 ring-primary rounded px-1 -mx-1'
            )}
            aria-label="Task title"
          />
        ) : (
          <button
            type="button"
            onClick={handleTitleClick}
            className={cn(
              'w-full text-left text-lg font-medium transition-colors',
              'hover:text-primary focus:outline-none focus:ring-2 focus:ring-ring rounded px-1 -mx-1',
              isCompleted && 'text-muted-foreground line-through'
            )}
            aria-label="Click to edit title"
          >
            {title || 'Untitled task'}
          </button>
        )}
      </div>

      {/* Close button */}
      <Button
        variant="ghost"
        size="icon"
        onClick={onClose}
        className="shrink-0 -mr-2"
        aria-label="Close panel"
      >
        <X className="size-5" />
      </Button>
    </header>
  )
}

export default TaskDetailHeader
