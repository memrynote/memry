import { cn } from '@/lib/utils'

interface FilterSearchHeaderProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  leading?: React.ReactNode
  className?: string
}

export function FilterSearchHeader({
  value,
  onChange,
  placeholder = 'Search...',
  leading,
  className
}: FilterSearchHeaderProps): React.JSX.Element {
  return (
    <div className={cn('flex items-center py-2 px-3 gap-2 border-b border-border', className)}>
      {leading}
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        className="shrink-0 text-text-tertiary"
      >
        <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.1" />
        <path d="M7.5 7.5l2.5 2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 min-w-0 bg-transparent text-[12px] text-foreground placeholder:text-text-tertiary outline-none leading-4"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}
