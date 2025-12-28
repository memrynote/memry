import { cn } from '@/lib/utils'
import { getDaysInInbox, formatAge } from '@/lib/stale-utils'
import type { InboxItem, InboxItemListItem } from '@/types'

interface AgeIndicatorProps {
  item: InboxItem | InboxItemListItem
  className?: string
}

/**
 * Displays how long an item has been in the inbox
 * Uses subtle amber coloring that escalates slightly with age
 */
export const AgeIndicator = ({ item, className }: AgeIndicatorProps): React.JSX.Element => {
  const days = getDaysInInbox(item)
  const ageText = formatAge(days)

  // Subtle color escalation based on age
  const getIndicatorColor = (): string => {
    if (days >= 30) return 'text-amber-600 dark:text-amber-400'
    if (days >= 14) return 'text-amber-500 dark:text-amber-500'
    return 'text-amber-500/70 dark:text-amber-500/70'
  }

  return (
    <div
      className={cn('flex items-center gap-1.5 text-xs', getIndicatorColor(), className)}
      aria-label={`${days} days old`}
    >
      <span className="text-[10px]" aria-hidden="true">
        ○
      </span>
      <span>{ageText}</span>
    </div>
  )
}
