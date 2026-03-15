import { useState, useMemo } from 'react'
import { ChevronDown, ChevronRight, Clock, Calendar, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Status, RepeatFilterType, HasTimeFilterType } from '@/data/tasks-data'

// ============================================================================
// TYPES
// ============================================================================

interface MoreFiltersDropdownProps {
  statuses?: Status[]
  selectedStatusIds: string[]
  onStatusChange: (statusIds: string[]) => void
  showStatusFilter?: boolean
  repeatType: RepeatFilterType
  onRepeatTypeChange: (type: RepeatFilterType) => void
  hasTime: HasTimeFilterType
  onHasTimeChange: (type: HasTimeFilterType) => void
  taskCountByStatus?: Record<string, number>
  taskCountByRepeat?: { repeating: number; oneTime: number }
  taskCountByTime?: { withTime: number; withoutTime: number }
  className?: string
}

// ============================================================================
// TOGGLE SWITCH
// ============================================================================

const ToggleSwitch = ({
  enabled,
  onToggle
}: {
  enabled: boolean
  onToggle: () => void
}): React.JSX.Element => (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation()
      onToggle()
    }}
    className={cn(
      'w-8 h-[18px] ml-auto flex items-center rounded-sm shrink-0 p-0.5 transition-colors',
      enabled ? 'bg-foreground justify-end' : 'bg-border'
    )}
    role="switch"
    aria-checked={enabled}
  >
    <div className="rounded-full bg-background shrink-0 size-3.5" />
  </button>
)

// ============================================================================
// MORE FILTERS DROPDOWN COMPONENT
// ============================================================================

export const MoreFiltersDropdown = ({
  statuses = [],
  selectedStatusIds,
  onStatusChange,
  showStatusFilter = false,
  repeatType,
  onRepeatTypeChange,
  hasTime,
  onHasTimeChange,
  taskCountByStatus = {},
  taskCountByRepeat = { repeating: 0, oneTime: 0 },
  taskCountByTime = { withTime: 0, withoutTime: 0 },
  className
}: MoreFiltersDropdownProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false)
  const [showStatusPanel, setShowStatusPanel] = useState(false)

  const activeCount = useMemo(() => {
    let count = 0
    if (selectedStatusIds.length > 0) count++
    if (repeatType !== 'all') count++
    if (hasTime !== 'all') count++
    return count
  }, [selectedStatusIds, repeatType, hasTime])

  const hasSelection = activeCount > 0

  const handleToggleStatus = (statusId: string): void => {
    const nextStatusIds = selectedStatusIds.includes(statusId)
      ? selectedStatusIds.filter((id) => id !== statusId)
      : [...selectedStatusIds, statusId]
    onStatusChange(nextStatusIds)
  }

  const handleOpenChange = (open: boolean): void => {
    if (!open) setShowStatusPanel(false)
    setIsOpen(open)
  }

  return (
    <Popover open={isOpen} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('h-9 gap-2', hasSelection && 'border-primary bg-primary/5', className)}
          aria-label="More filters"
        >
          <span>More</span>
          {hasSelection && (
            <span className="bg-primary text-primary-foreground text-xs px-1.5 py-0.5 rounded-full min-w-5 text-center">
              {activeCount}
            </span>
          )}
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        className="w-[260px] p-0 rounded-sm overflow-clip shadow-[0_4px_24px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.04)]"
        align="start"
      >
        {!showStatusPanel ? (
          <div className="flex flex-col py-2">
            {/* Status — navigable sub-filter */}
            {showStatusFilter && statuses.length > 0 && (
              <button
                type="button"
                onClick={() => setShowStatusPanel(true)}
                className="flex items-center py-[9px] px-4 gap-2.5 hover:bg-accent focus:outline-none transition-colors"
              >
                <Clock className="size-3.5 text-text-tertiary" />
                <span className="text-[13px] text-foreground font-['DM_Sans_Variable',system-ui,sans-serif] leading-4">
                  Status
                </span>
                {selectedStatusIds.length > 0 && (
                  <span className="text-[11px] text-text-tertiary font-['DM_Sans_Variable',system-ui,sans-serif]">
                    ({selectedStatusIds.length})
                  </span>
                )}
                <ChevronRight className="size-2.5 text-text-tertiary ml-auto" />
              </button>
            )}

            {/* Has time */}
            <button
              type="button"
              onClick={() => setShowStatusPanel(false)}
              className="flex items-center py-[9px] px-4 gap-2.5 hover:bg-accent focus:outline-none transition-colors"
            >
              <Calendar className="size-3.5 text-text-tertiary" />
              <span className="text-[13px] text-foreground font-['DM_Sans_Variable',system-ui,sans-serif] leading-4">
                Has time set
              </span>
              <ToggleSwitch
                enabled={hasTime === 'with-time'}
                onToggle={() => onHasTimeChange(hasTime === 'with-time' ? 'all' : 'with-time')}
              />
            </button>

            {/* Divider */}
            <div className="h-px bg-border shrink-0 my-1 mx-4" />

            {/* Recurring only */}
            <button
              type="button"
              className="flex items-center py-[9px] px-4 gap-2.5 hover:bg-accent focus:outline-none transition-colors"
            >
              <RefreshCw className="size-3.5 text-text-tertiary" />
              <span className="text-[13px] text-foreground font-['DM_Sans_Variable',system-ui,sans-serif] leading-4">
                Recurring only
              </span>
              <ToggleSwitch
                enabled={repeatType === 'repeating'}
                onToggle={() =>
                  onRepeatTypeChange(repeatType === 'repeating' ? 'all' : 'repeating')
                }
              />
            </button>
          </div>
        ) : (
          /* Status sub-panel */
          <div className="flex flex-col">
            <button
              type="button"
              onClick={() => setShowStatusPanel(false)}
              className="flex items-center py-2.5 px-4 gap-1.5 bg-surface border-b border-border"
            >
              <ChevronDown className="size-2.5 text-text-tertiary rotate-90" />
              <span className="text-[13px] text-foreground font-['DM_Sans_Variable',system-ui,sans-serif] font-semibold leading-4">
                Status
              </span>
            </button>
            <div className="flex flex-col py-2">
              {statuses.map((status) => {
                const isSelected = selectedStatusIds.includes(status.id)
                const taskCount = taskCountByStatus[status.id] || 0

                return (
                  <button
                    key={status.id}
                    type="button"
                    onClick={() => handleToggleStatus(status.id)}
                    className="flex items-center gap-2.5 py-2 px-4 hover:bg-accent focus:outline-none transition-colors"
                  >
                    <div
                      className="flex items-center justify-center rounded-sm shrink-0 size-4"
                      style={{
                        borderWidth: '1.5px',
                        borderStyle: 'solid',
                        borderColor: isSelected ? status.color : 'var(--border)',
                        backgroundColor: isSelected ? `${status.color}15` : 'var(--card)'
                      }}
                    >
                      {isSelected && (
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke={status.color}
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </div>
                    <div
                      className="shrink-0 rounded-full size-2"
                      style={{ backgroundColor: status.color }}
                    />
                    <span className="text-[13px] text-foreground font-['DM_Sans_Variable',system-ui,sans-serif] leading-4">
                      {status.name}
                    </span>
                    <span className="text-[11px] ml-auto text-text-tertiary font-['DM_Sans_Variable',system-ui,sans-serif] leading-[14px]">
                      {taskCount}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export default MoreFiltersDropdown
