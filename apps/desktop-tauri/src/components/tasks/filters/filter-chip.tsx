import { X } from '@/lib/icons'
import { cn } from '@/lib/utils'

interface FilterChipProps {
  label: string
  icon?: React.ReactNode
  dot?: string
  chipBg?: string
  chipText?: string
  chipBorder?: string
  onRemove: () => void
  className?: string
}

export const FilterChip = ({
  label,
  icon,
  dot,
  chipBg,
  chipText,
  chipBorder,
  onRemove,
  className
}: FilterChipProps): React.JSX.Element => (
  <div
    className={cn(
      '[font-synthesis:none] flex items-center rounded-md py-[5px] px-2.5 gap-[5px]',
      className
    )}
    style={{
      backgroundColor: chipBg || 'var(--surface)',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: chipBorder || 'var(--border)'
    }}
  >
    {dot && <div className="rounded-full shrink-0 size-1.5" style={{ backgroundColor: dot }} />}
    {icon && <span className="shrink-0 flex items-center">{icon}</span>}
    <span
      className="text-[12px] font-medium leading-4 truncate max-w-32"
      style={{ color: chipText || 'var(--foreground)' }}
    >
      {label}
    </span>
    <button
      type="button"
      onClick={onRemove}
      className="shrink-0 flex items-center hover:opacity-70 transition-opacity"
      aria-label={`Remove ${label} filter`}
    >
      <X size={10} strokeWidth={2.5} style={{ color: chipText || 'var(--foreground)' }} />
    </button>
  </div>
)

export default FilterChip
