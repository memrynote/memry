import { useMemo, useState } from 'react'
import type { ChartDay } from '@/lib/property-chart/chart-model'
import {
  ChartTooltip,
  useChartFormat,
  useMeasuredWidth,
  type ChartTooltipState
} from './chart-parts'

const PAD = { start: 36, end: 10, top: 10, bottom: 24 }
const TICKS = 4

/** Round numbers for an axis: 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(span: number): number {
  const raw = span / TICKS
  const power = 10 ** Math.floor(Math.log10(raw))
  const unit = raw / power
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10
  return nice * power
}

function yDomain(values: number[], fromZero: boolean): { min: number; max: number; step: number } {
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (fromZero) min = Math.min(0, min)
  if (min === max) {
    min -= 1
    max += 1
  }
  const step = niceStep(max - min)
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step }
}

export interface TimeSeriesChartProps {
  days: ChartDay[]
  type: 'line' | 'bar'
  height?: number
  /** The tooltip's second line for a day. */
  describe: (day: ChartDay) => string
  onOpenDay?: (day: ChartDay) => void
  ariaLabel: string
}

/**
 * One value per day as a line or as bars. Days without a value break the line
 * rather than bridging it, so a missed day reads as missed.
 */
export function TimeSeriesChart({
  days,
  type,
  height = 220,
  describe,
  onOpenDay,
  ariaLabel
}: TimeSeriesChartProps): React.JSX.Element {
  const [containerRef, width] = useMeasuredWidth<HTMLDivElement>()
  const format = useChartFormat()
  const [hover, setHover] = useState<number | null>(null)

  const values = useMemo(
    () => days.map((d) => d.value).filter((v): v is number => v !== null),
    [days]
  )
  const domain = useMemo(
    () => (values.length > 0 ? yDomain(values, type === 'bar') : { min: 0, max: 1, step: 1 }),
    [values, type]
  )
  const average = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null

  const plotWidth = Math.max(0, width - PAD.start - PAD.end)
  const plotHeight = height - PAD.top - PAD.bottom
  const slot = days.length > 0 ? plotWidth / days.length : 0
  const x = (i: number): number =>
    type === 'bar' || days.length < 2
      ? PAD.start + slot * (i + 0.5)
      : PAD.start + (plotWidth * i) / (days.length - 1)
  const y = (v: number): number =>
    PAD.top + ((domain.max - v) * plotHeight) / (domain.max - domain.min)

  // At most a year of points: cheap enough to rebuild on every render.
  const segments: string[] = []
  let run: string[] = []
  days.forEach((day, i) => {
    if (day.value === null) {
      if (run.length > 0) segments.push(run.join(' '))
      run = []
      return
    }
    run.push(`${x(i).toFixed(1)},${y(day.value).toFixed(1)}`)
  })
  if (run.length > 0) segments.push(run.join(' '))
  const isolated = (i: number): boolean =>
    (i === 0 || days[i - 1].value === null) && (i === days.length - 1 || days[i + 1].value === null)

  const ticks: number[] = []
  for (let v = domain.min; v <= domain.max + domain.step / 2; v += domain.step) ticks.push(v)
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plotWidth / 72))))

  const indexAt = (clientX: number, rect: DOMRect): number | null => {
    if (days.length === 0 || plotWidth <= 0) return null
    const px = clientX - rect.left - PAD.start
    const i =
      type === 'bar' || days.length < 2
        ? Math.floor(px / slot)
        : Math.round((px / plotWidth) * (days.length - 1))
    return Math.min(days.length - 1, Math.max(0, i))
  }

  const hovered = hover === null ? null : days[hover]
  const tooltip: ChartTooltipState | null =
    hovered && hover !== null
      ? {
          x: x(hover),
          y: hovered.value === null ? PAD.top + plotHeight / 2 : y(hovered.value),
          title: format.day(hovered.day),
          body: describe(hovered)
        }
      : null

  const barWidth = Math.max(1, Math.min(18, slot * 0.7))

  return (
    <div ref={containerRef} dir="ltr" className="relative w-full" style={{ height }}>
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          className={onOpenDay && hovered?.rowIds.length ? 'cursor-pointer' : undefined}
          onPointerMove={(event) =>
            setHover(indexAt(event.clientX, event.currentTarget.getBoundingClientRect()))
          }
          onPointerLeave={() => setHover(null)}
          onClick={() => {
            if (hovered && hovered.rowIds.length > 0) onOpenDay?.(hovered)
          }}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD.start}
                x2={width - PAD.end}
                y1={y(tick)}
                y2={y(tick)}
                className="stroke-border"
                strokeWidth={1}
              />
              <text
                x={PAD.start - 8}
                y={y(tick) + 4}
                textAnchor="end"
                className="fill-text-tertiary text-[10px] tabular-nums"
              >
                {format.number(tick)}
              </text>
            </g>
          ))}
          {days.map((day, i) =>
            i % labelEvery === 0 || i === days.length - 1 ? (
              <text
                key={day.day}
                x={x(i)}
                y={height - 6}
                textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}
                className="fill-text-tertiary text-[10px]"
              >
                {format.shortDay(day.day)}
              </text>
            ) : null
          )}
          {hover !== null ? (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={PAD.top + plotHeight}
              className="stroke-border"
              strokeWidth={1}
            />
          ) : null}
          {type === 'line' ? (
            <>
              {average !== null ? (
                <line
                  x1={PAD.start}
                  x2={width - PAD.end}
                  y1={y(average)}
                  y2={y(average)}
                  className="stroke-text-tertiary"
                  strokeOpacity={0.6}
                  strokeWidth={1}
                  strokeDasharray="3 4"
                />
              ) : null}
              {segments.map((points) => (
                <polyline
                  key={points}
                  points={points}
                  fill="none"
                  className="stroke-tint"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ))}
              {days.map((day, i) =>
                day.value !== null && (i === hover || isolated(i)) ? (
                  <circle
                    key={day.day}
                    cx={x(i)}
                    cy={y(day.value)}
                    r={i === hover ? 4 : 2.5}
                    className="fill-background stroke-tint"
                    strokeWidth={2}
                  />
                ) : null
              )}
            </>
          ) : (
            days.map((day, i) => {
              if (day.value === null) return null
              const top = y(Math.max(day.value, 0))
              const bottom = y(Math.min(day.value, 0))
              return (
                <rect
                  key={day.day}
                  x={x(i) - barWidth / 2}
                  y={top}
                  width={barWidth}
                  height={Math.max(1, bottom - top)}
                  rx={Math.min(3, barWidth / 3)}
                  className="fill-tint"
                  fillOpacity={hover === null || hover === i ? 1 : 0.55}
                />
              )
            })
          )}
        </svg>
      ) : null}
      <ChartTooltip tooltip={tooltip} width={width} />
    </div>
  )
}
