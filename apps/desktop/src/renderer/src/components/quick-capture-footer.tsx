import { cn } from '@/lib/utils'

interface QuickCaptureFooterProps {
  className?: string
}

export function QuickCaptureFooter({ className }: QuickCaptureFooterProps): React.JSX.Element {
  const isMac = navigator.platform.includes('Mac')
  const modKey = isMac ? '⌘' : 'Ctrl'

  return (
    <div
      className={cn(
        'flex items-center justify-between px-4 py-2 border-t border-border/30',
        className
      )}
    >
      <div className="flex items-center gap-1">
        <kbd className="flex items-center justify-center rounded-[4px] px-1.5 py-0.5 bg-foreground/[0.06] border border-foreground/[0.08] font-mono text-[10px]/3 font-medium text-muted-foreground/60">
          Esc
        </kbd>
        <span className="font-sans text-[11px]/3.5 text-muted-foreground/60">close</span>
      </div>
      <div className="flex items-center gap-1">
        <kbd className="flex items-center justify-center rounded-[4px] px-1.5 py-0.5 bg-accent-orange/[0.12] border border-accent-orange/20 font-mono text-[10px]/3 font-medium text-accent-orange">
          {modKey} ↵
        </kbd>
        <span className="font-sans text-[11px]/3.5 font-medium text-accent-orange/70">capture</span>
      </div>
    </div>
  )
}
