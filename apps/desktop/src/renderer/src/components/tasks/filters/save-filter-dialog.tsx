import { useState, useMemo } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { TaskFilters, TaskSort, Project } from '@/data/tasks-data'
import { dueDateFilterOptions } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface SaveFilterDialogProps {
  isOpen: boolean
  onClose: () => void
  onSave: (name: string) => void
  filters: TaskFilters
  sort?: TaskSort
  projects: Project[]
}

// ============================================================================
// SAVE FILTER DIALOG COMPONENT
// ============================================================================

export const SaveFilterDialog = ({
  isOpen,
  onClose,
  onSave,
  filters,
  sort: _sort,
  projects
}: SaveFilterDialogProps): React.JSX.Element => {
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  // Generate filter summary
  const filterSummary = useMemo(() => {
    const items: string[] = []

    // Search
    if (filters.search) {
      items.push(`Search: "${filters.search}"`)
    }

    // Projects
    if (filters.projectIds.length > 0) {
      const projectNames = filters.projectIds
        .map((id) => projects.find((p) => p.id === id)?.name)
        .filter(Boolean)
      items.push(`Project: ${projectNames.join(', ')}`)
    }

    // Priorities
    if (filters.priorities.length > 0) {
      const priorityLabels = filters.priorities.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      items.push(`Priority: ${priorityLabels.join(', ')}`)
    }

    // Due date
    if (filters.dueDate.type !== 'any') {
      const option = dueDateFilterOptions.find((o) => o.value === filters.dueDate.type)
      if (
        filters.dueDate.type === 'custom' &&
        filters.dueDate.customStart &&
        filters.dueDate.customEnd
      ) {
        const formatDate = (date: Date | string): string =>
          (date instanceof Date ? date : new Date(date)).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric'
          })
        items.push(
          `Due: ${formatDate(filters.dueDate.customStart)} - ${formatDate(filters.dueDate.customEnd)}`
        )
      } else if (option) {
        items.push(`Due: ${option.label}`)
      }
    }

    // Repeat type
    if (filters.repeatType !== 'all') {
      items.push(
        `Repeat: ${filters.repeatType === 'repeating' ? 'Repeating only' : 'One-time only'}`
      )
    }

    // Has time
    if (filters.hasTime !== 'all') {
      items.push(`Time: ${filters.hasTime === 'with-time' ? 'With time' : 'Without time'}`)
    }

    return items
  }, [filters, projects])

  const handleSave = (): void => {
    if (!name.trim()) {
      setError('Please enter a name for this filter')
      return
    }

    onSave(name.trim())
    setName('')
    setError('')
    onClose()
  }

  const handleClose = (): void => {
    setName('')
    setError('')
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSave()
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save Filter</DialogTitle>
          <DialogDescription>
            Save your current filter settings for quick access later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Filter name input */}
          <div className="space-y-2">
            <Label htmlFor="filter-name">Filter Name</Label>
            <Input
              id="filter-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError('')
              }}
              onKeyDown={handleKeyDown}
              placeholder="e.g., High priority this week"
              autoFocus
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          {/* Current filters summary */}
          <div className="space-y-2">
            <Label className="text-muted-foreground">Current filters:</Label>
            <ul className="text-sm space-y-1">
              {filterSummary.length > 0 ? (
                filterSummary.map((item, index) => (
                  <li key={index} className="text-muted-foreground">
                    • {item}
                  </li>
                ))
              ) : (
                <li className="text-muted-foreground italic">No filters applied</li>
              )}
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={filterSummary.length === 0}>
            Save Filter
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default SaveFilterDialog
