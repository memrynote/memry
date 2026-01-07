import { Folder, Tag, Archive, Clock } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { AIClusterSuggestion } from '@/components/bulk/ai-cluster-suggestion'
import { SnoozePicker } from '@/components/snooze'
import { cn } from '@/lib/utils'
import type { InboxItemListItem } from '@/types'

interface ClusterSuggestion {
  items: InboxItemListItem[]
  reason: string
}

interface BulkActionBarProps {
  selectedCount: number
  onFileAll: () => void
  onTagAll: () => void
  onSnoozeAll?: (snoozeUntil: string) => void
  onArchiveAll: () => void
  aiSuggestion: ClusterSuggestion | null
  onAddSuggestionToSelection: () => void
  onDismissSuggestion: () => void
}

const BulkActionBar = ({
  selectedCount,
  onFileAll,
  onTagAll,
  onSnoozeAll,
  onArchiveAll,
  aiSuggestion,
  onAddSuggestionToSelection,
  onDismissSuggestion
}: BulkActionBarProps): React.JSX.Element | null => {
  if (selectedCount === 0) return null

  return (
    <div
      className={cn(
        'fixed bottom-0 left-0 right-0 z-40 bg-background border-t border-border shadow-lg',
        'slide-up-enter motion-reduce:animate-none'
      )}
      role="toolbar"
      aria-label="Bulk actions"
    >
      <div className="max-w-4xl mx-auto px-6 py-4">
        {/* Action Buttons Row */}
        <div className="flex items-center justify-center gap-4">
          <Button variant="secondary" onClick={onFileAll} className="gap-2">
            <Folder className="size-4" aria-hidden="true" />
            File all
          </Button>

          <Button variant="outline" onClick={onTagAll} className="gap-2">
            <Tag className="size-4" aria-hidden="true" />
            Tag all
          </Button>

          {/* Snooze all - with dropdown picker */}
          {onSnoozeAll && (
            <SnoozePicker
              onSnooze={onSnoozeAll}
              size="default"
              variant="outline"
              trigger={
                <Button variant="outline" className="gap-2">
                  <Clock className="size-4" aria-hidden="true" />
                  Snooze all
                </Button>
              }
            />
          )}

          <Button variant="outline" onClick={onArchiveAll} className="gap-2">
            <Archive className="size-4" aria-hidden="true" />
            Archive all
          </Button>
        </div>

        {/* AI Suggestion Section */}
        {aiSuggestion && aiSuggestion.items.length > 0 && (
          <>
            <div className="h-px bg-[var(--border)] my-4" aria-hidden="true" />
            <AIClusterSuggestion
              suggestion={aiSuggestion}
              onAddToSelection={onAddSuggestionToSelection}
              onDismiss={onDismissSuggestion}
            />
          </>
        )}
      </div>
    </div>
  )
}

export { BulkActionBar, type ClusterSuggestion }
