import { Search } from '@/lib/icons'
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
      <Search size={12} className="shrink-0 text-muted-foreground/60" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 min-w-0 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/40 outline-none leading-4"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}
