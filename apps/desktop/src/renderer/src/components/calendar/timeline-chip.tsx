import { calendarColorChipVars } from '@/lib/calendar-colors'
import { eventTypeChipVars, type ChipColorVars } from '@/lib/event-type-colors'
import { Check } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { TimelineEventRow, TimelinePlacement } from './timeline-model'

// ---------------------------------------------------------------------------
// Chip colour: the calendar's rail / surface / meta / solid shape
// ---------------------------------------------------------------------------

const HEX_COLOR = /^#[0-9a-f]{6}$/i

/**
 * A task bar takes its project's colour through the same shape a chip with
 * its own colour uses; a colour that is not `#rrggbb` falls back to the task hue.
 */
export function taskBarVars(projectColor: string): ChipColorVars {
  return HEX_COLOR.test(projectColor)
    ? calendarColorChipVars(projectColor)
    : eventTypeChipVars('task')
}

export function eventBarVars(row: TimelineEventRow): ChipColorVars {
  return row.displayColor && HEX_COLOR.test(row.displayColor)
    ? calendarColorChipVars(row.displayColor)
    : eventTypeChipVars(row.item.visualType)
}

interface ChipBarProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'style'> {
  vars: ChipColorVars
  position: React.CSSProperties
  placement: TimelinePlacement
  /** Selected, dragged, or its card is open: the one solid shape on screen. */
  solid: boolean
  done?: boolean
}

/**
 * A calendar chip stretched across days: 3px rail, tinted surface, title in
 * ink. Same anatomy and states as `CalendarItemChip`.
 */
export function ChipBar({
  vars,
  position,
  placement,
  solid,
  done = false,
  className,
  children,
  ...rest
}: ChipBarProps): React.JSX.Element {
  return (
    <div
      {...rest}
      style={{ ...vars, ...position }}
      className={cn(
        'group/bar absolute top-[5px] flex h-[22px] items-center overflow-hidden rounded-[6px]',
        solid
          ? 'bg-(--chip-solid) text-(--chip-solid-ink) shadow-sm'
          : done
            ? 'bg-[color-mix(in_srgb,var(--chip-surface)_55%,var(--background))] text-(--cal-ink)'
            : 'bg-(--chip-surface) text-(--cal-ink) transition-colors duration-100 ease-out hover:bg-[color-mix(in_srgb,var(--chip-rail)_12%,var(--chip-surface))]',
        placement.clippedStart && 'rounded-s-none',
        placement.clippedEnd && 'rounded-e-none',
        className
      )}
    >
      {!placement.clippedStart && (
        <span
          aria-hidden="true"
          data-chip-rail
          className={cn(
            'pointer-events-none absolute inset-y-[3px] start-[3px] w-[3px] rounded-full',
            solid
              ? 'bg-[color-mix(in_srgb,var(--chip-solid-ink)_55%,transparent)]'
              : 'bg-(--chip-rail)'
          )}
        />
      )}
      {children}
    </div>
  )
}

/** The chip's checkbox: complete (or reopen) without opening anything. */
export function ChipCheckbox({
  checked,
  solid,
  label,
  onToggle
}: {
  checked: boolean
  solid: boolean
  label: string
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      data-testid="timeline-complete"
      className="flex shrink-0 cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-(--tint-ring)"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      <span
        className={cn(
          'grid size-3 place-content-center rounded-[4px] border-[1.5px]',
          solid ? 'border-(--chip-solid-ink)' : 'border-(--chip-rail)',
          checked && !solid && 'bg-(--chip-rail) text-white',
          checked && solid && 'bg-(--chip-solid-ink) text-(--chip-solid)'
        )}
      >
        {checked && <Check className="size-2.5" />}
      </span>
    </button>
  )
}
