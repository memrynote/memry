import { memo, useState } from 'react'
import { Globe, Play } from '@/lib/icons'
import { extractYouTubeVideoId } from '@/lib/youtube-utils'
import type { InboxItem, InboxItemListItem, LinkMetadata } from '@/types'

const PreviewImage = ({
  heroImageUrl,
  faviconUrl,
  faviconError,
  onImgError,
  onFaviconError
}: {
  heroImageUrl: string | null
  faviconUrl: string | null
  faviconError: boolean
  onImgError: () => void
  onFaviconError: () => void
}): React.JSX.Element =>
  heroImageUrl ? (
    <img
      src={heroImageUrl}
      alt=""
      className="size-full object-cover"
      onError={onImgError}
      loading="lazy"
    />
  ) : (
    <div className="flex items-center justify-center size-full bg-gradient-to-br from-muted to-surface">
      {faviconUrl && !faviconError ? (
        <img
          src={faviconUrl}
          alt=""
          className="size-12 rounded-lg object-contain"
          onError={onFaviconError}
        />
      ) : (
        <Globe className="size-8 text-muted-foreground/20" />
      )}
    </div>
  )

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
  const faviconUrl = metadata?.favicon || (raw?.logo as string) || null
  const excerpt = metadata?.description || metadata?.excerpt || item.content

  const youtubeVideoId = item.sourceUrl ? extractYouTubeVideoId(item.sourceUrl) : null
  const showHeroImage = heroImageUrl && !imgError

  const previewContent = (
    <>
      <div className="relative overflow-hidden rounded-[10px] bg-muted h-[100px]">
        <PreviewImage
          heroImageUrl={showHeroImage ? heroImageUrl : null}
          faviconUrl={faviconUrl}
          faviconError={faviconError}
          onImgError={() => setImgError(true)}
          onFaviconError={() => setFaviconError(true)}
        />
      </div>
      <h3 className="text-[17px] leading-6 font-semibold text-foreground">{item.title}</h3>
      {excerpt && (
        <p className="text-[13px] leading-5 text-muted-foreground line-clamp-3">{excerpt}</p>
      )}
    </>
  )

  if (youtubeVideoId && isPlaying) {
    return (
      <div className="flex flex-col gap-4">
        <div className="relative aspect-video overflow-hidden rounded-[10px] bg-black">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${youtubeVideoId}?autoplay=1&rel=0`}
            className="size-full"
            sandbox="allow-scripts allow-same-origin allow-presentation"
            allow="autoplay; encrypted-media"
            title={item.title || 'YouTube video'}
          />
        </div>
      </div>
    )
  }

  if (youtubeVideoId) {
    return (
      <button
        type="button"
        className="flex flex-col gap-4 text-left cursor-pointer group rounded-xl p-2 -m-2 transition-colors hover:bg-foreground/[0.03]"
        onClick={() => setIsPlaying(true)}
      >
        <div className="relative overflow-hidden rounded-[10px] bg-muted aspect-video w-full">
          <PreviewImage
            heroImageUrl={showHeroImage ? heroImageUrl : null}
            faviconUrl={faviconUrl}
            faviconError={faviconError}
            onImgError={() => setImgError(true)}
            onFaviconError={() => setFaviconError(true)}
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
            <div className="flex items-center justify-center size-14 rounded-full bg-red-600 group-hover:bg-red-500 transition-colors shadow-lg">
              <Play className="size-6 text-white ml-0.5" />
            </div>
          </div>
        </div>
        <h3 className="text-[17px] leading-6 font-semibold text-foreground">{item.title}</h3>
      </button>
    )
  }

  return (
    <a
      href={item.sourceUrl || undefined}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-col gap-4 no-underline rounded-xl p-2 -m-2 transition-colors hover:bg-foreground/[0.03] cursor-pointer"
    >
      {previewContent}
    </a>
  )
})

LinkPreview.displayName = 'LinkPreview'
