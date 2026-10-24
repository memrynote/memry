import { cn } from '@/lib/utils'

/**
 * AICSS Thinking State: a label with a soft brightness valley sweeping through
 * it while the agent works before its first token. Styles live in base.css
 * (`.aicss-thinking-shimmer`); reduced motion drops to a plain muted label.
 * Source: https://www.aicss.dev/components/thinking-state
 */
export function ThinkingState({
  label,
  className
}: {
  label: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn('aicss-thinking-shimmer text-[13px] font-medium leading-[18px]', className)}
    >
      {label}
    </span>
  )
}
