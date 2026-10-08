/** Turns markdown bodies into the plain lines the search preview shows. */

const MATCH_RADIUS = 48

function plainLine(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S)/g, '$1$2')
    .replace(/(\S)[*_](\s|$)/g, '$1$2')
    .replace(/<[^>]+>/g, '')
    .trim()
}

/** Body lines with frontmatter, code fences, and markdown syntax removed. */
export function plainLines(markdown: string): string[] {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const lines: string[] = []
  let inFence = false
  for (const raw of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const line = plainLine(raw)
    if (line) lines.push(line)
  }
  return lines
}

const normalized = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** Opening text of a body, skipping a first line that only repeats the title. */
export function excerpt(lines: string[], max = 240, title?: string): string {
  const body =
    title && lines.length > 0 && normalized(lines[0]) === normalized(title) ? lines.slice(1) : lines
  const text = body.join(' ')
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text
}

function queryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Lines that contain a query term, each trimmed to a window around the first hit. */
export function matchLines(
  lines: string[],
  query: string,
  max = 3
): { lines: string[]; total: number } {
  const terms = queryTerms(query)
  if (terms.length === 0) return { lines: [], total: 0 }
  const hits: string[] = []
  let total = 0
  for (const line of lines) {
    const lower = line.toLowerCase()
    const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0))
    if (!Number.isFinite(at)) continue
    total += 1
    if (hits.length >= max) continue
    const start = Math.max(0, at - MATCH_RADIUS)
    const end = Math.min(line.length, at + MATCH_RADIUS * 2)
    hits.push(`${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`)
  }
  return { lines: hits, total }
}
