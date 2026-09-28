import { useEffect, useState } from 'react'

import { Orb } from '@/components/ai-elements/orb'
import { ThinkingState } from '@/components/ai-elements/thinking-state'

/**
 * The waiting state for a turn that has started but not produced text yet: the
 * AICSS S3 orb, the AICSS thinking shimmer, and a live elapsed timer in tabular
 * figures. Reduced motion freezes the orb and the shimmer (see base.css); the
 * timer still ticks.
 */

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

export function ThinkingIndicator({ label }: { label: string }): React.JSX.Element {
  const elapsed = useElapsedLabel()

  return (
    <span className="flex items-center gap-2" aria-hidden="true">
      <Orb />
      <ThinkingState label={label} />
      <span className="font-mono text-[12px] tabular-nums text-muted-foreground">{elapsed}</span>
    </span>
  )
}
