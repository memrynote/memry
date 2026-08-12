export interface UrlPreviewData {
  title: string
  domain: string
  favicon?: string
  image?: string
  description?: string
  siteName?: string
}

export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url)
    return urlObj.hostname.replace('www.', '')
  } catch {
    return url
  }
}

/**
 * Link previews are cached for the whole renderer session so reopening a note
 * does not refetch every link it contains. Eviction policy: LRU, capped at
 * PREVIEW_CACHE_LIMIT entries.
 *
 * The cap matters because nothing here is user-driven — `hydrateLinkMentionFavicons`
 * calls `fetchLinkPreview` for every link mention in every note that gets opened,
 * so an unbounded map retains one resolved promise (title, description, image and
 * favicon URLs) per distinct link URL for as long as the window lives.
 *
 * A `Map` iterates in insertion order, so insertion order is used as the recency
 * order: a cache hit reinserts its key, which makes the first key the least
 * recently *used* one and therefore the one evicted when the cap is exceeded.
 */
const PREVIEW_CACHE_LIMIT = 200
const cache = new Map<string, Promise<UrlPreviewData>>()

function readCache(url: string): Promise<UrlPreviewData> | undefined {
  const cached = cache.get(url)
  if (!cached) return undefined
  cache.delete(url)
  cache.set(url, cached)
  return cached
}

function writeCache(url: string, promise: Promise<UrlPreviewData>): void {
  cache.set(url, promise)
  while (cache.size > PREVIEW_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** Dev/test tooling: drop every cached link preview. */
export function clearLinkPreviewCache(): void {
  cache.clear()
}

/** Dev/test tooling: how many link previews are currently cached. */
export function linkPreviewCacheSize(): number {
  return cache.size
}

export function getFaviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`
}

export function fetchLinkPreview(url: string): Promise<UrlPreviewData> {
  const cached = readCache(url)
  if (cached) return cached

  const domain = extractDomain(url)
  const promise = (window.api.inbox.previewLink(url) as Promise<UrlPreviewData>).then((data) => ({
    ...data,
    favicon: data.favicon || getFaviconUrl(data.domain || domain)
  }))
  writeCache(url, promise)
  promise.catch(() => {
    // Only evict when this exact promise is still the cached one: eviction plus a
    // refetch can already have replaced it, and dropping that entry would throw
    // away a good preview.
    if (cache.get(url) === promise) cache.delete(url)
  })
  return promise
}
