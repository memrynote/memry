import { cn } from '@/lib/utils'
import { PickerEmpty } from './picker-empty'
import { PickerLabelFilterContext } from './types'

interface PickerListProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Filter the rows by label against the picker's search query, for a menu
   * whose rows are declared inline. `emptyMessage` shows when none match.
   */
  filterByLabel?: boolean
  emptyMessage?: string
}

export function PickerList({
  className,
  children,
  filterByLabel = false,
  emptyMessage,
  ...props
}: PickerListProps): React.JSX.Element {
  return (
    <div
      data-slot="picker-list"
      className={cn('flex flex-col p-1 min-h-0 overflow-y-auto', className)}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- semantic tag would change default styles/behavior; ARIA role kept to preserve visuals and semantics
      role="listbox"
      {...props}
    >
      <PickerLabelFilterContext.Provider value={filterByLabel}>
        {children}
      </PickerLabelFilterContext.Provider>
      {/* Hidden until every row filters itself out and this is the only child. */}
      {filterByLabel && <PickerEmpty message={emptyMessage} className="hidden only:flex" />}
    </div>
  )
}
