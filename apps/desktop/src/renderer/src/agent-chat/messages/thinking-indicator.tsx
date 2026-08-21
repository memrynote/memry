import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

/**
 * The waiting state for a turn that has started but not produced text yet: a
 * 3x3 pixel grid whose chevron wavefront drives to the trailing edge, a
 * shimmering label, and a live elapsed timer in tabular figures.
 *
 * The 650ms cycle is shorter than the sweep, so two fronts are always in
 * flight. Reduced motion freezes the grid to its dim state (see
 * `prefers-reduced-motion` in base.css); the timer still ticks.
 */

const CELL_COUNT = 9
const CYCLE_MS = 650

/** Column plus distance from the middle row, so the front reads as a chevron. */
const chevronDelays = Array.from({ length: CELL_COUNT }, (_, index) => {
  const row = Math.floor(index / 3)
  const column = index % 3
  return (column + Math.abs(row - 1)) * 90
})

function useElapsedLabel(): string {
  const [tenths, setTenths] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setTenths((value) => value + 1), 100)
    return () => clearInterval(timer)
  }, [])

  const seconds = tenths / 10
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`
}

/** The grid on its own, for rows that already carry their own label. */
export function ThinkingPixels({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        'agent-thinking-pixels grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]',
        className
      )}
      aria-hidden="true"
    >
      {chevronDelays.map((delay, index) => (
        <span
          key={index}
          className="agent-thinking-pixel size-[4px] rounded-full bg-foreground"
          style={{ animationDelay: `${delay}ms`, animationDuration: `${CYCLE_MS}ms` }}
        />
      ))}
    </span>
  )
}

export function ThinkingIndicator({ label }: { label: string }): React.JSX.Element {
  const elapsed = useElapsedLabel()

  return (
    <span className="flex items-center gap-2.5" aria-hidden="true">
      <ThinkingPixels />
      <span className="agent-thinking-label text-[13px] font-medium">{label}</span>
      <span className="font-mono text-[12px] tabular-nums text-muted-foreground">{elapsed}</span>
    </span>
  )
}
