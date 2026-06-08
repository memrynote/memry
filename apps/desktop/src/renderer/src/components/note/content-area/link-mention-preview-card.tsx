import { memo } from 'react'
import { createPortal } from 'react-dom'
import type { UrlPreviewData } from '@/lib/url-metadata'
import { extractYouTubeVideoId, getYouTubeEmbedUrl } from '@/lib/youtube-utils'

interface LinkMentionPreviewCardProps {
  url: string
  preview: UrlPreviewData
  position: { top: number; left: number; placement: 'above' | 'below' }
  onMouseEnter: () => void
  onMouseLeave: () => void
}

export const LinkMentionPreviewCard = memo(function LinkMentionPreviewCard({
  url,
  preview,
  position,
  onMouseEnter,
  onMouseLeave
}: LinkMentionPreviewCardProps) {
  const videoId = extractYouTubeVideoId(url)

  return createPortal(
    <div
      data-link-mention-preview=""
      className="fixed z-50 w-[320px] overflow-hidden rounded-[10px] border border-border/40 bg-popover shadow-[var(--shadow-dropdown)] animate-in fade-in-0 zoom-in-95 duration-150"
      style={{
        top: position.top,
        left: position.left,
        transformOrigin: position.placement === 'below' ? 'top left' : 'bottom left'
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {videoId ? (
        <div className="aspect-video bg-black">
          <iframe
            src={getYouTubeEmbedUrl(videoId)}
            className="size-full"
            sandbox="allow-scripts allow-same-origin allow-presentation"
            allow="autoplay; encrypted-media"
            title={preview.title || 'YouTube video'}
          />
        </div>
      ) : (
        preview.image && (
          <div className="max-h-[160px] overflow-hidden bg-muted">
            <img
              src={preview.image}
              alt=""
              className="w-full object-cover"
              onError={(e) => {
                ;(e.currentTarget.parentElement as HTMLElement).style.display = 'none'
              }}
            />
          </div>
        )
      )}
      <div className="flex flex-col gap-1 px-3 py-2.5">
        {preview.title && (
          <span className="truncate text-[13px] font-semibold text-foreground">
            {preview.title}
          </span>
        )}
        {!videoId && preview.description && (
          <p className="line-clamp-3 text-xs text-muted-foreground">{preview.description}</p>
        )}
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          {preview.favicon && (
            <img
              src={preview.favicon}
              alt=""
              className="size-3.5 shrink-0 rounded-[3px] object-contain"
              onError={(e) => {
                ;(e.currentTarget as HTMLImageElement).style.display = 'none'
              }}
            />
          )}
          <span className="truncate">{preview.siteName || preview.domain || url}</span>
        </div>
      </div>
    </div>,
    document.body
  )
})
