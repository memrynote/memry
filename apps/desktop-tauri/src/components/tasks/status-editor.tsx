import { useState, useCallback, useRef } from 'react'
import { GripVertical, X, Plus } from '@/lib/icons'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  statusColors,
  statusTypeOptions,
  createDefaultStatus,
  canDeleteStatus,
  type Status,
  type StatusType
} from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface StatusEditorProps {
  statuses: Status[]
  onChange: (statuses: Status[]) => void
  error?: string
}

interface StatusRowProps {
  status: Status
  index: number
  canDelete: boolean
  deleteReason?: string
  onUpdate: (id: string, updates: Partial<Status>) => void
  onDelete: (id: string) => void
  onDragStart: (index: number) => void
  onDragOver: (index: number) => void
  onDragEnd: () => void
  isDragging: boolean
  isDragOver: boolean
}

// ============================================================================
// STATUS COLOR PICKER (inline popover)
// ============================================================================

const StatusColorPicker = ({
  value,
  onChange
}: {
  value: string
  onChange: (color: string) => void
}): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)

  const handleColorSelect = (color: string) => (): void => {
    onChange(color)
    setIsOpen(false)
  }

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="size-4 shrink-0 rounded-full transition-transform hover:scale-110 focus-visible:outline-none"
          style={{ backgroundColor: value }}
          aria-label="Change status color"
        />
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <div className="grid grid-cols-5 gap-1.5">
          {statusColors.map((color) => (
            <button
              key={color.id}
              type="button"
              onClick={handleColorSelect(color.value)}
              className={cn(
                'size-6 rounded-full transition-transform hover:scale-110',
                'focus-visible:outline-none',
                value === color.value && 'ring-2 ring-ring ring-offset-1'
              )}
              style={{ backgroundColor: color.value }}
              aria-label={`Select ${color.id} color`}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ============================================================================
// STATUS TYPE DROPDOWN
// ============================================================================

const StatusTypeDropdown = ({
  value,
  onChange
}: {
  value: StatusType
  onChange: (type: StatusType) => void
}): React.JSX.Element => {
  const currentOption = statusTypeOptions.find((opt) => opt.value === value)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-text-secondary">
          {currentOption?.label || 'To Do'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {statusTypeOptions.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onChange(option.value)}
            className={cn(value === option.value && 'bg-accent')}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ============================================================================
// STATUS ROW COMPONENT
// ============================================================================

const StatusRow = ({
  status,
  index,
  canDelete,
  deleteReason,
  onUpdate,
  onDelete,
  onDragStart,
  onDragOver,
  onDragEnd,
  isDragging,
  isDragOver
}: StatusRowProps): React.JSX.Element => {
  const inputRef = useRef<HTMLInputElement>(null)

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    onUpdate(status.id, { name: e.target.value })
  }

  const handleColorChange = (color: string): void => {
    onUpdate(status.id, { color })
  }

  const handleTypeChange = (type: StatusType): void => {
    onUpdate(status.id, { type })
  }

  const handleDelete = (): void => {
    onDelete(status.id)
  }

  const handleDragStart = (e: React.DragEvent): void => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
    onDragStart(index)
  }

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    onDragOver(index)
  }

  const handleDragEnd = (): void => {
    onDragEnd()
  }

  const deleteButton = (
    <button
      type="button"
      onClick={handleDelete}
      disabled={!canDelete}
      className={cn(
        'rounded p-1 transition-colors',
        canDelete
          ? 'text-text-tertiary hover:bg-destructive/10 hover:text-destructive'
          : 'cursor-not-allowed text-text-tertiary/50'
      )}
      aria-label={canDelete ? 'Delete status' : deleteReason}
    >
      <X className="size-4" />
    </button>
  )

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      className={cn(
        'flex items-center gap-2 rounded-sm border bg-background px-2 py-1.5 transition-all',
        isDragging && 'opacity-50',
        isDragOver && 'border-primary bg-accent/50'
      )}
    >
      {/* Drag Handle */}
      <div
        className="cursor-grab text-text-tertiary hover:text-text-secondary active:cursor-grabbing"
        aria-label="Drag to reorder"
      >
        <GripVertical className="size-4" />
      </div>

      {/* Color Picker */}
      <StatusColorPicker value={status.color} onChange={handleColorChange} />

      {/* Status Name Input */}
      <Input
        ref={inputRef}
        type="text"
        value={status.name}
        onChange={handleNameChange}
        placeholder="Status name"
        maxLength={30}
        className="h-7 flex-1 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
      />

      {/* Type Dropdown */}
      <StatusTypeDropdown value={status.type} onChange={handleTypeChange} />

      {/* Delete Button (with tooltip if disabled) */}
      {!canDelete && deleteReason ? (
        <Tooltip>
          <TooltipTrigger asChild>{deleteButton}</TooltipTrigger>
          <TooltipContent side="left">
            <p>{deleteReason}</p>
          </TooltipContent>
        </Tooltip>
      ) : (
        deleteButton
      )}
    </div>
  )
}

// ============================================================================
// STATUS EDITOR COMPONENT
// ============================================================================

export const StatusEditor = ({
  statuses,
  onChange,
  error
}: StatusEditorProps): React.JSX.Element => {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  // Sort statuses by order
  const sortedStatuses = [...statuses].sort((a, b) => a.order - b.order)

  const handleUpdate = useCallback(
    (id: string, updates: Partial<Status>): void => {
      const newStatuses = statuses.map((s) => (s.id === id ? { ...s, ...updates } : s))
      onChange(newStatuses)
    },
    [statuses, onChange]
  )

  const handleDelete = useCallback(
    (id: string): void => {
      const newStatuses = statuses.filter((s) => s.id !== id).map((s, i) => ({ ...s, order: i }))
      onChange(newStatuses)
    },
    [statuses, onChange]
  )

  const handleAddStatus = (): void => {
    const newStatus = createDefaultStatus(statuses.length)
    onChange([...statuses, newStatus])
  }

  const handleDragStart = (index: number): void => {
    setDragIndex(index)
  }

  const handleDragOver = (index: number): void => {
    if (dragIndex !== null && dragIndex !== index) {
      setDragOverIndex(index)
    }
  }

  const handleDragEnd = (): void => {
    if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
      const newStatuses = [...sortedStatuses]
      const [draggedItem] = newStatuses.splice(dragIndex, 1)
      newStatuses.splice(dragOverIndex, 0, draggedItem)

      // Update order values
      const reorderedStatuses = newStatuses.map((s, i) => ({ ...s, order: i }))
      onChange(reorderedStatuses)
    }

    setDragIndex(null)
    setDragOverIndex(null)
  }

  return (
    <div className="space-y-3">
      {/* Status List */}
      <div className="space-y-1.5">
        {sortedStatuses.map((status, index) => {
          const { canDelete, reason } = canDeleteStatus(statuses, status.id)
          return (
            <StatusRow
              key={status.id}
              status={status}
              index={index}
              canDelete={canDelete}
              deleteReason={reason}
              onUpdate={handleUpdate}
              onDelete={handleDelete}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              isDragging={dragIndex === index}
              isDragOver={dragOverIndex === index}
            />
          )
        })}
      </div>

      {/* Add Status Button */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleAddStatus}
        className="gap-1 text-text-tertiary hover:text-text-secondary"
      >
        <Plus className="size-4" />
        Add status
      </Button>

      {/* Error Message */}
      {error && (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <span>⚠️</span>
          {error}
        </p>
      )}
    </div>
  )
}

export default StatusEditor
