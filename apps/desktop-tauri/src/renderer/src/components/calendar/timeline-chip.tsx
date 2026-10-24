import { calendarColorChipVars } from '@/lib/calendar-colors'
import { eventTypeChipVars, type ChipColorVars } from '@/lib/event-type-colors'
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
