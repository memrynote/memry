import { memo, useState } from 'react'
import { ExternalLink, Globe, Play } from '@/lib/icons'
import { extractDomain, formatCompactRelativeTime } from '@/lib/inbox-utils'
import { cn } from '@/lib/utils'
import { extractYouTubeVideoId } from '@/lib/youtube-utils'
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
  const [imgError, setImgError] = useState(false)
  const [faviconError, setFaviconError] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)

  const metadata = 'metadata' in item ? (item.metadata as LinkMetadata | null) : null
  const raw = metadata as Record<string, unknown> | null
  const heroImageUrl = item.thumbnailUrl || metadata?.heroImage || (raw?.image as string) || null
  const domain = item.sourceUrl ? extractDomain(item.sourceUrl) : null
  const siteName = metadata?.siteName || (raw?.publisher as string) || domain
  const faviconUrl = metadata?.favicon || (raw?.logo as string) || null
  const author = metadata?.author || null
  const publishedDate =
    metadata?.publishedDate || (raw?.date as string)
      ? formatPublishedDate((metadata?.publishedDate || raw?.date) as string)
      : null
  const excerpt = metadata?.description || metadata?.excerpt || item.content
  const capturedAgo = formatCompactRelativeTime(item.createdAt)

  const youtubeVideoId = item.sourceUrl ? extractYouTubeVideoId(item.sourceUrl) : null
  const showHeroImage = heroImageUrl && !imgError

  return (
    <div className="flex flex-col gap-4">
      {youtubeVideoId && isPlaying ? (
        <div className="relative aspect-video overflow-hidden rounded-[10px] bg-black">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${youtubeVideoId}?autoplay=1&rel=0`}
            className="size-full"
            sandbox="allow-scripts allow-same-origin allow-presentation"
            allow="autoplay; encrypted-media"
            title={item.title || 'YouTube video'}
          />
        </div>
      ) : (
        <button
          type="button"
          className={cn(
            'relative overflow-hidden rounded-[10px] bg-muted',
            youtubeVideoId ? 'aspect-video cursor-pointer group' : 'h-[200px]'
          )}
          disabled={!youtubeVideoId}
          onClick={() => youtubeVideoId && setIsPlaying(true)}
        >
          {showHeroImage ? (
            <img
              src={heroImageUrl}
              alt=""
              className="size-full object-cover"
              onError={() => setImgError(true)}
              loading="lazy"
            />
          ) : (
            <div className="flex items-center justify-center size-full bg-gradient-to-br from-muted to-surface">
              {faviconUrl && !faviconError ? (
                <img
                  src={faviconUrl}
                  alt=""
                  className="size-12 rounded-lg object-contain"
                  onError={() => setFaviconError(true)}
                />
              ) : (
                <Globe className="size-8 text-muted-foreground/20" />
              )}
            </div>
          )}
          {youtubeVideoId && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
              <div className="flex items-center justify-center size-14 rounded-full bg-red-600 group-hover:bg-red-500 transition-colors shadow-lg">
                <Play className="size-6 text-white ml-0.5" />
              </div>
            </div>
          )}
        </button>
      )}

      <h3 className="text-[17px] leading-6 font-semibold text-foreground">{item.title}</h3>

      {!youtubeVideoId && excerpt && (
        <p className="text-[13px] leading-5 text-muted-foreground line-clamp-3">{excerpt}</p>
      )}

      {!youtubeVideoId && (
        <div className="flex items-center gap-2">
          {faviconUrl ? (
            <img
              src={faviconUrl}
              alt=""
              className="size-5 shrink-0 rounded bg-muted object-contain"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          ) : siteName ? (
            <div className="flex items-center justify-center shrink-0 size-5 rounded bg-muted">
              <span className="text-[10px] font-semibold leading-none text-muted-foreground">
                {getInitials(siteName)}
              </span>
            </div>
          ) : null}
          <span className="text-[11px] leading-3.5 text-muted-foreground/70">
            {[domain, author, publishedDate].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}

      {item.sourceUrl && (
        <a
          href={item.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'flex items-center justify-center gap-1.5',
            'py-2 rounded-lg',
            'border border-border',
            'text-xs font-medium text-muted-foreground',
            'hover:text-foreground hover:border-foreground/20 transition-colors'
          )}
        >
          <ExternalLink className="size-3.5" />
          Open in browser
        </a>
      )}

      <span className="text-[10px] leading-3.5 text-muted-foreground/40">
        Captured {capturedAgo}
      </span>
    </div>
  )
})

LinkPreview.displayName = 'LinkPreview'
