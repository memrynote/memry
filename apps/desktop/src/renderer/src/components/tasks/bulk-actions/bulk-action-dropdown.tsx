import { ChevronDown } from '@/lib/icons'

import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

// ============================================================================
// TYPES
// ============================================================================

export interface BulkActionOption<T = string> {
  /** Option value */
  value: T
  /** Display label */
  label: string
  /** Optional icon */
  icon?: React.ReactNode
  /** Optional color for styling */
  color?: string
  /** Whether this is a separator */
  isSeparator?: boolean
}

interface BulkActionDropdownProps<T = string> {
  /** Icon to display in trigger */
  icon: React.ReactNode
  /** Trigger label */
  label: string
  /** Dropdown options */
  options: BulkActionOption<T>[]
  /** Callback when option is selected */
  onSelect: (value: T) => void
  /** Number of selected tasks (for header) */
  selectedCount: number
  /** Whether the dropdown is disabled */
  disabled?: boolean
  /** Additional class names */
  className?: string
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Dropdown component for bulk actions that require selecting an option
 */
export const BulkActionDropdown = <T extends string | number = string>({
  icon,
  label,
  options,
  onSelect,
  selectedCount,
  disabled = false,
  className
}: BulkActionDropdownProps<T>): React.JSX.Element => {
  const { t: tPhaseF } = useT('tasks')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted',
          'focus-visible:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
      >
        {icon}
        {label}
        <ChevronDown className="size-3 ms-0.5" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="min-w-[200px]">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {label} {tPhaseF('phaseF.componentsTasksBulkActionsBulkActionDropdown.for')}
          {selectedCount}
          {tPhaseF('phaseF.componentsTasksBulkActionsBulkActionDropdown.task')}
          {selectedCount !== 1 ? 's' : ''}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {options.map((option, index) => {
          if (option.isSeparator) {
            return <DropdownMenuSeparator key={`sep-${index}`} />
          }

          return (
            <DropdownMenuItem
              key={String(option.value)}
              onClick={() => onSelect(option.value)}
              className="cursor-pointer"
            >
              {option.icon && (
                <span
                  className="me-2 flex items-center"
                  style={option.color ? { color: option.color } : undefined}
                >
                  {option.icon}
                </span>
              )}
              <span style={option.color ? { color: option.color } : undefined}>{option.label}</span>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default BulkActionDropdown
