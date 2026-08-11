import type { ArticleCapture } from '@memry/article-extract'

// Raw cap, enforced before base64 so an oversized PDF fails fast instead of
// 413-ing after we've spent the memory encoding it. The desktop /capture body
// limit is 25MB and base64 inflates by ~4/3, so 16MB leaves envelope headroom.
export const MAX_PDF_BYTES = 16 * 1024 * 1024

const PDF_MAGIC = '%PDF-'

// Host-permission match pattern for a page we may need to re-fetch. Only http(s)
// is fetchable with the user's cookies; blob:, file: and chrome: never are.
// Built from hostname, NOT origin: a match-pattern host may not carry a port, so
// `https://intranet.corp:8443/*` either throws in permissions.contains() or never
// matches the real host — either way the grant is silently skipped and the fetch
// is blocked with no prompt.
export function originPatternOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return `${parsed.protocol}//${parsed.hostname}/*`
  } catch {
    return null
  }
}

function sanitize(name: string): string {
  return name.replace(/[/\\]/g, '_').trim()
}

// RFC 5987 value: `charset'language'percent-encoded-name`. Only the name matters
// to us; the charset is always UTF-8 in practice and decodeURIComponent assumes it.
function decodeExtendedValue(value: string): string | null {
  const match = /^[^']*'[^']*'(.*)$/.exec(value.trim())
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

function fromContentDisposition(header: string | null): string | null {
  if (!header) return null
  // `filename*=UTF-8''…` wins when both forms are present: it is the only one
  // that can carry a non-ASCII name, and servers send the plain `filename` beside
  // it purely as an ASCII-mangled fallback.
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header)
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header)
  const bare = /filename\s*=\s*([^;]+)/i.exec(header)
  const raw = (extended?.[1] ? decodeExtendedValue(extended[1]) : null) ?? quoted?.[1] ?? bare?.[1]
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

// Matches the contract's pdfFilename bound. A longer name would 422 on the
// desktop, and a 422 is not retryable and PDF captures are never queued — the
// clip would be lost outright rather than merely misnamed.
const MAX_FILENAME_LENGTH = 255

// Best available name for the stored file, always ending in .pdf.
export function pdfFilenameFrom(url: string, contentDisposition: string | null): string {
  const name = fromContentDisposition(contentDisposition) ?? fromUrlPath(url) ?? 'document'
  const stem = (/\.pdf$/i.test(name) ? name.slice(0, -4) : name).slice(
    0,
    MAX_FILENAME_LENGTH - '.pdf'.length
  )
  return `${stem}.pdf`
}

// Cheap proof the bytes really are a PDF. An auth-gated URL commonly returns a
// 200 HTML login page; without this we would store that as a corrupt "PDF".
export function isPdfBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false
  return String.fromCharCode(...bytes.subarray(0, PDF_MAGIC.length)) === PDF_MAGIC
}

export type PdfBytesCheck = { ok: true } | { ok: false; error: 'not-a-pdf' | 'pdf-too-large' }

// Classify a fetched response body before we trust it as a PDF. Order matters:
// the magic-byte check must run before the size check, because an auth-gated
// URL commonly answers 200 with an HTML login page — checking size first would
// let a large login page masquerade as "pdf-too-large" instead of "not-a-pdf",
// and a future refactor that swapped these lines would silently store the
// login page as a corrupt "PDF".
export function checkPdfBytes(bytes: Uint8Array): PdfBytesCheck {
  if (!isPdfBytes(bytes)) return { ok: false, error: 'not-a-pdf' }
  if (bytes.length > MAX_PDF_BYTES) return { ok: false, error: 'pdf-too-large' }
  return { ok: true }
}

export type PdfLengthCheck = { ok: true } | { ok: false; error: 'pdf-too-large' }

// Reject an oversized body from its Content-Length, BEFORE the whole response is
// buffered. checkPdfBytes only spares us the base64 cost; the download itself is
// the unbounded one, and a multi-gigabyte body at a .pdf URL would OOM the
// service worker before any check ran. A missing, blank or non-numeric header —
// chunked responses legitimately omit it — falls through to the post-read
// checkPdfBytes rather than being trusted or rejected on a guess.
export function checkPdfContentLength(header: string | null): PdfLengthCheck {
  if (!header || !/^\d+$/.test(header.trim())) return { ok: true }
  return Number(header.trim()) > MAX_PDF_BYTES
    ? { ok: false, error: 'pdf-too-large' }
    : { ok: true }
}

// Only a URL whose PATH ends in `.pdf` is offered as a PDF. A failed content-script
// EXTRACT is NOT proof of a PDF: browsers do not inject content scripts into tabs
// that were already open when the extension updated, so every such tab looks
// identical to a PDF viewer. Without this, an ordinary article would show a PDF
// badge and its Send would ask for a persistent site grant that buys nothing.
// Content-negotiated PDFs at extension-less URLs fall back to "Couldn't read this
// page" — the pre-branch behaviour, so no regression.
function hasPdfPath(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

// The draft the popup shows before any bytes exist. Fetching them needs a host
// permission that only a user gesture can request, so mount-time we have nothing
// but tab metadata. `force: true` skips the desktop's URL dedup, whose enrichment
// branch would update content/metadata only and drop the PDF bytes. Null unless
// the tab is a fetchable http(s) URL with a `.pdf` path — see hasPdfPath.
export function buildPdfDraft(
  tab: { url?: string; title?: string },
  now: string = new Date().toISOString()
): ArticleCapture | null {
  if (!tab.url || !originPatternOf(tab.url) || !hasPdfPath(tab.url)) return null
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
