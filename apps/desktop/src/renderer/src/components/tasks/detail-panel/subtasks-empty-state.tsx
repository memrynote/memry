import { useState, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface SubtasksEmptyStateProps {
  parentId: string
  onAddFirst: (title: string) => void
  onBulkAdd: (titles: string[]) => void
}

export const SubtasksEmptyState = ({
  onAddFirst,
  onBulkAdd
}: SubtasksEmptyStateProps): React.JSX.Element => {
  const [text, setText] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const isBulk = lines.length > 1

  const handleSubmit = (): void => {
    if (lines.length === 0) return

    if (isBulk) {
      onBulkAdd(lines)
    } else {
      onAddFirst(lines[0])
    }
    setText('')
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && lines.length > 0) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && lines.length === 1) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === 'Escape') {
      setText('')
      textareaRef.current?.blur()
    }
  }

  return (
    <div>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        placeholder="Add subtask — one per line for multiple"
        rows={isFocused || text ? 3 : 1}
        className={cn(
          'w-full px-3 py-2 text-sm rounded-sm border resize-none transition-all',
          'bg-background placeholder:text-muted-foreground/50',
          'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-0',
          isFocused || text
            ? 'border-ring shadow-sm'
            : 'border-dashed border-border hover:border-muted-foreground/50'
        )}
        aria-label="Add subtasks"
      />

      {lines.length > 0 && (
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-muted-foreground">
            {isBulk ? (
              <>
                {lines.length} subtasks —{' '}
                <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">
                  {navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+↵
                </kbd>{' '}
                to add all
              </>
            ) : (
              <>
                <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">↵</kbd> to add
              </>
            )}
          </span>
          {isBulk && (
            <Button size="sm" variant="default" onClick={handleSubmit} className="h-7 text-xs">
              Add {lines.length}
            </Button>
          )}
        </div>
      )}

      {!text && !isFocused && (
        <p className="text-[11px] text-muted-foreground/60 mt-1.5 leading-tight">
          Paste or type multiple lines to bulk-add
        </p>
      )}
    </div>
  )
}

export default SubtasksEmptyState
