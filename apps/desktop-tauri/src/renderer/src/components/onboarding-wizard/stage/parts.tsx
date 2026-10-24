import { cn } from '@/lib/utils'

/** The empty round checkbox every task row in the stage window starts with. */
export function TaskCircle({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        'size-3 shrink-0 rounded-full border-[1.25px] border-text-tertiary/70',
        className
      )}
    />
  )
}

/** A translucent wash of a theme colour, so it reads on light and dark surfaces. */
export function tint(color: string, percent: number): React.CSSProperties {
  return { backgroundColor: `color-mix(in srgb, ${color} ${percent}%, transparent)` }
}
