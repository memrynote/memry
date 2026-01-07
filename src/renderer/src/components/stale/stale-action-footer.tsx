import { Button } from '@/components/ui/button'
import { getNudgeMessage } from '@/lib/stale-utils'

interface StaleActionFooterProps {
  itemCount: number
  onFileAllToUnsorted: () => void
  onReviewOneByOne: () => void
}

/**
 * Footer component for the stale section with nudge message and action buttons
 */
export const StaleActionFooter = ({
  itemCount,
  onFileAllToUnsorted,
  onReviewOneByOne
}: StaleActionFooterProps): React.JSX.Element => {
  const nudgeMessage = getNudgeMessage(itemCount)

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 bg-amber-500/5 dark:bg-amber-500/10 border-t border-amber-500/20 rounded-b-lg">
      <p className="text-sm text-[var(--muted-foreground)]">{nudgeMessage}</p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onFileAllToUnsorted}
          className="text-xs border-amber-500/30 hover:bg-amber-500/10 hover:border-amber-500/50"
        >
          File all to "Unsorted"
        </Button>
        <span className="text-xs text-[var(--muted-foreground)]">or</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onReviewOneByOne}
          className="text-xs hover:bg-amber-500/10"
        >
          Review one by one
        </Button>
      </div>
    </div>
  )
}
