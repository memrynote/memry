/**
 * SelectableList Components
 *
 * Reusable list components with selection support, collapsible sections,
 * and editorial styling. Used in dialogs and selection interfaces.
 */

import { useState, createContext, useContext } from 'react'
import { Check, ChevronRight, FileText } from '@/lib/icons'
import { cn } from '@/lib/utils'

// ============================================================================
// Context for selection state
// ============================================================================

interface SelectableListContextValue {
  selectedId: string | null
  onSelect: (id: string) => void
}

const SelectableListContext = createContext<SelectableListContextValue | null>(null)

function useSelectableList() {
  const context = useContext(SelectableListContext)
  if (!context) {
    throw new Error('SelectableListItem must be used within a SelectableListSection')
  }
  return context
}

// ============================================================================
// SelectableListSection - Collapsible section with header
// ============================================================================

export interface SelectableListSectionProps {
  /** Section title */
  title: string
  /** Optional icon before title */
  icon?: React.ReactNode
  /** Number of items (shown as count badge) */
  count?: number
  /** If true, section can be collapsed */
  collapsible?: boolean
  /** Default collapsed state (only if collapsible) */
  defaultCollapsed?: boolean
  /** Currently selected item ID */
  selectedId?: string | null
  /** Callback when an item is selected */
  onSelect?: (id: string) => void
  /** Section content (SelectableListItem components) */
  children: React.ReactNode
  /** Additional class names */
  className?: string
}

export function SelectableListSection({
  title,
  icon,
  count,
  collapsible = false,
  defaultCollapsed = false,
  selectedId = null,
  onSelect = () => {},
  children,
  className
}: SelectableListSectionProps) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed)

  return (
    <SelectableListContext.Provider value={{ selectedId, onSelect }}>
      <div className={className}>
        <button
          type="button"
          onClick={() => collapsible && setIsCollapsed(!isCollapsed)}
          className={cn(
            'flex items-center gap-2 mb-2 w-full text-left',
            collapsible && 'cursor-pointer group'
          )}
          disabled={!collapsible}
        >
          {collapsible && (
            <ChevronRight
              className={cn(
                'w-3.5 h-3.5 text-muted-foreground/40 transition-transform duration-200',
                'group-hover:text-muted-foreground/60',
                !isCollapsed && 'rotate-90'
              )}
            />
          )}
          {icon && <span className="text-amber-600 dark:text-amber-500">{icon}</span>}
          <h3
            className={cn(
              'text-xs font-semibold uppercase tracking-wider text-muted-foreground/60',
              collapsible && 'group-hover:text-muted-foreground/80'
            )}
          >
            {title}
          </h3>
          {count !== undefined && <span className="text-xs text-muted-foreground/40">{count}</span>}
          <div className="flex-1 h-px bg-gradient-to-r from-border/40 to-transparent" />
        </button>

        {!isCollapsed && <div className="space-y-0.5">{children}</div>}
      </div>
    </SelectableListContext.Provider>
  )
}

// ============================================================================
// SelectableListItem - Selectable row with radio indicator
// ============================================================================

export interface SelectableListItemProps {
  /** Unique identifier for this item */
  id: string
  /** Primary label */
  label: string
  /** Optional description text */
  description?: string
  /** Optional icon (emoji string or React node) */
  icon?: string | React.ReactNode
  /** Optional badge element (e.g., lock icon for built-in) */
  badge?: React.ReactNode
  /** Additional class names */
  className?: string
}

export function SelectableListItem({
  id,
  label,
  description,
  icon,
  badge,
  className
}: SelectableListItemProps) {
  const { selectedId, onSelect } = useSelectableList()
  const isSelected = selectedId === id

  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={cn(
        'group relative w-full text-left',
        'flex items-center gap-3',
        'px-3 py-2.5 rounded-md',
        'transition-all duration-150 ease-out',
        // Base state
        'hover:bg-muted/50',
        // Selected state
        isSelected && [
          'bg-amber-50 dark:bg-amber-950/30',
          'hover:bg-amber-50 dark:hover:bg-amber-950/30'
        ],
        className
      )}
    >
      {/* Selection indicator */}
      <div
        className={cn(
          'flex-shrink-0 w-5 h-5 rounded-full border-2',
          'flex items-center justify-center',
          'transition-all duration-150',
          isSelected
            ? 'bg-amber-500 border-amber-500 dark:bg-amber-500 dark:border-amber-500'
            : 'border-muted-foreground/30 group-hover:border-muted-foreground/50'
        )}
      >
        {isSelected && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
      </div>

      {/* Icon */}
      <div
        className={cn(
          'flex-shrink-0 w-9 h-9 rounded-md flex items-center justify-center text-lg',
          'transition-colors duration-150',
          isSelected ? 'bg-amber-100 dark:bg-amber-900/40' : 'bg-muted/60 dark:bg-muted/40',
          'group-hover:bg-muted dark:group-hover:bg-muted/60'
        )}
      >
        {typeof icon === 'string' ? (
          icon
        ) : icon ? (
          icon
        ) : (
          <FileText className="w-4 h-4 text-muted-foreground/50" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn('font-medium text-sm truncate', 'text-foreground/90')}>{label}</span>
          {badge}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground/60 truncate mt-0.5">{description}</p>
        )}
      </div>
    </button>
  )
}

// ============================================================================
// Standalone version without context (for simpler use cases)
// ============================================================================

export interface StandaloneSelectableItemProps extends Omit<SelectableListItemProps, 'id'> {
  /** Whether the item is selected */
  isSelected?: boolean
  /** Click handler */
  onClick?: () => void
}

export function StandaloneSelectableItem({
  label,
  description,
  icon,
  badge,
  isSelected = false,
  onClick,
  className
}: StandaloneSelectableItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative w-full text-left',
        'flex items-center gap-3',
        'px-3 py-2.5 rounded-md',
        'transition-all duration-150 ease-out',
        'hover:bg-muted/50',
        isSelected && [
          'bg-amber-50 dark:bg-amber-950/30',
          'hover:bg-amber-50 dark:hover:bg-amber-950/30'
        ],
        className
      )}
    >
      {/* Selection indicator */}
      <div
        className={cn(
          'flex-shrink-0 w-5 h-5 rounded-full border-2',
          'flex items-center justify-center',
          'transition-all duration-150',
          isSelected
            ? 'bg-amber-500 border-amber-500 dark:bg-amber-500 dark:border-amber-500'
            : 'border-muted-foreground/30 group-hover:border-muted-foreground/50'
        )}
      >
        {isSelected && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
      </div>

      {/* Icon */}
      <div
        className={cn(
          'flex-shrink-0 w-9 h-9 rounded-md flex items-center justify-center text-lg',
          'transition-colors duration-150',
          isSelected ? 'bg-amber-100 dark:bg-amber-900/40' : 'bg-muted/60 dark:bg-muted/40',
          'group-hover:bg-muted dark:group-hover:bg-muted/60'
        )}
      >
        {typeof icon === 'string' ? (
          icon
        ) : icon ? (
          icon
        ) : (
          <FileText className="w-4 h-4 text-muted-foreground/50" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn('font-medium text-sm truncate', 'text-foreground/90')}>{label}</span>
          {badge}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground/60 truncate mt-0.5">{description}</p>
        )}
      </div>
    </button>
  )
}
