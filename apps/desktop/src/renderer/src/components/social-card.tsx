/**
 * Social Post Card Component
 *
 * Displays social media posts (Twitter/X, Bluesky, Mastodon, LinkedIn, Threads)
 * with author info, post content, and platform branding.
 *
 * @module components/social-card
 */

import { useState, useEffect } from 'react'
import { ExternalLink, AlertCircle, Loader2 } from '@/lib/icons'

import { cn } from '@/lib/utils'
import type { SocialMetadata, InboxMetadata } from '@/types'

// ============================================================================
// Types
// ============================================================================

/**
 * Props for social card content in list/card views
 * Works with the limited data available in InboxItemListItem
 */
interface SocialCardContentProps {
  title: string
  content: string | null
  sourceUrl: string | null
  processingStatus: string
  variant?: 'card' | 'list'
}

/**
 * Props for full social preview
 * Requires full InboxItem with metadata
 */
interface SocialPreviewProps {
  title: string
  content: string | null
  sourceUrl: string | null
  processingStatus: string
  metadata: InboxMetadata | null
}

// ============================================================================
// Platform Detection from URL
// ============================================================================

type SocialPlatform = 'twitter' | 'bluesky' | 'mastodon' | 'linkedin' | 'threads' | 'other'

/**
 * Detect social platform from URL
 */
function detectPlatformFromUrl(url: string | null): SocialPlatform {
  if (!url) return 'other'

  const lowerUrl = url.toLowerCase()

  if (lowerUrl.includes('twitter.com') || lowerUrl.includes('x.com')) return 'twitter'
  if (lowerUrl.includes('bsky.app') || lowerUrl.includes('bsky.social')) return 'bluesky'
  if (lowerUrl.includes('linkedin.com')) return 'linkedin'
  if (lowerUrl.includes('threads.net')) return 'threads'
  if (
    lowerUrl.includes('mastodon') ||
    lowerUrl.includes('fosstodon') ||
    lowerUrl.includes('hachyderm') ||
    lowerUrl.includes('mstdn')
  ) {
    return 'mastodon'
  }

  return 'other'
}

/**
 * Extract handle from URL
 */
function extractHandleFromUrl(url: string | null): string {
  if (!url) return ''

  try {
    const urlObj = new URL(url)
    const pathParts = urlObj.pathname.split('/').filter(Boolean)

    // Twitter/X: /username/status/id
    if (url.includes('twitter.com') || url.includes('x.com')) {
      return pathParts[0] ? `@${pathParts[0]}` : ''
    }

    // Bluesky: /profile/handle/post/id
    if (url.includes('bsky.app')) {
      return pathParts[1] ? `@${pathParts[1]}` : ''
    }

    // Threads: /@username/post/id
    if (url.includes('threads.net')) {
      return pathParts[0] || ''
    }

    // Mastodon: /@username/id
    if (pathParts[0]?.startsWith('@')) {
      return pathParts[0]
    }

    return ''
  } catch {
    return ''
  }
}

// ============================================================================
// Platform Icons
// ============================================================================

/**
 * Platform-specific icon/logo component
 */
const PlatformIcon = ({
  platform,
  className
}: {
  platform: SocialPlatform
  className?: string
}): React.JSX.Element => {
  const iconClass = cn('size-4', className)

  switch (platform) {
    case 'twitter':
      // X/Twitter icon (simplified X shape)
      return (
        <svg viewBox="0 0 24 24" className={iconClass} fill="currentColor" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      )
    case 'bluesky':
      // Bluesky butterfly icon (simplified)
      return (
        <svg viewBox="0 0 24 24" className={iconClass} fill="currentColor" aria-hidden="true">
          <path d="M12 2C8.5 2 6 5 6 8c0 3.5 3 6 6 6s6-2.5 6-6c0-3-2.5-6-6-6zm0 10c-2 0-4-1.5-4-4s2-4 4-4 4 1.5 4 4-2 4-4 4zm-5 4c-1 0-2 .5-2 2s1 2 2 2h10c1 0 2-.5 2-2s-1-2-2-2z" />
        </svg>
      )
    case 'mastodon':
      // Mastodon icon (simplified elephant/mastodon head)
      return (
        <svg viewBox="0 0 24 24" className={iconClass} fill="currentColor" aria-hidden="true">
          <path d="M21.258 13.99c-.274 1.41-2.456 2.955-4.962 3.254-1.306.156-2.593.3-3.965.236-2.243-.103-4.014-.535-4.014-.535 0 .218.014.426.04.62.292 2.215 2.2 2.347 4.002 2.41 1.82.062 3.44-.45 3.44-.45l.076 1.66s-1.274.684-3.542.81c-1.25.068-2.803-.032-4.612-.51-3.923-1.039-4.598-5.22-4.701-9.464-.031-1.26-.012-2.447-.012-3.44 0-4.34 2.843-5.611 2.843-5.611 1.433-.658 3.892-.935 6.45-.956h.062c2.557.02 5.018.298 6.451.956 0 0 2.843 1.272 2.843 5.61 0 0 .036 3.201-.419 5.41z" />
        </svg>
      )
    case 'linkedin':
      return (
        <svg viewBox="0 0 24 24" className={iconClass} fill="currentColor" aria-hidden="true">
          <path d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" />
        </svg>
      )
    case 'threads':
      return (
        <svg viewBox="0 0 24 24" className={iconClass} fill="currentColor" aria-hidden="true">
          <path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.59 12c.025 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.96-.065-1.182.408-2.256 1.332-3.023.873-.725 2.055-1.128 3.322-1.134.873-.004 1.682.12 2.41.365l.044-.614c.068-.964-.068-1.755-.404-2.352-.391-.693-1.04-1.048-1.978-1.086-.818-.033-1.494.156-2.01.562-.469.368-.762.905-.87 1.596l-2.095-.346c.186-1.15.704-2.082 1.542-2.773.93-.766 2.147-1.155 3.618-1.155h.153c1.593.052 2.82.593 3.648 1.607.704.864 1.073 1.994 1.098 3.363.003.188-.006.378-.028.569.838.36 1.576.879 2.168 1.548 1.054 1.192 1.569 2.73 1.49 4.452-.112 2.444-1.17 4.455-3.145 5.984C17.8 23.28 15.382 24 12.186 24z" />
        </svg>
      )
    default:
      // Generic share icon for unknown platforms
      return (
        <svg viewBox="0 0 24 24" className={iconClass} fill="currentColor" aria-hidden="true">
          <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z" />
        </svg>
      )
  }
}

/**
 * Get platform display name
 */
function getPlatformName(platform: SocialPlatform): string {
  switch (platform) {
    case 'twitter':
      return 'X'
    case 'bluesky':
      return 'Bluesky'
    case 'mastodon':
      return 'Mastodon'
    case 'linkedin':
      return 'LinkedIn'
    case 'threads':
      return 'Threads'
    default:
      return 'Social'
  }
}

/**
 * Get platform color for accents
 */
function getPlatformColor(platform: SocialPlatform): string {
  switch (platform) {
    case 'twitter':
      return 'text-[#1DA1F2]'
    case 'bluesky':
      return 'text-[#0085FF]'
    case 'mastodon':
      return 'text-[#6364FF]'
    case 'linkedin':
      return 'text-[#0077B5]'
    case 'threads':
      return 'text-[#000000] dark:text-[#FFFFFF]'
    default:
      return 'text-[var(--muted-foreground)]'
  }
}

// ============================================================================
// Author Avatar Component
// ============================================================================

const AuthorAvatar = ({
  avatarUrl,
  authorName,
  platform,
  size = 'md'
}: {
  avatarUrl?: string
  authorName: string
  platform: SocialPlatform
  size?: 'sm' | 'md' | 'lg'
}): React.JSX.Element => {
  const [imageError, setImageError] = useState(false)

  useEffect(() => {
    setImageError(false)
  }, [avatarUrl])

  const sizeClasses = {
    sm: 'size-6',
    md: 'size-10',
    lg: 'size-14'
  }

  const textSizeClasses = {
    sm: 'text-xs',
    md: 'text-base',
    lg: 'text-xl'
  }

  // Show avatar image if available
  if (avatarUrl && !imageError) {
    return (
      <img
        src={avatarUrl}
        alt={authorName}
        className={cn(sizeClasses[size], 'rounded-full object-cover ring-2 ring-[var(--border)]')}
        onError={() => setImageError(true)}
        loading="lazy"
      />
    )
  }

  // Fallback to initials with platform color
  const initials =
    authorName
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || '?'

  return (
    <div
      className={cn(
        sizeClasses[size],
        'rounded-full flex items-center justify-center bg-[var(--muted)]',
        getPlatformColor(platform)
      )}
    >
      <span className={cn(textSizeClasses[size], 'font-medium')}>{initials}</span>
    </div>
  )
}

// ============================================================================
// Social Card Content (for list/card views)
// ============================================================================

/**
 * Card variant - compact display for grid view
 */
const SocialCardCompact = ({
  title,
  content,
  sourceUrl,
  processingStatus
}: SocialCardContentProps): React.JSX.Element => {
  const platform = detectPlatformFromUrl(sourceUrl)
  const handle = extractHandleFromUrl(sourceUrl)
  const isLoading = processingStatus === 'pending' || processingStatus === 'processing'
  const hasFailed = processingStatus === 'failed'

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Header with platform icon and handle */}
      <div className="flex items-center gap-2">
        <div className="relative flex-shrink-0">
          <AuthorAvatar
            avatarUrl={undefined}
            authorName={handle || title}
            platform={platform}
            size="sm"
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            <PlatformIcon platform={platform} className={getPlatformColor(platform)} />
            <span className="text-xs font-medium text-[var(--foreground)] truncate">
              {handle || getPlatformName(platform)}
            </span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <Loader2 className="size-3 animate-spin" />
            <span>Loading post...</span>
          </div>
        ) : hasFailed ? (
          <div className="flex items-center gap-2 text-xs text-[var(--destructive)]">
            <AlertCircle className="size-3" />
            <span>Failed to load</span>
          </div>
        ) : (
          <p className="text-xs text-[var(--muted-foreground)] leading-relaxed line-clamp-3">
            {content || title || 'View post →'}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * List variant - horizontal display for list view
 */
const SocialCardList = ({
  title,
  content,
  sourceUrl,
  processingStatus
}: SocialCardContentProps): React.JSX.Element => {
  const platform = detectPlatformFromUrl(sourceUrl)
  const handle = extractHandleFromUrl(sourceUrl)
  const isLoading = processingStatus === 'pending' || processingStatus === 'processing'

  return (
    <div className="flex items-center gap-3">
      {/* Avatar and platform */}
      <div className="relative flex-shrink-0">
        <AuthorAvatar
          avatarUrl={undefined}
          authorName={handle || title}
          platform={platform}
          size="md"
        />
        {/* Platform badge */}
        <div
          className={cn(
            'absolute -bottom-1 -right-1 size-4 rounded-full bg-[var(--background)] flex items-center justify-center',
            'ring-2 ring-[var(--background)]'
          )}
        >
          <PlatformIcon platform={platform} className={cn('size-3', getPlatformColor(platform))} />
        </div>
      </div>

      {/* Author info and content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--foreground)] truncate">
            {title || getPlatformName(platform)}
          </span>
          {handle && (
            <span className="text-xs text-[var(--muted-foreground)] truncate">{handle}</span>
          )}
          {isLoading && <Loader2 className="size-3 animate-spin text-[var(--muted-foreground)]" />}
        </div>
        <p className="text-xs text-[var(--muted-foreground)] line-clamp-1">
          {content || sourceUrl}
        </p>
      </div>
    </div>
  )
}

// ============================================================================
// Social Preview (for preview panel with full metadata)
// ============================================================================

/**
 * Preview variant - full display for preview panel
 */
const SocialPreview = ({
  title,
  content,
  sourceUrl,
  processingStatus,
  metadata
}: SocialPreviewProps): React.JSX.Element => {
  // Try to get social metadata
  const socialMeta = metadata as SocialMetadata | null
  const platform = socialMeta?.platform || detectPlatformFromUrl(sourceUrl)
  const isLoading = processingStatus === 'pending' || processingStatus === 'processing'
  const hasFailed = processingStatus === 'failed'

  const authorName = socialMeta?.authorName || ''
  const authorHandle = socialMeta?.authorHandle || extractHandleFromUrl(sourceUrl)
  const authorAvatar = socialMeta?.authorAvatar
  const postContent = socialMeta?.postContent || content || ''
  const timestamp = socialMeta?.timestamp
  const mediaUrls = socialMeta?.mediaUrls || []

  return (
    <div className="flex flex-col gap-4">
      {/* Header with author info */}
      <div className="flex items-start gap-3">
        <AuthorAvatar
          avatarUrl={authorAvatar}
          authorName={authorName || authorHandle}
          platform={platform}
          size="lg"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-[var(--foreground)]">
              {authorName || title || 'Unknown Author'}
            </span>
            <PlatformIcon
              platform={platform}
              className={cn('size-4', getPlatformColor(platform))}
            />
          </div>
          {authorHandle && (
            <span className="text-sm text-[var(--muted-foreground)]">{authorHandle}</span>
          )}
          {timestamp && (
            <span className="text-xs text-[var(--muted-foreground)] block mt-1">
              {new Date(timestamp).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* Post content */}
      <div className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-[var(--muted-foreground)]">
            <Loader2 className="size-5 animate-spin" />
            <span>Loading post content...</span>
          </div>
        ) : hasFailed ? (
          <div className="flex items-center gap-2 py-4 text-[var(--destructive)]">
            <AlertCircle className="size-5" />
            <span>Failed to load post content. The post may be private or deleted.</span>
          </div>
        ) : (
          <p className="text-sm text-[var(--foreground)] whitespace-pre-wrap leading-relaxed">
            {postContent || 'No content available'}
          </p>
        )}

        {/* Media (if any) */}
        {mediaUrls.length > 0 && (
          <div className="grid grid-cols-2 gap-2 rounded-lg overflow-hidden">
            {mediaUrls.slice(0, 4).map((url, index) => (
              <img
                key={index}
                src={url}
                alt={`Post media ${index + 1}`}
                className="w-full aspect-square object-cover"
                loading="lazy"
              />
            ))}
          </div>
        )}
      </div>

      {/* Open original link */}
      {sourceUrl && (
        <a
          href={sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'flex items-center gap-2 text-sm font-medium',
            getPlatformColor(platform),
            'hover:underline'
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink className="size-4" />
          View on {getPlatformName(platform)}
        </a>
      )}
    </div>
  )
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Social Card Content component for list/card views
 *
 * Works with the limited data available in InboxItemListItem
 */
export const SocialCardContent = ({
  title,
  content,
  sourceUrl,
  processingStatus,
  variant = 'card'
}: SocialCardContentProps): React.JSX.Element => {
  switch (variant) {
    case 'list':
      return (
        <SocialCardList
          title={title}
          content={content}
          sourceUrl={sourceUrl}
          processingStatus={processingStatus}
        />
      )
    case 'card':
    default:
      return (
        <SocialCardCompact
          title={title}
          content={content}
          sourceUrl={sourceUrl}
          processingStatus={processingStatus}
        />
      )
  }
}

export {
  SocialPreview,
  PlatformIcon,
  AuthorAvatar,
  getPlatformName,
  getPlatformColor,
  detectPlatformFromUrl
}
export type { SocialCardContentProps, SocialPreviewProps }
