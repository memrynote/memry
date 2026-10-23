import {
  collapseWhitespace,
  escapeLine,
  formatDay,
  headingLevel,
  inlineTags,
  toIsoInstant
} from './text.ts'
import type { ReadwiseHighlight, SavedImages } from './types.ts'

const IMAGE_TEXT = /^!\[[^\]]*\]\(\s*<?([^\s>)]+)>?\s*\)$/

export function highlightUrl(highlight: ReadwiseHighlight): string {
  return highlight.readwise_url || `https://readwise.io/open/${highlight.id}`
}

/** Ids of the highlights whose Readwise link is in `markdown`. */
export function linkedHighlightIds(markdown: string): Set<number> {
  const ids = new Set<number>()
  for (const match of markdown.matchAll(/readwise\.io\/open\/(\d+)/g)) ids.add(Number(match[1]))
  return ids
}

export function isLiveHighlight(highlight: ReadwiseHighlight): boolean {
  return !highlight.is_deleted && !highlight.is_discard
}

/** The remote URL of an image highlight (Reader), or null for a text one. */
export function imageHighlightUrl(highlight: ReadwiseHighlight): string | null {
  return IMAGE_TEXT.exec((highlight.text ?? '').trim())?.[1] ?? null
}

/** Order by location (a missing one last), then id, so equal input renders equal bytes. */
export function sortHighlights(highlights: ReadwiseHighlight[]): ReadwiseHighlight[] {
  return [...highlights].sort((a, b) => {
    const la = a.location ?? Number.POSITIVE_INFINITY
    const lb = b.location ?? Number.POSITIVE_INFINITY
    if (la !== lb) return la < lb ? -1 : 1
    return a.id - b.id
  })
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

function locationLabel(highlight: ReadwiseHighlight): string {
  const { location, location_type: type } = highlight
  if (location === null || location === undefined) return 'Highlight'
  switch (type) {
    case 'page':
      return `Page ${location}`
    case 'location':
      return `Location ${location}`
    case 'time_offset':
      return `Time ${clock(location)}`
    case 'order':
      return `Position ${location}`
    case 'offset':
      return `Offset ${location}`
    default: {
      const name = (type ?? 'location').replace(/_/g, ' ')
      return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${location}`
    }
  }
}

/** A path as the target of a markdown image, wrapped when it holds a space or paren. */
export function imageTarget(path: string): string {
  return /[\s()]/.test(path) ? `<${path}>` : path
}

export interface RenderOptions {
  timeZone: string
  images: SavedImages
}

/**
 * One highlight as markdown lines, or null when it renders nothing: an image
 * that is not saved, or a heading with no text. A heading carries no link, so
 * `planAppend` cannot tell whether it is in the note and never appends one.
 */
export function renderHighlight(
  highlight: ReadwiseHighlight,
  { timeZone, images }: RenderOptions
): string | null {
  const note = collapseWhitespace(highlight.note ?? '')
  const level = headingLevel(highlight)
  if (level !== null) {
    const text = escapeLine(collapseWhitespace(highlight.text ?? ''))
    if (!text) return null
    return `${'#'.repeat(level)} ${text}${note ? `\n\n- ${escapeLine(note)}` : ''}`
  }

  const imageUrl = imageHighlightUrl(highlight)
  let text: string
  if (imageUrl !== null) {
    const saved = images.get(imageUrl)
    if (saved === undefined) return null
    text = `![](${imageTarget(saved)})`
  } else {
    text = escapeLine(collapseWhitespace(highlight.text ?? ''))
  }

  const day = formatDay(highlight.highlighted_at || highlight.created_at, timeZone)
  const link = `[${locationLabel(highlight)}](${highlightUrl(highlight)})`
  const where = `(${link}${day ? `, ${day}` : ''})`
  const tags = inlineTags(highlight.tags)
    .map((tag) => `#${tag}`)
    .join(' ')
  const lines = [`- ${[text, where, tags].filter((part) => part.length > 0).join(' ')}`]
  if (note) lines.push(`  - ${escapeLine(note)}`)
  return lines.join('\n')
}

/**
 * Highlights as the `Highlights` body: list items in a row, a heading set off
 * by blank lines.
 */
export function renderHighlights(
  highlights: ReadwiseHighlight[],
  options: RenderOptions
): { markdown: string; rendered: ReadwiseHighlight[]; missing: ReadwiseHighlight[] } {
  const rendered: ReadwiseHighlight[] = []
  const missing: ReadwiseHighlight[] = []
  const blocks: Array<{ markdown: string; heading: boolean; endsInList: boolean }> = []
  for (const highlight of sortHighlights(highlights.filter(isLiveHighlight))) {
    const markdown = renderHighlight(highlight, options)
    if (markdown === null) {
      if (imageHighlightUrl(highlight) !== null) missing.push(highlight)
      continue
    }
    rendered.push(highlight)
    const heading = headingLevel(highlight) !== null
    blocks.push({ markdown, heading, endsInList: !heading || markdown.includes('\n\n- ') })
  }
  let out = ''
  blocks.forEach((block, index) => {
    if (index > 0) out += block.heading || !blocks[index - 1].endsInList ? '\n\n' : '\n'
    out += block.markdown
  })
  return { markdown: out, rendered, missing }
}

/**
 * The `last` a section records: one millisecond past the newest `created_at`
 * of the highlights it holds, so those highlights fall strictly before it and a
 * deleted one is not a candidate again (D5). Held back to the oldest image
 * still missing, so that highlight comes round again.
 */
export function newestCreatedAt(
  handled: ReadwiseHighlight[],
  missing: ReadwiseHighlight[],
  floor: string
): string {
  const cap = missing
    .map((h) => Date.parse(toIsoInstant(h.created_at) ?? ''))
    .filter((ms) => !Number.isNaN(ms))
    .reduce((min, ms) => Math.min(min, ms), Number.POSITIVE_INFINITY)
  let newest = Number.NaN
  for (const highlight of handled) {
    const ms = Date.parse(toIsoInstant(highlight.created_at) ?? '')
    if (!Number.isNaN(ms) && ms <= cap && (Number.isNaN(newest) || ms > newest)) newest = ms
  }
  const past = Number.isNaN(newest) ? newest : newest < cap ? newest + 1 : newest
  const floorMs = Date.parse(floor)
  const best = Number.isNaN(floorMs) || past > floorMs ? past : floorMs
  return Number.isNaN(best) ? EPOCH : new Date(best).toISOString()
}

export const EPOCH = '1970-01-01T00:00:00.000Z'
