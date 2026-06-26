/**
 * Selection Checkbox
 *
 * Tri-state select box for the folder table's leading selection column.
 * Mirrors the Paper "Folder View — Linear" row design: an empty bordered box
 * when unselected, a tint-filled box with a white check when selected, and a
 * tint-filled box with a white dash for the header's partial (indeterminate)
 * select-all state.
 *
 * Uses theme tokens (var(--tint)) instead of hard-coded hex so it stays correct
 * across light/dark themes. The unchecked box fades in on row hover (relies on a
 * `group/row` ancestor) unless `alwaysVisible` is set — the header select-all and
 * rows in an active selection keep their box visible.
 */

import { Check, Minus } from '@/lib/icons'
import { cn } from '@/lib/utils'

/** Fixed width (px) of the leading selection column — shared by header, rows, and footer. */
export const SELECT_COLUMN_WIDTH = 36

export type SelectionState = 'checked' | 'indeterminate' | 'unchecked'

interface SelectionCheckboxProps {
  state: SelectionState
  onToggle: () => void
  /** Keep the box visible even when unchecked (header, or rows during an active selection). */
  alwaysVisible?: boolean
  label: string
}

export function SelectionCheckbox({
  state,
  onToggle,
  alwaysVisible,
  label
}: SelectionCheckboxProps): React.JSX.Element {
  const filled = state !== 'unchecked'
  const visible = alwaysVisible || filled
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'indeterminate' ? 'mixed' : state === 'checked'}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        'flex size-3.5 items-center justify-center rounded-sm transition-opacity',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--tint-ring)] focus-visible:ring-offset-1',
        filled
          ? 'bg-[var(--tint)] text-[var(--tint-foreground)]'
          : 'border-[1.5px] border-muted-foreground/40 hover:border-muted-foreground/70',
        !visible && 'opacity-0 group-hover/row:opacity-100'
      )}
    >
      {state === 'checked' && <Check className="size-2.5" strokeWidth={3.5} />}
      {state === 'indeterminate' && <Minus className="size-2.5" strokeWidth={3.5} />}
    </button>
  )
}

export default SelectionCheckbox
