/**
 * Social Post Card Component
 *
 * Displays Twitter/X posts with author info, post content, and platform branding.
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

type SocialPlatform = 'twitter' | 'other'

function detectPlatformFromUrl(url: string | null): SocialPlatform {
  if (!url) return 'other'

  const lowerUrl = url.toLowerCase()
  if (lowerUrl.includes('twitter.com') || lowerUrl.includes('x.com')) return 'twitter'

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

    if (url.includes('twitter.com') || url.includes('x.com')) {
      return pathParts[0] ? `@${pathParts[0]}` : ''
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
      return (
        <svg viewBox="0 0 24 24" className={iconClass} fill="currentColor" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      )
    default:
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
          <div className="grid grid-cols-2 gap-2 rounded-md overflow-hidden">
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
  detectPlatformFromUrl,
  extractHandleFromUrl
}
export type { SocialCardContentProps, SocialPreviewProps }
