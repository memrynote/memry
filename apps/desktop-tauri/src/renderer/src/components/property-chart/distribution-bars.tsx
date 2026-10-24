import type { CategoryCount } from '@/lib/property-chart/chart-model'
import { useChartFormat } from './chart-parts'

/**
 * How often each value was recorded, as horizontal bars. The select's own
 * option colour marks each row; the bar length carries the count, so the
 * colour is never the only signal.
 */
export function DistributionBars({
  counts,
  colorOf,
  ariaLabel
}: {
  counts: CategoryCount[]
  colorOf: (value: string) => string
  ariaLabel: string
}): React.JSX.Element {
  const format = useChartFormat()
  const max = counts.reduce((m, c) => Math.max(m, c.count), 0)
  return (
    <ul aria-label={ariaLabel} className="flex flex-col gap-1.5">
      {counts.map(({ value, count }) => (
        <li key={value} className="flex items-center gap-3 text-[13px]">
          <span className="flex w-32 min-w-0 shrink-0 items-center gap-1.5">
            <span
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: colorOf(value) }}
              aria-hidden="true"
            />
            <span className="truncate text-foreground">{value}</span>
          </span>
          <span className="h-2 grow overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full"
              style={{
                width: `${max > 0 ? (count / max) * 100 : 0}%`,
                backgroundColor: colorOf(value)
              }}
            />
          </span>
          <span className="w-8 shrink-0 text-end tabular-nums text-muted-foreground">
            {format.number(count)}
          </span>
        </li>
      ))}
    </ul>
  )
}
