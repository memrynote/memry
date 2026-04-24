import { Clock } from 'lucide-react'
import { formatTimeOfDay, type ClockFormat } from '@/lib/time-format'
import { cn } from '@/lib/utils'

interface MarqueeSelectionOverlayProps {
  top: number
  height: number
  left?: number
  width?: string
  className?: string
  startAt?: string
  endAt?: string
  clockFormat?: ClockFormat
}

export function MarqueeSelectionOverlay({
  top,
  height,
  left,
  width,
  className,
  startAt,
  endAt,
  clockFormat = '24h'
}: MarqueeSelectionOverlayProps): React.JSX.Element {
  const showTimes = Boolean(startAt && endAt)
  const compact = height < 32
  const timeLabel = showTimes
    ? `${formatTimeOfDay(new Date(startAt as string), clockFormat)} – ${formatTimeOfDay(new Date(endAt as string), clockFormat)}`
    : null

  return (
    <div
      className={cn(
        'pointer-events-none absolute z-10 overflow-hidden rounded-md shadow-sm',
        showTimes
          ? 'border border-tint bg-tint/80 px-2 py-1 text-tint-foreground'
          : 'border border-tint/40 bg-tint/20',
        className
      )}
      style={{ top, height, left: left ?? 0, width: width ?? '100%' }}
      data-testid="marquee-selection-overlay"
    >
      {showTimes && !compact && (
        <div className="truncate text-[11px] font-semibold leading-tight">New Event</div>
      )}
      {showTimes && (
        <div className="flex items-center gap-1 text-[11px] leading-tight opacity-90">
          <Clock className="size-3 shrink-0" />
          <span className="truncate">{timeLabel}</span>
        </div>
      )}
    </div>
  )
}
