import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ============================================================================
// TYPES
// ============================================================================

interface BulkAddSubtasksProps {
  onAdd: (titles: string[]) => void
  className?: string
}

// ============================================================================
// BULK ADD SUBTASKS COMPONENT
// ============================================================================

export const BulkAddSubtasks = ({ onAdd, className }: BulkAddSubtasksProps): React.JSX.Element => {
  const [text, setText] = useState('')

  // Parse lines from text
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const handleAdd = (): void => {
    if (lines.length > 0) {
      onAdd(lines)
      setText('')
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // Cmd/Ctrl + Enter to submit
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && lines.length > 0) {
      e.preventDefault()
      handleAdd()
    }
  }

  return (
    <div className={cn('mt-4', className)}>
      <p className="text-xs text-muted-foreground mb-2">Or add multiple subtasks (one per line):</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={`Write blog post
Design graphics
Schedule newsletter`}
        className={cn(
          'w-full p-3 text-sm border rounded-lg resize-none',
          'bg-background focus:outline-none focus:ring-2 focus:ring-ring',
          'placeholder:text-muted-foreground/50'
        )}
        rows={3}
      />
      {lines.length > 0 && (
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-muted-foreground">
            {lines.length} subtask{lines.length !== 1 ? 's' : ''} to add
          </span>
          <Button size="sm" onClick={handleAdd}>
            Add {lines.length} subtask{lines.length !== 1 ? 's' : ''}
          </Button>
        </div>
      )}
    </div>
  )
}

export default BulkAddSubtasks
