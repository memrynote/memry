import { memo } from 'react'
import { ContentSection } from '@/components/inbox-detail/content-section'
import { formatTimeAgo } from '@/services/inbox-service'
import type { InboxItemListItem } from '@/types'

interface TriageItemCardProps {
  item: InboxItemListItem
}

const TYPES_WITH_OWN_TITLE = new Set(['link', 'image', 'pdf', 'reminder', 'social'])
const TYPES_WITH_OWN_TIMESTAMP = new Set(['link'])
const TYPES_WITHOUT_PADDING = new Set(['reminder', 'social'])

export const TriageItemCard = memo(function TriageItemCard({
  item
}: TriageItemCardProps): React.JSX.Element {
  const showTitle = !TYPES_WITH_OWN_TITLE.has(item.type)
  const showTimestamp = !TYPES_WITH_OWN_TIMESTAMP.has(item.type)
  const hasPadding = !TYPES_WITHOUT_PADDING.has(item.type)

  return (
    <div className="flex w-full max-w-[520px] flex-col overflow-hidden rounded-xl border border-foreground/[0.08] bg-card">
      <div className={hasPadding ? 'px-5 py-4' : ''}>
        {showTitle && (
          <h3 className="mb-3.5 text-[15px] font-medium leading-5 text-foreground">{item.title}</h3>
        )}
        <ContentSection item={item} />
      </div>

      {(item.tags.length > 0 || showTimestamp) && (
        <div className="flex flex-col gap-2 border-t border-foreground/[0.06] px-5 py-3">
          {item.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {item.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md bg-foreground/[0.06] px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
          {showTimestamp && (
            <span className="text-[11px]/3.5 text-text-tertiary">
              Captured {formatTimeAgo(item.createdAt)}
            </span>
          )}
        </div>
      )}
    </div>
  )
})
