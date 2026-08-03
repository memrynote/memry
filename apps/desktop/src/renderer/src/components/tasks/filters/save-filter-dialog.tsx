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
import { getActiveLocale } from '@/lib/active-locale'
import { useT } from '@memry/i18n/renderer'

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
  const { t: tPhaseF } = useT('tasks')
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  // Generate filter summary
  const filterSummary = useMemo(() => {
    const items: string[] = []

    // Search
    if (filters.search) {
      items.push(
        tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.summarySearch', {
          query: filters.search
        })
      )
    }

    // Projects
    if (filters.projectIds.length > 0) {
      const projectNames = filters.projectIds
        .map((id) => projects.find((p) => p.id === id)?.name)
        .filter(Boolean)
      items.push(
        tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.summaryProjects', {
          names: projectNames.join(', ')
        })
      )
    }

    // Priorities
    if (filters.priorities.length > 0) {
      const priorityLabels = filters.priorities.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      items.push(
        tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.summaryPriorities', {
          names: priorityLabels.join(', ')
        })
      )
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
          (date instanceof Date ? date : new Date(date)).toLocaleDateString(getActiveLocale(), {
            month: 'short',
            day: 'numeric'
          })
        items.push(
          tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.summaryDueRange', {
            start: formatDate(filters.dueDate.customStart),
            end: formatDate(filters.dueDate.customEnd)
          })
        )
      } else if (option) {
        items.push(
          tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.summaryDue', {
            value: option.label
          })
        )
      }
    }

    // Repeat type
    if (filters.repeatType !== 'all') {
      items.push(
        filters.repeatType === 'repeating'
          ? tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.summaryRepeatRepeating')
          : tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.summaryRepeatOneTime')
      )
    }

    // Has time
    if (filters.hasTime !== 'all') {
      items.push(
        filters.hasTime === 'with-time'
          ? tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.summaryTimeWith')
          : tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.summaryTimeWithout')
      )
    }

    return items
  }, [filters, projects, tPhaseF])

  const handleSave = (): void => {
    if (!name.trim()) {
      setError(tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.nameRequired'))
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
          <DialogTitle>
            {tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.saveFilter')}
          </DialogTitle>
          <DialogDescription>
            {tPhaseF(
              'phaseF.componentsTasksFiltersSaveFilterDialog.saveYourCurrentFilterSettingsForQuickAccessLater'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Filter name input */}
          <div className="space-y-2">
            <Label htmlFor="filter-name">
              {tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.filterName')}
            </Label>
            <Input
              id="filter-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError('')
              }}
              onKeyDown={handleKeyDown}
              placeholder={tPhaseF(
                'phaseF.componentsTasksFiltersSaveFilterDialog.eGHighPriorityThisWeek'
              )}
              autoFocus
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          {/* Current filters summary */}
          <div className="space-y-2">
            <Label className="text-muted-foreground">
              {tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.currentFilters')}
            </Label>
            <ul className="text-sm space-y-1">
              {filterSummary.length > 0 ? (
                filterSummary.map((item) => (
                  <li key={item} className="text-muted-foreground">
                    • {item}
                  </li>
                ))
              ) : (
                <li className="text-muted-foreground italic">
                  {tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.noFiltersApplied')}
                </li>
              )}
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.cancel')}
          </Button>
          <Button onClick={handleSave} disabled={filterSummary.length === 0}>
            {tPhaseF('phaseF.componentsTasksFiltersSaveFilterDialog.saveFilter2')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default SaveFilterDialog
