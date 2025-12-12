import { useState, useRef } from "react"
import { Plus } from "lucide-react"

import { cn } from "@/lib/utils"

// ============================================================================
// TYPES
// ============================================================================

interface AddSubtaskInputProps {
  parentId: string
  onAdd: (parentId: string, title: string) => void
  className?: string
}

// ============================================================================
// ADD SUBTASK INPUT COMPONENT
// ============================================================================

export const AddSubtaskInput = ({
  parentId,
  onAdd,
  className,
}: AddSubtaskInputProps): React.JSX.Element => {
  const [isActive, setIsActive] = useState(false)
  const [title, setTitle] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSubmit = (): void => {
    if (title.trim()) {
      onAdd(parentId, title.trim())
      setTitle("")
      // Keep input focused for rapid entry
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter" && title.trim()) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === "Escape") {
      setTitle("")
      setIsActive(false)
      inputRef.current?.blur()
    }
  }

  const handleFocus = (): void => {
    setIsActive(true)
  }

  const handleBlur = (): void => {
    if (!title) {
      setIsActive(false)
    }
  }

  return (
    <div className={cn("relative py-1", className)}>
      {/* Tree connector lines - CSS based for seamless connection */}
      <div
        className="absolute left-0 top-0 bottom-0 w-5"
        aria-hidden="true"
      >
        {/* Vertical line - extends to 50% height since add input is always last */}
        <div
          className="absolute left-2 w-px bg-border top-0 h-[50%]"
        />
        {/* Horizontal line - connects vertical line to content */}
        <div
          className="absolute left-2 top-1/2 w-3 h-px bg-border"
        />
      </div>

      {/* Input container */}
      <div
        className={cn(
          "flex items-center rounded-lg border transition-colors ml-7",
          isActive
            ? "border-ring bg-background shadow-sm"
            : "border-transparent hover:border-border"
        )}
      >
        <Plus
          className={cn(
            "w-4 h-4 ml-2 shrink-0",
            isActive ? "text-muted-foreground" : "text-muted-foreground/60"
          )}
          aria-hidden="true"
        />

        <input
          ref={inputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder="Add subtask..."
          className={cn(
            "flex-1 px-2 py-1.5 text-sm bg-transparent outline-none",
            "placeholder:text-muted-foreground/60"
          )}
          aria-label="Add subtask"
        />

        {isActive && title && (
          <span className="text-xs text-muted-foreground mr-2 shrink-0">
            Enter to add
          </span>
        )}
      </div>
    </div>
  )
}

export default AddSubtaskInput








