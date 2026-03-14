import { motion } from 'framer-motion'

import { PrioritySelect } from '@/components/tasks/priority-select'
import { cn } from '@/lib/utils'
import { formatDateShort, startOfDay, isBefore, isSameDay, addDays } from '@/lib/task-utils'
import type { Task, Priority } from '@/data/sample-tasks'
import { Calendar, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DatePickerCalendar } from '@/components/tasks/date-picker-calendar'
import { useState } from 'react'

// ============================================================================
// TYPES
// ============================================================================

interface SubtaskExpandedDetailsProps {
  subtask: Task
  onUpdate: (updates: Partial<Task>) => void
}

// ============================================================================
// SIMPLE DUE DATE PICKER FOR SUBTASKS
// ============================================================================

interface SimpleDueDatePickerProps {
  value: Date | null
  onChange: (date: Date | null) => void
}

const SimpleDueDatePicker = ({ value, onChange }: SimpleDueDatePickerProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)

  const handleSelect = (date: Date | undefined): void => {
    onChange(date || null)
    setIsOpen(false)
  }

  const handleClear = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onChange(null)
    setIsOpen(false)
  }

  // Determine display text and status color
  const getDisplayInfo = (): { text: string; className: string } => {
    if (!value) {
      return { text: 'No date', className: 'text-muted-foreground' }
    }

    const today = startOfDay(new Date())
    const selectedDate = startOfDay(value)

    if (isBefore(selectedDate, today)) {
      return { text: formatDateShort(value), className: 'text-destructive' }
    }
    if (isSameDay(selectedDate, today)) {
      return { text: 'Today', className: 'text-amber-600' }
    }
    if (isSameDay(selectedDate, addDays(today, 1))) {
      return { text: 'Tomorrow', className: 'text-blue-600' }
    }
    return { text: formatDateShort(value), className: 'text-foreground' }
  }

  const displayInfo = getDisplayInfo()

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('w-full justify-start text-left h-8', displayInfo.className)}
        >
          <Calendar className="mr-2 h-3.5 w-3.5" />
          <span className="truncate">{displayInfo.text}</span>
          {value && (
            <X className="ml-auto h-3.5 w-3.5 opacity-50 hover:opacity-100" onClick={handleClear} />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[296px] p-3" align="start">
        <DatePickerCalendar selected={value || undefined} onSelect={handleSelect} />
      </PopoverContent>
    </Popover>
  )
}

// ============================================================================
// SUBTASK EXPANDED DETAILS COMPONENT
// ============================================================================

export const SubtaskExpandedDetails = ({
  subtask,
  onUpdate
}: SubtaskExpandedDetailsProps): React.JSX.Element => {
  const handlePriorityChange = (priority: Priority): void => {
    onUpdate({ priority })
  }

  const handleDueDateChange = (dueDate: Date | null): void => {
    onUpdate({ dueDate })
  }

  const handleDescriptionChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    onUpdate({ description: e.target.value })
  }

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeInOut' }}
      className="overflow-hidden"
    >
      <div className="px-3 pb-3 pt-0 border-t mt-2">
        {/* Property Grid */}
        <div className="grid grid-cols-3 gap-3 mt-3">
          {/* Priority picker */}
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wide block mb-1.5">
              Priority
            </label>
            <PrioritySelect value={subtask.priority} onChange={handlePriorityChange} compact />
          </div>

          {/* Due date picker */}
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wide block mb-1.5">
              Due Date
            </label>
            <SimpleDueDatePicker value={subtask.dueDate} onChange={handleDueDateChange} />
          </div>

          {/* Assignee placeholder */}
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wide block mb-1.5">
              Assigned
            </label>
            <span className="text-sm text-muted-foreground h-8 flex items-center">—</span>
          </div>
        </div>

        {/* Notes field */}
        <div className="mt-3">
          <label className="text-xs text-muted-foreground uppercase tracking-wide block mb-1.5">
            Notes
          </label>
          <textarea
            value={subtask.description || ''}
            onChange={handleDescriptionChange}
            placeholder="Add notes..."
            className={cn(
              'w-full p-2 text-sm border rounded-sm resize-none',
              'bg-background focus:outline-none focus:ring-2 focus:ring-ring',
              'placeholder:text-muted-foreground/60'
            )}
            rows={2}
          />
        </div>
      </div>
    </motion.div>
  )
}

export default SubtaskExpandedDetails
