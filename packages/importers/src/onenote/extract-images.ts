/**
 * Pull inline `data:` base64 images out of OneNote page HTML so the desktop
 * importer can persist them as real vault attachments and rewrite the refs.
 *
 * Graph normally serves page images as authenticated resource URLs (handled by
 * the desktop importer's DOM pass), but pasted/legacy content can still carry
 * inline data URIs — this pure string transform lifts those. It scans
 * `<img src="data:image/...;base64,...">`, replaces each data URI with a short
 * placeholder ref, and returns the lifted images.
 *
 * @module onenote/extract-images
 */

import type { ExtractedImage, ExtractedImagesResult } from './types.ts'

/** Matches the `src="data:<mime>;base64,<payload>"` of an `<img>`. */
const DATA_IMG_SRC_REGEX =
  /<img\b([^>]*?)\bsrc=(["'])data:(image\/[a-z0-9.+-]+);base64,([^"']+)\2([^>]*)>/gi

/**
 * Extract base64 data-URI images from page HTML.
 *
 * @param html - Page HTML (already run through {@link preparePageHtml}).
 * @returns The HTML with each data-URI `src` swapped for a placeholder, plus
 *   the list of extracted images in document order.
 */
export function extractDataImages(html: string): ExtractedImagesResult {
  const images: ExtractedImage[] = []

  const out = html.replace(
    DATA_IMG_SRC_REGEX,
    (_m, pre: string, _q: string, mime: string, base64: string, post: string) => {
      const placeholder = `onenote-img-${images.length}`
      images.push({ placeholder, base64: base64.trim(), mime: mime.toLowerCase() })
      return `<img${pre}src="${placeholder}"${post}>`
    }
  )

  return { html: out, images }
}

/**
 * Map a MIME type (e.g. `image/png`) to a file extension (e.g. `png`). The
 * `x-` vendor prefix is dropped so OneNote's clipboard formats resolve to the
 * real extension (`image/x-emf` → `emf`) rather than an unusable `x-emf`.
 */
export function extensionForMime(mime: string): string {
  const subtype = (mime.split('/')[1] ?? 'png').toLowerCase().replace(/^x-/, '')
  if (subtype === 'jpeg') return 'jpg'
  if (subtype === 'svg+xml') return 'svg'
  return subtype
}
