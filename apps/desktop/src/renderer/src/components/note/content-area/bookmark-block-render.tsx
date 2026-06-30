import { useEffect, useState } from 'react'
import { fetchLinkPreview, type UrlPreviewData } from '@/lib/url-metadata'

interface BookmarkProps {
  url: string
  domain: string
  title: string
  description: string
  image: string
  favicon: string
  siteName: string
}

export function BookmarkBlockRender({
  block,
  contentRef
}: {
  block: { props: BookmarkProps }
  contentRef: React.Ref<HTMLDivElement>
}) {
  const { url, domain, title, description, image, favicon, siteName } = block.props

  // Markdown round-trip is lossy (URL only) — hydrate display-only metadata
  // on mount when the block has no title. Never writes back to the block.
  const [fetched, setFetched] = useState<UrlPreviewData | null>(null)
  useEffect(() => {
    if (title || !url) return
    let cancelled = false
    fetchLinkPreview(url)
      .then((data) => {
        if (!cancelled) setFetched(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [title, url])

  const displayTitle = title || fetched?.title || ''
  const displayDescription = description || fetched?.description || ''
  const displayImage = image || fetched?.image || ''
  const displayFavicon = favicon || fetched?.favicon || ''
  const hostname = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  })()
  const displaySite = siteName || fetched?.siteName || domain || fetched?.domain || hostname

  if (!url) {
    return <div ref={contentRef} className="p-2 text-muted-foreground text-sm" />
  }

  return (
    <div ref={contentRef} className="bookmark-block my-2" contentEditable={false}>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="bookmark-link flex max-h-[100px] w-full items-stretch overflow-hidden rounded-[10px] border border-border bg-background no-underline transition-colors hover:bg-muted/40"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 p-3">
          {displayTitle ? (
            <span className="truncate text-sm font-medium text-foreground">{displayTitle}</span>
          ) : (
            <span className="truncate text-sm font-medium text-muted-foreground">{hostname}</span>
          )}
          {displayDescription && (
            <span className="line-clamp-2 text-xs text-muted-foreground">{displayDescription}</span>
          )}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {displayFavicon && (
              <img
                src={displayFavicon}
                alt=""
                className="size-3.5 shrink-0 rounded-[3px] object-cover"
                onError={(e) => {
                  ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                }}
              />
            )}
            <span className="truncate">{displaySite}</span>
          </span>
        </div>
        {displayImage && (
          <div className="hidden w-[30%] max-w-[180px] shrink-0 sm:block">
            <img src={displayImage} alt="" className="size-full object-cover" />
          </div>
        )}
      </a>
    </div>
  )
}
