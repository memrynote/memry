import { useState, useRef } from "react"
import { ClipboardList, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { BulkAddSubtasks } from "./bulk-add-subtasks"
import { cn } from "@/lib/utils"

// ============================================================================
// TYPES
// ============================================================================

interface SubtasksEmptyStateProps {
  parentId: string
  onAddFirst: (title: string) => void
  onBulkAdd: (titles: string[]) => void
}

// ============================================================================
// SUBTASKS EMPTY STATE COMPONENT
// ============================================================================

export const SubtasksEmptyState = ({
  parentId,
  onAddFirst,
  onBulkAdd,
}: SubtasksEmptyStateProps): React.JSX.Element => {
  const [showInput, setShowInput] = useState(false)
  const [title, setTitle] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const handleAddFirstClick = (): void => {
    setShowInput(true)
    setTimeout(() => {
      inputRef.current?.focus()
    }, 0)
  }

  const handleSubmit = (): void => {
    if (title.trim()) {
      onAddFirst(title.trim())
      setTitle("")
      // Keep showing input for adding more
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" && title.trim()) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === "Escape") {
      setTitle("")
      setShowInput(false)
    }
  }

  return (
    <div className="text-center py-6">
      {/* Icon */}
      <div className="flex justify-center mb-3">
        <div className="p-3 rounded-full bg-muted">
          <ClipboardList className="size-6 text-muted-foreground" />
        </div>
      </div>

      {/* Title */}
      <h4 className="text-sm font-medium mb-1">
        Break this task into smaller steps
      </h4>

      {/* Description */}
      <p className="text-xs text-muted-foreground mb-4 max-w-[250px] mx-auto">
        Subtasks help you track progress and stay organized on complex work.
      </p>

      {/* Add first subtask */}
      {!showInput ? (
        <Button
          variant="outline"
          size="sm"
          onClick={handleAddFirstClick}
          className="gap-1.5"
        >
          <Plus className="size-4" />
          Add first subtask
        </Button>
      ) : (
        <div
          className={cn(
            "flex items-center rounded-lg border transition-colors mx-auto max-w-[280px]",
            "border-ring bg-background shadow-sm"
          )}
        >
          <Plus className="w-4 h-4 ml-3 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (!title) setShowInput(false)
            }}
            placeholder="First subtask..."
            className={cn(
              "flex-1 px-2 py-2 text-sm bg-transparent outline-none",
              "placeholder:text-muted-foreground/60"
            )}
            aria-label="Add first subtask"
          />
          {title && (
            <span className="text-xs text-muted-foreground mr-3 shrink-0">
              Enter
            </span>
          )}
        </div>
      )}

      {/* Bulk add section */}
      <BulkAddSubtasks onAdd={onBulkAdd} className="mt-6 text-left" />
    </div>
  )
}

export default SubtasksEmptyState








