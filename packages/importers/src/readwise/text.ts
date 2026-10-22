import type { ReadwiseHighlight, ReadwiseTag } from './types.ts'

/** The Readwise tags that turn a highlight into a heading (`.h1` to `.h3`). */
const HEADING_TAGS: Record<string, number> = { '.h1': 3, '.h2': 4, '.h3': 5 }

/** Heading level (count of `#`) of a heading highlight, or null. */
export function headingLevel(highlight: ReadwiseHighlight): number | null {
  for (const tag of highlight.tags ?? []) {
    const level = HEADING_TAGS[tag.name.trim().toLowerCase()]
    if (level) return level
  }
  return null
}

/** One line: every whitespace run (newlines included) becomes one space. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Paragraphs kept: LF line endings, no trailing blanks, at most one blank line. */
export function normalizeParagraphs(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Zero-width space: breaks Memry syntax without changing how the text reads. */
const ZWSP = '\u200b'

/**
 * Highlight text is quoted content (D10). Break what Memry would read as its
 * own syntax: a tag, a wiki link, a task, an image, an HTML comment or tag,
 * and a block that starts the line.
 *
 * A zero-width space does the breaking, not a backslash. The editor round
 * trip drops a backslash escape (`\#AI` comes back as `#AI`), which would make
 * the tag real on the first writeback and change the section's bytes. The
 * zero-width space comes back unchanged (D5, golden test).
 */
export function escapeLine(line: string): string {
  return line
    .replace(/(^|\s)#(?=[A-Za-z])/g, `$1#${ZWSP}`)
    .replace(/\[\[/g, `[${ZWSP}[`)
    .replace(/\[(?=[ xX]\])/g, `[${ZWSP}`)
    .replace(/!\[/g, `!${ZWSP}[`)
    .replace(/<(?=[A-Za-z/!?])/g, `<${ZWSP}`)
    .replace(
      /^(\s*)(#{1,6}(?=\s|$)|>|[-+*](?=\s|$)|\d{1,9}[.)](?=\s|$)|`(?=``)|~(?=~~)|=(?==+$)|-(?=-+$))/,
      `$1$2${ZWSP}`
    )
}

export function escapeParagraphs(text: string): string {
  return normalizeParagraphs(text).split('\n').map(escapeLine).join('\n')
}

/**
 * A tag name in the inline `#tag` grammar (`packages/shared/src/inline-tags.ts`):
 * a letter first, then letters, digits, `_` or `-`, with `/`-separated child
 * segments. Anything else folds to `-`, and leading characters that cannot
 * start a tag are dropped. Null when nothing is left.
 */
export function toInlineTag(name: string): string | null {
  const folded = name.normalize('NFD').replace(/\p{M}/gu, '').trim().replace(/^#+/, '')
  const segments = folded
    .split('/')
    .map((segment, index) =>
      segment
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(index === 0 ? /^[^A-Za-z]+/ : /^[^A-Za-z0-9]+/, '')
        .replace(/-+$/, '')
    )
    .filter((segment) => segment.length > 0)
  if (segments.length === 0 || !/^[A-Za-z]/.test(segments[0])) return null
  return segments.join('/')
}

/** Distinct names, case-insensitively, in first-seen order. */
export function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/** Book tags for frontmatter: the Readwise names, trimmed and de-duplicated. */
export function bookTagNames(tags: ReadwiseTag[] | null | undefined): string[] {
  return dedupeNames((tags ?? []).map((tag) => tag.name.trim()).filter((name) => name.length > 0))
}

/** Highlight tags as inline `#tag` text, heading markers left out. */
export function inlineTags(tags: ReadwiseTag[] | null | undefined): string[] {
  const names: string[] = []
  for (const tag of tags ?? []) {
    if (tag.name.trim().toLowerCase() in HEADING_TAGS) continue
    const normalized = toInlineTag(tag.name)
    if (normalized) names.push(normalized)
  }
  return dedupeNames(names)
}

/** `YYYY-MM-DD` of `iso` in `timeZone`, or null for a missing or invalid date. */
export function formatDay(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(ms))
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** An ISO instant with milliseconds, or null for a missing or invalid date. */
export function toIsoInstant(value: string | null | undefined): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}
