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
      '[font-synthesis:none] antialiased flex items-center rounded-md py-[5px] px-2.5 gap-[5px]',
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
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke={chipText || 'var(--foreground)'}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  </div>
)

export default FilterChip
