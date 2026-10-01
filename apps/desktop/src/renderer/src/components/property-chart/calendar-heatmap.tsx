import { useState } from 'react'
import { weekdayOf, type ChartDay } from '@/lib/property-chart/chart-model'
import {
  ChartTooltip,
  useChartFormat,
  useMeasuredWidth,
  type ChartTooltipState
} from './chart-parts'

const GAP = 3
const LABEL_WIDTH = 30
const HEADER_HEIGHT = 16
const MIN_CELL = 8
const MAX_CELL = 18

/** A cell's fill, as any CSS colour, including `var(...)` and `color-mix(...)`. */
export type HeatmapColor = (day: ChartDay) => string

export interface CalendarHeatmapProps {
  days: ChartDay[]
  colorFor: HeatmapColor
  describe: (day: ChartDay) => string
  onOpenDay?: (day: ChartDay) => void
  ariaLabel: string
  /** Largest cell edge; the popover uses a bigger one than the block. */
  maxCell?: number
}

/**
 * Days as squares, a column per week, Monday on top: the contribution-graph
 * layout. Month names sit over the week a month starts in.
 */
export function CalendarHeatmap({
  days,
  colorFor,
  describe,
  onOpenDay,
  ariaLabel,
  maxCell = MAX_CELL
}: CalendarHeatmapProps): React.JSX.Element {
  const [containerRef, width] = useMeasuredWidth<HTMLDivElement>()
  const format = useChartFormat()
  const [hover, setHover] = useState<number | null>(null)

  const offset = days.length > 0 ? (weekdayOf(days[0].day) + 6) % 7 : 0
  const columns = Math.max(1, Math.ceil((days.length + offset) / 7))
  const cell = Math.max(
    MIN_CELL,
    Math.min(maxCell, Math.floor((width - LABEL_WIDTH) / columns) - GAP)
  )
  const step = cell + GAP
  const height = HEADER_HEIGHT + 7 * step
  const svgWidth = LABEL_WIDTH + columns * step

  const position = (i: number): { col: number; row: number } => ({
    col: Math.floor((i + offset) / 7),
    row: (i + offset) % 7
  })

  const monthLabels: { col: number; label: string }[] = []
  let lastMonth = ''
  days.forEach((day, i) => {
    const month = day.day.slice(0, 7)
    if (month === lastMonth) return
    lastMonth = month
    const { col } = position(i)
    const previous = monthLabels[monthLabels.length - 1]
    // A month that starts in the last column, or right after the previous
    // label, has no room for its name.
    if (col >= columns - 1 && monthLabels.length > 0) return
    if (previous && col - previous.col < 3) return
    monthLabels.push({ col, label: format.month(day.day) })
  })

  const hovered = hover === null ? null : days[hover]
  let tooltip: ChartTooltipState | null = null
  if (hovered && hover !== null) {
    const { col, row } = position(hover)
    tooltip = {
      x: LABEL_WIDTH + col * step + cell / 2,
      y: HEADER_HEIGHT + row * step,
      title: format.day(hovered.day),
      body: describe(hovered)
    }
  }

  return (
    <div ref={containerRef} dir="ltr" className="relative w-full" style={{ height }}>
      {width > 0 ? (
        <svg
          width={svgWidth}
          height={height}
          role="img"
          aria-label={ariaLabel}
          onPointerLeave={() => setHover(null)}
        >
          {monthLabels.map(({ col, label }) => (
            <text
              key={`${col}-${label}`}
              x={LABEL_WIDTH + col * step}
              y={11}
              className="fill-text-tertiary text-[10px]"
            >
              {label}
            </text>
          ))}
          {[0, 2, 4].map((row) => (
            <text
              key={row}
              x={0}
              y={HEADER_HEIGHT + row * step + cell - 2}
              className="fill-text-tertiary text-[10px]"
            >
              {/* Row 0 is Monday: weekday 1. */}
              {format.weekday((row + 1) % 7)}
            </text>
          ))}
          {days.map((day, i) => {
            const { col, row } = position(i)
            const openable = Boolean(onOpenDay) && day.rowIds.length > 0
            return (
              <rect
                key={day.day}
                x={LABEL_WIDTH + col * step}
                y={HEADER_HEIGHT + row * step}
                width={cell}
                height={cell}
                rx={Math.max(2, Math.round(cell / 5))}
                style={{ fill: colorFor(day) }}
                className={
                  hover === i ? 'stroke-foreground' : openable ? 'cursor-pointer' : undefined
                }
                strokeWidth={hover === i ? 1.5 : 0}
                onPointerEnter={() => setHover(i)}
                onClick={openable ? () => onOpenDay?.(day) : undefined}
              />
            )
          })}
        </svg>
      ) : null}
      <ChartTooltip tooltip={tooltip} width={width} />
    </div>
  )
}
