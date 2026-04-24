import { invoke } from '@/lib/ipc/invoke'

export interface UrlPreviewData {
  title: string
  domain: string
  favicon?: string
  image?: string
  description?: string
}

export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url)
    return urlObj.hostname.replace('www.', '')
  } catch {
    return url
  }
}

const cache = new Map<string, Promise<UrlPreviewData>>()

export function getFaviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`
}

export function fetchLinkPreview(url: string): Promise<UrlPreviewData> {
  const cached = cache.get(url)
  if (cached) return cached

  const domain = extractDomain(url)
  const promise = invoke<UrlPreviewData>('inbox_preview_link', { args: [url] }).then((data) => ({
    ...data,
    favicon: data.favicon || getFaviconUrl(data.domain || domain)
  }))
  cache.set(url, promise)
  promise.catch(() => cache.delete(url))
  return promise
}
