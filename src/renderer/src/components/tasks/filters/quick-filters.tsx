import { useMemo } from 'react'
import { AlertTriangle, Flag, Calendar, Repeat, HelpCircle } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { TaskFilters, QuickFilterPreset } from '@/data/tasks-data'
import { quickFilterPresets, defaultFilters } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface QuickFiltersProps {
  filters: TaskFilters
  onApply: (filters: Partial<TaskFilters>) => void
  className?: string
}

// ============================================================================
// ICON MAPPING
// ============================================================================

const iconMap: Record<string, React.ReactNode> = {
  AlertTriangle: <AlertTriangle className="size-3" />,
  Flag: <Flag className="size-3" />,
  Calendar: <Calendar className="size-3" />,
  Repeat: <Repeat className="size-3" />,
  HelpCircle: <HelpCircle className="size-3" />
}

// ============================================================================
// QUICK FILTERS COMPONENT
// ============================================================================

export const QuickFilters = ({
  filters,
  onApply,
  className
}: QuickFiltersProps): React.JSX.Element => {
  // Determine which preset is currently active
  const activePresetId = useMemo((): string | null => {
    for (const preset of quickFilterPresets) {
      let isMatch = true

      // Check each property in the preset
      if (preset.filters.priorities) {
        const filterPriorities = filters.priorities
        const presetPriorities = preset.filters.priorities
        isMatch =
          filterPriorities.length === presetPriorities.length &&
          presetPriorities.every((p) => filterPriorities.includes(p))
      }

      if (preset.filters.dueDate) {
        isMatch = isMatch && filters.dueDate.type === preset.filters.dueDate.type
      }

      if (preset.filters.repeatType) {
        isMatch = isMatch && filters.repeatType === preset.filters.repeatType
      }

      // Also check that other filters are at defaults
      if (isMatch) {
        const otherFiltersDefault =
          filters.search === '' &&
          (preset.filters.projectIds ? true : filters.projectIds.length === 0) &&
          (!preset.filters.priorities ? filters.priorities.length === 0 : true) &&
          (!preset.filters.dueDate ? filters.dueDate.type === 'any' : true) &&
          filters.statusIds.length === 0 &&
          (!preset.filters.repeatType ? filters.repeatType === 'all' : true) &&
          filters.hasTime === 'all'

        if (otherFiltersDefault) {
          return preset.id
        }
      }
    }

    return null
  }, [filters])

  const handleApply = (preset: QuickFilterPreset): void => {
    // If the preset is already active, clear all filters
    if (activePresetId === preset.id) {
      onApply(defaultFilters)
    } else {
      // Apply the preset filters (merge with defaults to reset other filters)
      onApply({
        ...defaultFilters,
        ...preset.filters
      })
    }
  }

  return (
    <div className={cn('flex items-center gap-2 px-4 py-2 bg-muted/30 border-b', className)}>
      <span className="text-xs text-muted-foreground shrink-0">Quick filters:</span>

      <div className="flex flex-wrap gap-1.5">
        {quickFilterPresets.map((preset) => {
          const isActive = activePresetId === preset.id
          const icon = iconMap[preset.icon]

          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => handleApply(preset)}
              className={cn(
                'inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-full border transition-colors',
                isActive
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background border-border text-foreground hover:bg-accent'
              )}
            >
              {icon}
              <span>{preset.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default QuickFilters
