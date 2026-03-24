import { useState } from 'react'
import { useTweet } from 'react-tweet'
import { ExternalLink } from '@/lib/icons'
import { cn } from '@/lib/utils'
import type { SocialMetadata } from '@/types'

interface TweetCardItem {
  id: string
  type: string
  title: string
  content: string | null
  sourceUrl: string | null
  processingStatus: string
  metadata: SocialMetadata | Record<string, unknown> | null
}

interface TweetCardProps {
  item: TweetCardItem
}

function extractTweetId(url: string | null): string | null {
  if (!url) return null
  const match = url.match(/\/status\/(\d+)/)
  return match ? match[1] : null
}

function formatCount(n: number | undefined): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

// ============================================================================
// Skeleton
// ============================================================================

function TweetSkeleton(): React.JSX.Element {
  return (
    <div data-testid="tweet-skeleton" className="flex flex-col gap-3.5 p-5 animate-pulse">
      <div className="flex items-center gap-2.5">
        <div className="rounded-[18px] size-9 bg-[var(--muted)]" />
        <div className="flex flex-col gap-1.5">
          <div className="h-3.5 w-28 rounded bg-[var(--muted)]" />
          <div className="h-3 w-16 rounded bg-[var(--muted)]" />
        </div>
      </div>
      <div className="rounded-lg p-3.5 bg-[var(--surface)]">
        <div className="space-y-2">
          <div className="h-4 w-full rounded bg-[var(--muted)]" />
          <div className="h-4 w-3/4 rounded bg-[var(--muted)]" />
          <div className="h-4 w-1/2 rounded bg-[var(--muted)]" />
        </div>
      </div>
      <div className="flex gap-5">
        <div className="h-3 w-10 rounded bg-[var(--muted)]" />
        <div className="h-3 w-10 rounded bg-[var(--muted)]" />
        <div className="h-3 w-16 rounded bg-[var(--muted)]" />
      </div>
    </div>
  )
}

// ============================================================================
// Error State
// ============================================================================

function TweetUnavailable({ url }: { url: string | null }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-sm font-medium text-[var(--foreground)]">Tweet unavailable</div>
      <div className="text-xs text-[var(--muted-foreground)]">
        This tweet may have been deleted or is from a private account.
      </div>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs font-medium text-[var(--accent-cyan)] hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="size-3" />
          Open on x.com
        </a>
      )}
    </div>
  )
}

// ============================================================================
// Avatar
// ============================================================================

function TweetAvatar({ imageUrl, name }: { imageUrl?: string; name: string }): React.JSX.Element {
  const [imgError, setImgError] = useState(false)
  const initial = (name[0] || '?').toUpperCase()

  if (imageUrl && !imgError) {
    return (
      <img
        src={imageUrl}
        alt={name}
        className="shrink-0 rounded-[18px] size-9 object-cover"
        onError={() => setImgError(true)}
        loading="lazy"
      />
    )
  }

  return (
    <div className="flex items-center justify-center shrink-0 rounded-[18px] size-9 bg-[var(--muted)]">
      <span className="text-sm/4.5 font-semibold text-[var(--muted-foreground)]">{initial}</span>
    </div>
  )
}

// ============================================================================
// Metrics
// ============================================================================

function TweetMetrics({
  likes,
  retweets,
  views
}: {
  likes?: number
  retweets?: number
  views?: number
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-5 text-[11px]/3.5 text-[var(--muted-foreground)]">
      <div className="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M6 10.5s-4.5-3-4.5-5.5a2.5 2.5 0 015 0 2.5 2.5 0 015 0c0 2.5-4.5 5.5-4.5 5.5z"
            stroke="currentColor"
            strokeWidth="1"
            className="text-red-500/70"
            fill="none"
          />
        </svg>
        <span>{formatCount(likes)}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M1 4.5h3L6 2l2 2.5h3L9 7l1 3.5L6 8.5l-4 2L3 7 1 4.5z"
            stroke="currentColor"
            strokeWidth="1"
            className="text-emerald-500/70"
            fill="none"
          />
        </svg>
        <span>{formatCount(retweets)}</span>
      </div>
      {views !== undefined && (
        <div className="flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6z"
              stroke="currentColor"
              strokeWidth="1"
              fill="none"
            />
            <circle cx="6" cy="6" r="1.5" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
          <span>{formatCount(views)} views</span>
        </div>
      )}
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function TweetCard({ item }: TweetCardProps): React.JSX.Element {
  const meta = item.metadata as SocialMetadata | null
  const tweetId = meta?.tweetId || extractTweetId(item.sourceUrl)

  const { data: tweet, error, isLoading } = useTweet(tweetId ?? undefined)

  if (!tweetId) {
    return <TweetUnavailable url={item.sourceUrl} />
  }

  if (isLoading) {
    return <TweetSkeleton />
  }

  if (error || !tweet) {
    return <TweetUnavailable url={item.sourceUrl} />
  }

  const user = tweet.user
  const text = tweet.text || ''

  return (
    <div
      className={cn(
        'flex flex-col shrink-0 gap-3.5',
        'border-b border-[var(--border)]',
        'text-xs/4 p-5'
      )}
    >
      {/* Header: avatar + author + badge */}
      <div className="flex items-center gap-2.5">
        <TweetAvatar imageUrl={user.profile_image_url_https} name={user.name} />
        <div className="flex flex-col gap-px">
          <span className="text-[13px]/4 font-medium text-[var(--foreground)]">{user.name}</span>
          <span className="text-[11px]/3.5 text-[var(--muted-foreground)]">
            @{user.screen_name}
          </span>
        </div>
        <div className="flex items-center ml-auto rounded-[10px] py-0.5 px-2 bg-[var(--accent-cyan)]/10">
          <span className="text-[10px]/3.5 font-medium text-[var(--accent-cyan)]">x.com</span>
        </div>
      </div>

      {/* Content */}
      <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] p-3.5">
        <p className="text-sm/5.5 text-[var(--foreground)] whitespace-pre-wrap">{text}</p>
      </div>

      {/* Media */}
      {tweet.mediaDetails && tweet.mediaDetails.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5 rounded-lg overflow-hidden">
          {tweet.mediaDetails.slice(0, 4).map((media, i) => (
            <img
              key={i}
              src={media.media_url_https}
              alt={`Tweet media ${i + 1}`}
              className={cn(
                'w-full object-cover',
                tweet.mediaDetails!.length === 1 ? 'col-span-2 max-h-72' : 'aspect-square'
              )}
              loading="lazy"
            />
          ))}
        </div>
      )}

      {/* Metrics */}
      <TweetMetrics
        likes={tweet.favorite_count}
        retweets={(tweet as unknown as Record<string, unknown>).retweet_count as number | undefined}
        views={
          (tweet as unknown as Record<string, unknown>).views_count
            ? Number((tweet as unknown as Record<string, unknown>).views_count)
            : undefined
        }
      />

      {/* Open link */}
      {item.sourceUrl && (
        <a
          href={item.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs font-medium text-[var(--accent-cyan)] hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="size-3" />
          View on X
        </a>
      )}
    </div>
  )
}
