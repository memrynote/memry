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
  if (values.length === 0) return { min: 0, max: 1, step: 1 }
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

/** Where everything sits for one width: scales, ticks, line runs and the pointer's day. */
interface Geometry {
  x: (i: number) => number
  y: (v: number) => number
  plotTop: number
  plotBottom: number
  plotEnd: number
  ticks: number[]
  labelEvery: number
  average: number | null
  /** Polyline point lists, broken at days without a value. */
  segments: string[]
  barWidth: number
  indexAt: (offsetX: number) => number | null
}

function seriesGeometry(
  days: ChartDay[],
  type: 'line' | 'bar',
  width: number,
  height: number
): Geometry {
  const values = days.map((d) => d.value).filter((v): v is number => v !== null)
  const domain = yDomain(values, type === 'bar')
  const plotWidth = Math.max(0, width - PAD.start - PAD.end)
  const plotHeight = height - PAD.top - PAD.bottom
  const slot = days.length > 0 ? plotWidth / days.length : 0
  // Bars sit in the middle of their slot; a line runs edge to edge.
  const centered = type === 'bar' || days.length < 2
  const x = (i: number): number =>
    centered ? PAD.start + slot * (i + 0.5) : PAD.start + (plotWidth * i) / (days.length - 1)
  const y = (v: number): number =>
    PAD.top + ((domain.max - v) * plotHeight) / (domain.max - domain.min)

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

  const ticks: number[] = []
  for (let v = domain.min; v <= domain.max + domain.step / 2; v += domain.step) ticks.push(v)

  return {
    x,
    y,
    plotTop: PAD.top,
    plotBottom: PAD.top + plotHeight,
    plotEnd: width - PAD.end,
    ticks,
    labelEvery: Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plotWidth / 72)))),
    average: values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null,
    segments,
    barWidth: Math.max(1, Math.min(18, slot * 0.7)),
    indexAt: (offsetX) => {
      if (days.length === 0 || plotWidth <= 0) return null
      const px = offsetX - PAD.start
      const i = centered ? Math.floor(px / slot) : Math.round((px / plotWidth) * (days.length - 1))
      return Math.min(days.length - 1, Math.max(0, i))
    }
  }
}

function Axes({
  geometry,
  days,
  height
}: {
  geometry: Geometry
  days: ChartDay[]
  height: number
}): React.JSX.Element {
  const format = useChartFormat()
  const { x, y, ticks, labelEvery, plotEnd } = geometry
  const last = days.length - 1
  return (
    <>
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={PAD.start}
            x2={plotEnd}
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
        i % labelEvery === 0 || i === last ? (
          <text
            key={day.day}
            x={x(i)}
            y={height - 6}
            textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'}
            className="fill-text-tertiary text-[10px]"
          >
            {format.shortDay(day.day)}
          </text>
        ) : null
      )}
    </>
  )
}

/** A day whose neighbours are both empty draws no line, so it gets a dot. */
function isIsolated(days: ChartDay[], i: number): boolean {
  const before = i === 0 || days[i - 1].value === null
  const after = i === days.length - 1 || days[i + 1].value === null
  return before && after
}

function LineSeries({
  geometry,
  days,
  hover
}: {
  geometry: Geometry
  days: ChartDay[]
  hover: number | null
}): React.JSX.Element {
  const { x, y, average, segments, plotEnd } = geometry
  return (
    <>
      {average !== null ? (
        <line
          x1={PAD.start}
          x2={plotEnd}
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
        day.value !== null && (i === hover || isIsolated(days, i)) ? (
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
  )
}

function BarSeries({
  geometry,
  days,
  hover
}: {
  geometry: Geometry
  days: ChartDay[]
  hover: number | null
}): React.JSX.Element {
  const { x, y, barWidth } = geometry
  return (
    <>
      {days.map((day, i) => {
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
      })}
    </>
  )
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
  const geometry = useMemo(
    () => seriesGeometry(days, type, width, height),
    [days, type, width, height]
  )

  const hovered = hover === null ? null : days[hover]
  const openable = Boolean(onOpenDay) && (hovered?.rowIds.length ?? 0) > 0
  const tooltip: ChartTooltipState | null =
    hovered && hover !== null
      ? {
          x: geometry.x(hover),
          y:
            hovered.value === null
              ? (geometry.plotTop + geometry.plotBottom) / 2
              : geometry.y(hovered.value),
          title: format.day(hovered.day),
          body: describe(hovered)
        }
      : null

  return (
    <div ref={containerRef} dir="ltr" className="relative w-full" style={{ height }}>
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          className={openable ? 'cursor-pointer' : undefined}
          onPointerMove={(event) =>
            setHover(
              geometry.indexAt(event.clientX - event.currentTarget.getBoundingClientRect().left)
            )
          }
          onPointerLeave={() => setHover(null)}
          onClick={() => {
            if (openable && hovered) onOpenDay?.(hovered)
          }}
        >
          <Axes geometry={geometry} days={days} height={height} />
          {hover !== null ? (
            <line
              x1={geometry.x(hover)}
              x2={geometry.x(hover)}
              y1={geometry.plotTop}
              y2={geometry.plotBottom}
              className="stroke-border"
              strokeWidth={1}
            />
          ) : null}
          {type === 'line' ? (
            <LineSeries geometry={geometry} days={days} hover={hover} />
          ) : (
            <BarSeries geometry={geometry} days={days} hover={hover} />
          )}
        </svg>
      ) : null}
      <ChartTooltip tooltip={tooltip} width={width} />
    </div>
  )
}
