import { ChevronRight } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface InfoHeaderProps {
  isExpanded: boolean
  onToggle: () => void
  variant?: 'default' | 'embedded'
  propertyCount?: number
}

export function InfoHeader({ isExpanded, onToggle, propertyCount = 0 }: InfoHeaderProps) {
  const { t } = useT('notes')

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      className={cn(
        'group/info-header flex w-fit items-center gap-1.5 rounded-md py-1 pe-2',
        'cursor-pointer select-none',
        'transition-opacity duration-150'
      )}
    >
      <ChevronRight
        className={cn(
          'h-3 w-3 shrink-0 transition-transform duration-150',
          isExpanded ? 'rotate-90 text-sidebar-terracotta' : 'text-text-tertiary',
          'group-hover/info-header:text-sidebar-terracotta'
        )}
      />
      <span
        className={cn(
          'text-[11px] font-semibold uppercase tracking-[0.09em] leading-4 transition-colors duration-150',
          isExpanded ? 'text-text-secondary' : 'text-text-tertiary',
          'group-hover/info-header:text-text-secondary'
        )}
      >
        {t('properties.title')}
      </span>
      {propertyCount > 0 && (
        <span className="text-[11px] font-medium leading-4 text-text-tertiary tabular-nums">
          · {propertyCount}
        </span>
      )}
    </button>
  )
}
