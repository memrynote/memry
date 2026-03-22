import { memo, useMemo } from 'react'
import { ExternalLink } from '@/lib/icons'
import { extractDomain } from '@/lib/inbox-utils'
import { getTypeAccentBg } from './type-accents'
import type { InboxItem, InboxItemListItem, LinkMetadata } from '@/types'

type ContentItem = InboxItem | InboxItemListItem

interface LinkDetailContentProps {
  item: ContentItem
}

const SKIP_WORDS = new Set([
  'how',
  'to',
  'a',
  'the',
  'and',
  'or',
  'with',
  'in',
  'on',
  'for',
  'of',
  'is',
  'are',
  'was',
  'were',
  'this',
  'that',
  'an',
  'be',
  'by'
])

const getHeroWord = (title: string): string => {
  const words = title.split(/\s+/).filter(Boolean)
  const distinctive = words.find((w) => !SKIP_WORDS.has(w.toLowerCase()) && w.length > 2)
  return (distinctive || words[0] || '').toUpperCase()
}

const getInitials = (name: string): string =>
  name
    .split(/[\s.-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')

export const LinkDetailContent = memo(function LinkDetailContent({
  item
}: LinkDetailContentProps): React.JSX.Element {
  const metadata = 'metadata' in item ? (item.metadata as LinkMetadata | null) : null
  const heroImage = metadata?.heroImage || item.thumbnailUrl
  const domain = item.sourceUrl ? extractDomain(item.sourceUrl) : null

  const publishedDate = useMemo(() => {
    if (!metadata?.publishedDate) return null
    return new Date(metadata.publishedDate).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    })
  }, [metadata?.publishedDate])

  const heroWord = useMemo(() => getHeroWord(item.title || ''), [item.title])

  const sourceInitials = useMemo(() => {
    if (metadata?.siteName) return getInitials(metadata.siteName)
    if (domain) return getInitials(domain)
    return '?'
  }, [metadata?.siteName, domain])

  return (
    <div className="flex flex-col gap-3.5">
      {heroImage ? (
        <div className="w-full h-[140px] rounded-lg overflow-hidden bg-surface-active">
          <img
            src={heroImage}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              const parent = e.currentTarget.parentElement
              if (parent) parent.style.display = 'none'
            }}
          />
        </div>
      ) : (
        <div
          className="w-full h-[140px] flex items-center justify-center rounded-lg"
          style={{
            background: `linear-gradient(135deg, ${getTypeAccentBg('link', 0.06)} 0%, ${getTypeAccentBg('link', 0.12)} 50%, ${getTypeAccentBg('link', 0.18)} 100%)`
          }}
        >
          <span className="text-[32px] font-light text-foreground/10 select-none">{heroWord}</span>
        </div>
      )}

      <h2 className="text-[15px] font-medium leading-5 text-text-primary">{item.title}</h2>

      {(metadata?.description || metadata?.excerpt || item.content) && (
        <p className="text-xs leading-[18px] text-text-secondary line-clamp-4">
          {metadata?.description || metadata?.excerpt || item.content}
        </p>
      )}

      <div className="flex items-center gap-1.5">
        {metadata?.favicon ? (
          <img
            src={metadata.favicon}
            alt=""
            className="size-3.5 rounded-[3px] shrink-0 bg-surface-active"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        ) : (
          <div className="flex items-center justify-center rounded-[3px] bg-surface-active shrink-0 size-3.5">
            <span className="text-[8px] font-semibold text-text-secondary leading-none">
              {sourceInitials}
            </span>
          </div>
        )}
        <span className="text-[11px] leading-3.5 text-text-tertiary truncate">
          {domain || metadata?.siteName || 'Unknown source'}
          {publishedDate && ` · ${publishedDate}`}
        </span>
        {item.sourceUrl && (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto shrink-0 p-0.5 text-text-tertiary hover:text-text-secondary transition-colors"
            aria-label="Open in browser"
          >
            <ExternalLink size={12} />
          </a>
        )}
      </div>
    </div>
  )
})
