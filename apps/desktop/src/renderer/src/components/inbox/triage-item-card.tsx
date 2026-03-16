import { memo } from 'react'
import { ExternalLink } from 'lucide-react'
import { TypeIcon, ContentMetadata } from '@/components/inbox-detail/content-section'
import { extractDomain } from '@/lib/inbox-utils'
import { formatRelativeTime } from '@/services/inbox-service'
import type { InboxItemListItem } from '@/types'

interface TriageItemCardProps {
  item: InboxItemListItem
}

export const TriageItemCard = memo(function TriageItemCard({
  item
}: TriageItemCardProps): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-8">
      <div className="flex items-start gap-3">
        <TypeIcon type={item.type} className="mt-1 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-tight">{item.title}</h2>
          <div className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
            <span className="capitalize">{item.type}</span>
            <span className="opacity-40">·</span>
            <span>{formatRelativeTime(item.createdAt)}</span>
          </div>
        </div>
      </div>

      {item.thumbnailUrl && (
        <div className="overflow-hidden rounded-lg">
          <img
            src={item.thumbnailUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-auto max-h-64 w-full object-cover"
          />
        </div>
      )}

      {item.content && (
        <div className="text-foreground/90 whitespace-pre-wrap text-sm leading-relaxed">
          {item.content}
        </div>
      )}

      {item.excerpt && !item.content && (
        <blockquote className="text-muted-foreground border-l-2 pl-4 text-sm italic">
          {item.excerpt}
        </blockquote>
      )}

      {item.sourceUrl && (
        <a
          href={item.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs transition-colors"
        >
          <ExternalLink className="size-3" />
          {extractDomain(item.sourceUrl)}
        </a>
      )}

      {item.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {item.tags.map((tag) => (
            <span key={tag} className="bg-muted rounded-md px-2 py-0.5 text-xs">
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
})
