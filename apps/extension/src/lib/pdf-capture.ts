import type { ArticleCapture } from '@memry/article-extract'

// Raw cap, enforced before base64 so an oversized PDF fails fast instead of
// 413-ing after we've spent the memory encoding it. The desktop /capture body
// limit is 25MB and base64 inflates by ~4/3, so 16MB leaves envelope headroom.
export const MAX_PDF_BYTES = 16 * 1024 * 1024

const PDF_MAGIC = '%PDF-'

// Host-permission match pattern for a page we may need to re-fetch. Only http(s)
// is fetchable with the user's cookies; blob:, file: and chrome: never are.
export function originPatternOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return `${parsed.origin}/*`
  } catch {
    return null
  }
}

function sanitize(name: string): string {
  return name.replace(/[/\\]/g, '_').trim()
}

function fromContentDisposition(header: string | null): string | null {
  if (!header) return null
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header)
  const bare = /filename\s*=\s*([^;]+)/i.exec(header)
  const raw = quoted?.[1] ?? bare?.[1]
  return raw ? sanitize(raw) || null : null
}

function fromUrlPath(url: string): string | null {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop()
    if (!last) return null
    return sanitize(decodeURIComponent(last)) || null
  } catch {
    return null
  }
}

// Best available name for the stored file, always ending in .pdf.
export function pdfFilenameFrom(url: string, contentDisposition: string | null): string {
  const name = fromContentDisposition(contentDisposition) ?? fromUrlPath(url) ?? 'document'
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`
}

// Cheap proof the bytes really are a PDF. An auth-gated URL commonly returns a
// 200 HTML login page; without this we would store that as a corrupt "PDF".
export function isPdfBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false
  return String.fromCharCode(...bytes.subarray(0, PDF_MAGIC.length)) === PDF_MAGIC
}

// The draft the popup shows before any bytes exist. Fetching them needs a host
// permission that only a user gesture can request, so mount-time we have nothing
// but tab metadata. `force: true` skips the desktop's URL dedup, whose enrichment
// branch would update content/metadata only and drop the PDF bytes.
export function buildPdfDraft(
  tab: { url?: string; title?: string },
  now: string = new Date().toISOString()
): ArticleCapture | null {
  if (!tab.url || !originPatternOf(tab.url)) return null
  const filename = fromUrlPath(tab.url)
  const title = filename?.replace(/\.[^.]+$/, '') || tab.title?.trim() || tab.url
  return {
    url: tab.url,
    mode: 'pdf',
    contentMarkdown: '',
    excerpt: '',
    extractionStatus: 'full',
    force: true,
    tags: ['clippings'],
    properties: { title, source: tab.url, created: now }
  }
}
