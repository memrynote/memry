import { cn } from '@/lib/utils'

interface MarqueeSelectionOverlayProps {
  top: number
  height: number
  left?: number
  width?: string
  className?: string
}

export function MarqueeSelectionOverlay({
  top,
  height,
  left,
  width,
  className
}: MarqueeSelectionOverlayProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'pointer-events-none absolute z-10 rounded-md border border-tint/40 bg-tint/20',
        className
      )}
      style={{
        top,
        height,
        left: left ?? 0,
        width: width ?? '100%'
      }}
      data-testid="marquee-selection-overlay"
    />
  )
}
