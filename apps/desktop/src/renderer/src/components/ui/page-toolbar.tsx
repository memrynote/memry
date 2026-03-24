import { cn } from '@/lib/utils'

interface PageToolbarProps {
  children: React.ReactNode
  className?: string
}

export function PageToolbar({ children, className }: PageToolbarProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 shrink-0 min-w-0 py-0.5 border-b border-border',
        '[font-synthesis:none] text-[12px] leading-4 antialiased',
        className
      )}
    >
      {children}
    </div>
  )
}

interface ToolbarSegmentProps {
  children: React.ReactNode
  label?: string
  className?: string
}

export function ToolbarSegment({
  children,
  label = 'Navigation',
  className
}: ToolbarSegmentProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center shrink-0 rounded-[5px] overflow-clip border border-border',
        className
      )}
      role="tablist"
      aria-label={label}
    >
      {children}
    </div>
  )
}

interface ToolbarSegmentTabProps {
  children: React.ReactNode
  isActive: boolean
  showBorder?: boolean
  onClick: () => void
  ariaControls?: string
  className?: string
}

export function ToolbarSegmentTab({
  children,
  isActive,
  showBorder = true,
  onClick,
  ariaControls,
  className
}: ToolbarSegmentTabProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      aria-controls={ariaControls}
      tabIndex={isActive ? 0 : -1}
      onClick={onClick}
      className={cn(
        'flex items-center py-1 px-2.5 gap-1 transition-colors',
        'focus-visible:outline-none',
        showBorder && 'border-l border-border',
        isActive
          ? 'bg-foreground text-background font-medium'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-active/50',
        className
      )}
    >
      {children}
    </button>
  )
}

interface ToolbarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode
  isActive?: boolean
  className?: string
}

export function ToolbarButton({
  children,
  isActive = false,
  className,
  ...props
}: ToolbarButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'flex items-center shrink-0 rounded-[5px] py-1 px-2 gap-1 border transition-colors',
        isActive
          ? 'border-foreground/20 bg-foreground/5 text-text-primary'
          : 'border-border text-text-secondary hover:bg-surface-active/50',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}
