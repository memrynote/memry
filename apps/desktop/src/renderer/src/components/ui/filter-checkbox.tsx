import { cn } from '@/lib/utils'

interface FilterCheckboxProps {
  checked: boolean
  color?: string
  checkedBg?: string
  className?: string
}

export function FilterCheckbox({
  checked,
  color = 'var(--foreground)',
  checkedBg = 'var(--surface)',
  className
}: FilterCheckboxProps): React.JSX.Element {
  return (
    <div
      className={cn('flex items-center justify-center rounded-sm shrink-0 size-4', className)}
      style={{
        borderWidth: '1.5px',
        borderStyle: 'solid',
        borderColor: checked ? color : 'var(--border)',
        backgroundColor: checked ? checkedBg : 'var(--card)'
      }}
    >
      {checked && (
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </div>
  )
}
