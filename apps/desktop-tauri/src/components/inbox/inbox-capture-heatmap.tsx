import type { InboxCapturePattern } from '@memry/rpc/inbox'

export interface InboxCaptureHeatmapProps {
  patterns: InboxCapturePattern | undefined
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const HEATMAP_HOURS = [6, 8, 10, 12, 14, 16, 18, 20, 22] as const

function intensityToAlpha(intensity: number): string {
  if (intensity <= 0) return '0D'
  if (intensity < 0.1) return '1A'
  if (intensity < 0.2) return '26'
  if (intensity < 0.3) return '40'
  if (intensity < 0.4) return '59'
  if (intensity < 0.5) return '73'
  if (intensity < 0.6) return '8C'
  if (intensity < 0.7) return '99'
  if (intensity < 0.8) return 'B3'
  if (intensity < 0.9) return 'CC'
  return 'E6'
}

export function InboxCaptureHeatmap({ patterns }: InboxCaptureHeatmapProps): React.JSX.Element {
  const heatmap = patterns?.timeHeatmap

  let maxCount = 0
  if (Array.isArray(heatmap) && heatmap.length > 0) {
    for (let day = 0; day < 7; day++) {
      for (const hour of HEATMAP_HOURS) {
        const val = (heatmap[hour]?.[day] ?? 0) + (heatmap[hour + 1]?.[day] ?? 0)
        if (val > maxCount) maxCount = val
      }
    }
  }

  return (
    <div className="flex flex-col rounded-[10px] gap-3.5 border border-border/50 p-4">
      <div className="text-muted-foreground font-sans font-medium text-xs/4">Capture Activity</div>
      <div className="[font-synthesis:none] flex gap-1.5 text-xs/4">
        <div className="flex flex-col pt-4 gap-0.75">
          {DAYS.map((day) => (
            <div
              key={day}
              className="h-3 inline-block text-[#50505A] font-sans shrink-0 text-[9px]/3"
            >
              {day}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-0.75">
          <div className="flex h-3 gap-0.75 shrink-0">
            {HEATMAP_HOURS.map((hour) => (
              <div
                key={hour}
                className="w-3 text-center inline-block text-[#50505A] font-sans shrink-0 text-[9px]/3"
              >
                {hour}
              </div>
            ))}
          </div>
          {DAYS.map((_, dayIdx) => (
            <div key={dayIdx} className="flex gap-0.75">
              {HEATMAP_HOURS.map((hour) => {
                const val = (heatmap?.[hour]?.[dayIdx] ?? 0) + (heatmap?.[hour + 1]?.[dayIdx] ?? 0)
                const intensity = maxCount > 0 ? val / maxCount : 0
                return (
                  <div
                    key={hour}
                    className="rounded-xs shrink-0 size-3"
                    style={{ backgroundColor: `#E8A44A${intensityToAlpha(intensity)}` }}
                    title={`${val} captures`}
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
