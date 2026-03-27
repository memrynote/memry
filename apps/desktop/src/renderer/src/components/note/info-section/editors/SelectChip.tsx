import { cn } from '@/lib/utils'
import { getTagColors, withAlpha } from '../../tags-row/tag-colors'

interface SelectChipProps {
  value: string
  color: string
  onClick?: () => void
  className?: string
}

export function SelectChip({ value, color, onClick, className }: SelectChipProps) {
  const colors = getTagColors(color)

  const chipClasses = cn(
    '[font-synthesis:none] inline-flex items-center',
    'rounded-[10px] px-2 py-0.5',
    'text-[11px]/3.5 font-medium',
    'shrink-0 select-none',
    'transition-colors duration-150',
    onClick && 'cursor-pointer hover:opacity-80',
    className
  )

  const chipStyle = {
    backgroundColor: withAlpha(colors.text, 0.12),
    color: colors.text
  }

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={chipClasses} style={chipStyle}>
        {value}
      </button>
    )
  }

  return (
    <span className={chipClasses} style={chipStyle}>
      {value}
    </span>
  )
}
