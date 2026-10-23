import { useEffect, useState } from 'react'

import { Orb } from '@/components/ai-elements/orb'
import { ThinkingState } from '@/components/ai-elements/thinking-state'

/**
 * The waiting state for a turn that is alive but silent: the AICSS S3 orb, the
 * AICSS thinking shimmer, and a live elapsed timer in tabular figures. Reduced
 * motion freezes the orb and the shimmer (see base.css); the timer still ticks.
 */

function useElapsedLabel(since: number | undefined): string {
  const [start] = useState(() => since ?? Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [])

  const seconds = Math.floor(Math.max(0, now - start) / 100) / 10
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`
}

/** `since` is the epoch ms the silence began; without it the timer starts at mount. */
export function ThinkingIndicator({
  label,
  since
}: {
  label: string
  since?: number
}): React.JSX.Element {
  const elapsed = useElapsedLabel(since)

  return (
    <span className="flex items-center gap-2" aria-hidden="true">
      <Orb />
      <ThinkingState label={label} />
      <span className="font-mono text-[12px] tabular-nums text-muted-foreground">{elapsed}</span>
    </span>
  )
}

const SILENCE_MS = 3000

/**
 * The epoch ms of the last change to `signal` while `active`, once nothing has
 * changed for 3 s; null otherwise. Any change hides the waiting state and
 * restarts the count.
 */
export function useSilentSince(signal: string, active: boolean): number | null {
  const [silence, setSilence] = useState<{ signal: string; since: number } | null>(null)

  useEffect(() => {
    if (!active) return
    const lastChange = Date.now()
    const timer = setTimeout(() => setSilence({ signal, since: lastChange }), SILENCE_MS)
    return () => clearTimeout(timer)
  }, [signal, active])

  return active && silence?.signal === signal ? silence.since : null
}
