import type { InboxCapturePattern } from '../../../../preload/index.d'
import { cn } from '@/lib/utils'

export interface InboxCaptureHeatmapProps {
  patterns: InboxCapturePattern | undefined
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const HOURS = Array.from({ length: 24 }, (_, i) => i)

function getIntensityClass(count: number, max: number): string {
  if (count === 0) return 'bg-muted/30'

  const ratio = max > 0 ? count / max : 0

  if (ratio < 0.25) return 'bg-primary/20'
  if (ratio < 0.5) return 'bg-primary/40'
  if (ratio < 0.75) return 'bg-primary/60'
  return 'bg-primary/80'
}

function formatHour(hour: number): string {
  if (hour === 0) return '12am'
  if (hour === 12) return '12pm'
  return hour > 12 ? `${hour - 12}pm` : `${hour}am`
}

export function InboxCaptureHeatmap({ patterns }: InboxCaptureHeatmapProps): React.JSX.Element {
  if (!patterns?.timeHeatmap) {
    return (
      <div className="p-6 rounded-xl border border-border/50 bg-card h-full min-h-[400px] flex items-center justify-center">
        <span className="text-muted-foreground font-serif italic">No capture data available</span>
      </div>
    )
  }

  let maxCount = 0
  patterns.timeHeatmap.forEach((row) => {
    row.forEach((count) => {
      if (count > maxCount) maxCount = count
    })
  })

  const grid = patterns.timeHeatmap

  return (
    <div className="p-6 rounded-xl border border-border/50 bg-card flex flex-col h-full">
      <div className="mb-6">
        <h3 className="text-lg font-serif font-medium text-foreground">Capture Patterns</h3>
        <p className="text-sm text-muted-foreground mt-1">When you add items to your inbox</p>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="grid grid-cols-[auto_repeat(7,1fr)] gap-x-2 gap-y-1 w-full max-w-md">
          <div className="h-6 w-8" />
          {DAYS.map((day) => (
            <div key={day} className="h-6 flex items-center justify-center">
              <span className="text-xs font-medium text-muted-foreground">{day}</span>
            </div>
          ))}

          {HOURS.map((hour) => (
            <div key={`row-${hour}`} className="contents">
              <div className="h-6 w-8 flex items-center justify-end pr-2">
                {hour % 4 === 0 && (
                  <span className="text-[10px] text-muted-foreground font-medium">
                    {formatHour(hour)}
                  </span>
                )}
              </div>

              {DAYS.map((_, dayIndex) => {
                const count = grid[hour]?.[dayIndex] || 0
                return (
                  <div
                    key={`${hour}-${dayIndex}`}
                    className={cn(
                      'h-6 w-full rounded-sm transition-colors duration-200',
                      getIntensityClass(count, maxCount)
                    )}
                    title={`${count} captures on ${DAYS[dayIndex]} at ${formatHour(hour)}`}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
