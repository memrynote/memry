import type { ArticleCapture } from '@memry/article-extract'

// Turn a defuddle extraction of the selected fragment into a forced selection
// capture. Falls back to the raw selection text when defuddle yields nothing.
export function toSelectionCapture(
  base: ArticleCapture,
  selectionText: string,
  title: string
): ArticleCapture {
  const contentMarkdown = base.contentMarkdown.trim() ? base.contentMarkdown : selectionText
  return {
    ...base,
    mode: 'selection',
    contentMarkdown,
    excerpt: selectionText.slice(0, 200),
    extractionStatus: 'full',
    force: true,
    properties: { ...base.properties, title: title || base.properties.title }
  }
}

// Build a forced screenshot capture. The body is empty; the desktop decodes
// screenshotDataUrl into an attachment and writes the real markdown body.
export function buildScreenshotDraft(
  base: ArticleCapture,
  screenshotDataUrl: string
): ArticleCapture {
  return {
    url: base.url,
    mode: 'screenshot',
    contentMarkdown: '',
    excerpt: '',
    extractionStatus: 'full',
    force: true,
    screenshotDataUrl,
    properties: { ...base.properties }
  }
}

export interface StitchSlice {
  scrollY: number
  drawY: number
}

export interface StitchPlan {
  width: number
  height: number
  slices: StitchSlice[]
}

// Plan a full-page screenshot: which scroll positions to capture and where to
// paint each viewport-tall slice on the stitched canvas. The final slice is
// bottom-aligned so it never captures blank space below the page. Total height
// is clamped to maxHeight to keep the encoded PNG under the /capture cap.
export function planStitch(opts: {
  scrollHeight: number
  innerHeight: number
  innerWidth: number
  dpr: number
  maxHeight: number
}): StitchPlan {
  const { scrollHeight, innerHeight, innerWidth, dpr, maxHeight } = opts
  const total = Math.min(scrollHeight, maxHeight)
  const tops: number[] = []
  for (let y = 0; y < total; y += innerHeight) tops.push(y)
  if (tops.length === 0) tops.push(0)
  const lastTop = Math.max(0, total - innerHeight)
  if (tops[tops.length - 1] < lastTop) tops.push(lastTop)
  else tops[tops.length - 1] = lastTop
  const unique = tops.filter((y, i) => i === 0 || y !== tops[i - 1])
  return {
    width: Math.round(innerWidth * dpr),
    height: Math.round(total * dpr),
    slices: unique.map((scrollY) => ({ scrollY, drawY: Math.round(scrollY * dpr) }))
  }
}

// Encode bytes to a base64 data URL. Chunked to avoid blowing the call stack on
// large screenshots when spreading into String.fromCharCode.
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}
