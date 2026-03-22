import { memo } from 'react'
import { ExternalLink } from '@/lib/icons'
import { extractDomain } from '@/lib/inbox-utils'
import type { InboxItem, InboxItemListItem, LinkMetadata } from '@/types'

const getInitials = (name: string): string => {
  const parts = name.replace(/\.[a-z]+$/, '').split(/[\s._-]+/)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return name.slice(0, 2).toUpperCase()
}

const formatPublishedDate = (date: string): string => {
  const d = new Date(date)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

interface LinkPreviewProps {
  item: InboxItem | InboxItemListItem
}

export const LinkPreview = memo(({ item }: LinkPreviewProps): React.JSX.Element => {
  const metadata = 'metadata' in item ? (item.metadata as LinkMetadata | null) : null
  const domain = item.sourceUrl ? extractDomain(item.sourceUrl) : null
  const siteName = metadata?.siteName || domain

  return (
    <div className="flex flex-col gap-3.5">
      {/* Source: favicon monogram + domain + date */}
      <div className="flex items-center gap-2">
        {siteName && (
          <div className="flex items-center justify-center shrink-0 size-5 rounded bg-muted">
            <span className="text-[10px] font-semibold leading-none text-muted-foreground">
              {getInitials(siteName)}
            </span>
          </div>
        )}

        <span className="text-[11px] leading-3.5 text-muted-foreground/60">
          {domain && <>{domain}</>}
          {metadata?.publishedDate && <> · {formatPublishedDate(metadata.publishedDate)}</>}
        </span>

        {item.sourceUrl && (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-muted-foreground/40 hover:text-muted-foreground transition-colors"
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        )}
      </div>

      {/* Title — the visual hero */}
      <h3 className="text-lg leading-6 font-semibold text-foreground">{item.title}</h3>

      {/* Description */}
      {(metadata?.description || metadata?.excerpt || item.content) && (
        <p className="text-sm leading-5 text-muted-foreground line-clamp-3">
          {metadata?.description || metadata?.excerpt || item.content}
        </p>
      )}
    </div>
  )
})

LinkPreview.displayName = 'LinkPreview'
