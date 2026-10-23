import { imageTarget } from '@memry/importers/readwise'
import { htmlToMarkdown } from '../import/_shared/html-to-markdown'

const DROPPED_TAGS = new Set(['script', 'style', 'noscript'])

/** Attributes lazy-loading pages put the real image URL in, while `src` holds a placeholder. */
const LAZY_SRC_ATTRIBUTES = ['data-src', 'data-lazy-src', 'data-original']

export interface ReaderFullText {
  /** Remote images the article shows, in document order. The writer saves them (D14). */
  imageUrls: string[]
  /**
   * The article as markdown. `images` maps a remote URL to the vault ref it was
   * saved under. An image that is not in the map is left out with its caption,
   * so no remote URL reaches the note.
   */
  render(images: ReadonlyMap<string, string>): string
}

/** The largest candidate of an `srcset` value. */
function largestSrcsetUrl(srcset: string): string | null {
  let best: { url: string; width: number } | null = null
  for (const candidate of srcset.split(/,\s+|,$/)) {
    const [url, descriptor] = candidate.trim().split(/\s+/)
    if (!url) continue
    const width = descriptor?.endsWith('w') ? Number.parseFloat(descriptor) : 0
    if (best === null || width > best.width) best = { url, width: Number.isNaN(width) ? 0 : width }
  }
  return best?.url ?? null
}

function absoluteHttpUrl(
  value: string | null | undefined,
  base: string | undefined
): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * Points `src` at the image a reader would see: `src` itself, else a lazy
 * attribute, else the largest `srcset` candidate, else the `<picture>`'s
 * `<source>`. Anything that is not an http(s) URL (a data: placeholder, a
 * blob) leaves `src` empty, and the converter drops the image.
 */
function normalizeImageSource(img: Element, base: string | undefined): void {
  const picture = img.closest('picture')
  const candidates = [
    img.getAttribute('src'),
    ...LAZY_SRC_ATTRIBUTES.map((name) => img.getAttribute(name)),
    largestSrcsetUrl(img.getAttribute('srcset') ?? img.getAttribute('data-srcset') ?? ''),
    ...Array.from(picture?.querySelectorAll('source') ?? []).map((source) =>
      largestSrcsetUrl(source.getAttribute('srcset') ?? '')
    )
  ]
  for (const candidate of candidates) {
    const url = absoluteHttpUrl(candidate, base)
    if (url) {
      img.setAttribute('src', url)
      return
    }
  }
  img.setAttribute('src', '')
}

/** Alt text on one line, without the characters that end or reshape a markdown image. */
function altText(alt: string): string {
  return alt
    .replace(/[[\]\\|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * A Reader document's `html_content` as markdown, through the converter the
 * importers share (D11). Images are kept: the writer downloads `imageUrls`
 * into the vault once the note exists and calls `render` with the refs (D14).
 * An image with a caption is written the way the editor writes one,
 * `<figure><img><figcaption>`, which it reads back byte for byte. One without
 * is `![alt](ref)`.
 *
 * `baseUrl` resolves relative image URLs (the document's own URL).
 */
export async function prepareReaderFullText(
  html: string,
  baseUrl?: string | null
): Promise<ReaderFullText> {
  // Lazy: jsdom stays out of the main process startup set (see lazy-jsdom.ts).
  const { JSDOM } = await import('../import/_shared/lazy-jsdom')
  const { body } = new JSDOM(`<html><body>${html}</body></html>`).window.document
  for (const img of Array.from<Element>(body.querySelectorAll('img'))) {
    normalizeImageSource(img, baseUrl ?? undefined)
  }

  const convert = (images: ReadonlyMap<string, string> | null, found: Set<string>): string =>
    htmlToMarkdown(body, {
      image: (src, alt) => {
        if (!src) return ''
        found.add(src)
        const ref = images?.get(src)
        return ref === undefined ? '' : `![${altText(alt)}](${imageTarget(ref)})`
      },
      captionedImage: (src, _alt, caption) => {
        if (!src) return ''
        found.add(src)
        const ref = images?.get(src)
        if (ref === undefined) return ''
        return `<figure><img src="${escapeHtml(ref).replace(/"/g, '&quot;')}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`
      },
      skipBlock: (el) => DROPPED_TAGS.has(el.tagName.toLowerCase())
    }).markdown

  const found = new Set<string>()
  convert(null, found)
  return {
    imageUrls: [...found],
    render: (images) => convert(images, new Set())
  }
}
