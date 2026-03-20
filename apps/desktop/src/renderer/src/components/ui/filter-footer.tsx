import { cn } from '@/lib/utils'

interface FilterFooterProps {
  onClear: () => void
  onApply: () => void
  clearLabel?: string
  applyLabel?: string
  info?: React.ReactNode
  className?: string
}

export function FilterFooter({
  onClear,
  onApply,
  clearLabel = 'Clear',
  applyLabel = 'Apply',
  info,
  className
}: FilterFooterProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center justify-between py-2.5 px-4 bg-surface border-t border-border',
        className
      )}
    >
      {info ?? (
        <button
          type="button"
          onClick={onClear}
          className="text-[13px] text-muted-foreground/60 font-medium leading-4 hover:text-foreground transition-colors"
        >
          {clearLabel}
        </button>
      )}
      <button
        type="button"
        onClick={onApply}
        className="flex items-center rounded-sm py-[5px] px-3.5 gap-1 bg-foreground hover:bg-foreground/80 transition-colors"
      >
        <span className="text-[13px] text-background font-semibold leading-4">{applyLabel}</span>
      </button>
    </div>
  )
}
